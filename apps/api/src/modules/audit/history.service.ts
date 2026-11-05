// SPDX-License-Identifier: AGPL-3.0-only
// History panels, the club-wide changes and the audit log (P1.9, ADR 0042).
//
// Reads go to the history database: its own small pool with a statement
// timeout (HISTORY_POOL_MAX, HISTORY_STATEMENT_TIMEOUT_MS), read-only, and
// optionally a replica (HISTORY_DATABASE_URL), so a burst of history reads
// never takes connections from the everyday paths. One read-only
// transaction per request reads the page, the current rows behind it and
// the names of what it mentions; people are named afterwards through
// PeopleService and the PersonPresenter (sequential, never nested).
//
// Values follow the history view policy (history-columns.ts) and field
// visibility on the current record; redacted and erased values never show.

import {
  type AuditEventRow,
  type Database,
  decodeHistoryCursor,
  encodeHistoryCursor,
  type HistoryPosition,
  type HistoryRecordRef,
  InvalidHistoryCursorError,
  readAuditEvents,
  readClubHistory,
  readGlobalHistory,
  readRecordsHistory,
  type RecordChange,
  type Tx,
} from "@clubadmin/db";
import {
  type ActorReference,
  AUDIT_RANGE_MAX_DAYS,
  auditActionsOf,
  type AuditCategory,
  auditCategoryOf,
  type AuditEventsQuery,
  type AuditItem,
  type AuditPage,
  type ClubHistoryQuery,
  HISTORY_FILTER_MAX_DAYS,
  HISTORY_SCOPE_MAX,
  type HistoryChange,
  type HistoryItem,
  type HistoryPage,
  type HistoryRecordKind,
  type HistoryRef,
  type HistoryScalar,
  type HistoryValue,
  isHistoryResource,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import type { PersonPresenter } from "../authorization/index.ts";
import {
  type ActivityResource,
  permits,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import type { PeopleService } from "../people/index.ts";
import * as repo from "./history.repository.ts";
import {
  type ColumnRule,
  FIELD_LABELS,
  HISTORY_POLICY,
  policyOfResource,
  policyOfTable,
  ruleOf,
  type TablePolicy,
  type ValueFormat,
} from "./history-columns.ts";

export interface HistoryOptions {
  historyRetentionMonths: number;
  auditRetentionMonths: number;
}

/** What a panel's reader knows about the record (from the checked resource). */
export interface PanelContext {
  kind: repo.PanelKind;
  clubId: string;
  id: string;
  /** The person's shared fields in the club (person panel). */
  sharedFields?: readonly string[];
  /** The person is protected (person panel): the read is access-logged. */
  protectedPerson?: boolean;
  /** The activity (activity panel): notes on answers follow activity.responses.read. */
  activity?: ActivityResource;
}

type NameKind = Exclude<HistoryRecordKind, "person">;

const DAY_MS = 86_400_000;
const ERASED = "[erased]";
const REDACTED = "[changed]";

/** Tables the club-wide view lists (club rows with a policy). */
const CLUB_TABLES = HISTORY_POLICY.filter((p) => !p.global).map((p) => p.table);

const OPERATIONS = { INSERT: "created", UPDATE: "updated", DELETE: "deleted" } as const;

function cursorOf(cursor: string | undefined): HistoryPosition | null {
  if (!cursor) return null;
  try {
    return decodeHistoryCursor(cursor);
  } catch (error) {
    if (error instanceof InvalidHistoryCursorError) throw new DomainError("invalid_cursor");
    throw error;
  }
}

function rangeOf(
  from: string | undefined,
  to: string | undefined,
  maxDays: number,
  required: boolean,
): { from?: Date; to?: Date } {
  if (!from && !to) {
    if (required) throw new DomainError("range_too_large");
    return {};
  }
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - maxDays * DAY_MS);
  if (end.getTime() < start.getTime()) throw new DomainError("invalid_input");
  if (end.getTime() - start.getTime() > maxDays * DAY_MS) throw new DomainError("range_too_large");
  return { from: start, to: end };
}

/** A statement timeout of the history pool becomes history_timeout ("Narrow the period"). */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error as { code?: unknown }).code === "57014") throw new DomainError("history_timeout");
    throw error;
  }
}

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const byNewest = (a: RecordChange, b: RecordChange) =>
  b.changedAt.getTime() - a.changedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** IDs the page mentions, collected while formatting, resolved in bulk. */
class Mentions {
  readonly people = new Set<string>();
  readonly records = new Map<NameKind, Set<string>>();

  person(id: string) {
    this.people.add(id);
  }

  record(kind: NameKind, id: string) {
    const set = this.records.get(kind) ?? new Set<string>();
    set.add(id);
    this.records.set(kind, set);
  }
}

/** Resolved names: people through the presenter, records by name. */
interface Resolved {
  people: Map<string, HistoryRef>;
  actors: Map<string, ActorReference>;
  records: Map<string, repo.RecordName>;
}

type Pending = { kind: "person"; id: string } | { kind: "record"; type: NameKind; id: string };

export class HistoryService {
  private readonly db: Database;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;
  private readonly options: HistoryOptions;

  constructor(
    historyDb: Database,
    people: PeopleService,
    presenter: PersonPresenter,
    options: HistoryOptions,
  ) {
    this.db = historyDb;
    this.people = people;
    this.presenter = presenter;
    this.options = options;
  }

  /** A detail page's history panel. */
  async panel(
    authz: RequestAuthorization,
    panel: PanelContext,
    query: { cursor?: string | undefined; limit: number },
  ): Promise<HistoryPage> {
    const before = cursorOf(query.cursor);
    const read = await guarded(() =>
      this.db.withTenant(
        tenantContext(authz, panel.clubId, { viewerPrivileged: true }),
        async (tx) => {
          const scope = await repo.panelScope(tx, panel.kind, panel.clubId, panel.id);
          if (scope.length > HISTORY_SCOPE_MAX) throw new DomainError("history_scope_too_large");
          const club = scope.filter((r) => !policyOfTable(r.table)?.global);
          const global = scope.filter((r) => policyOfTable(r.table)?.global);
          const options = { before, limit: query.limit + 1 };
          const rows = [
            ...(await readRecordsHistory(tx, club, options)),
            ...(await readGlobalHistory(tx, global, options)),
          ]
            .sort(byNewest)
            .slice(0, query.limit + 1);
          return this.readContext(tx, rows, query.limit);
        },
      ),
    );
    const page = await this.present(authz, panel.clubId, read, {
      sharedFields: new Set(panel.sharedFields ?? []),
      leaderNotes:
        authz.actor.isClubManager(panel.clubId) ||
        (panel.activity !== undefined &&
          permits(authz.actor, "activity.responses.read", panel.activity)),
    });
    if (panel.kind === "person" && panel.protectedPerson) {
      // Until P1.12 (profile_views): reading a protected person's history is
      // logged like a profile view, on the primary database (ADR 0042).
      await this.people.recordProtectedView(tenantContext(authz, panel.clubId), panel.id, [
        "history",
      ]);
    }
    return page;
  }

  /** The club's changes, newest first; filters by kind of record or actor need a period. */
  async clubHistory(
    authz: RequestAuthorization,
    clubId: string,
    query: ClubHistoryQuery,
  ): Promise<HistoryPage> {
    const before = cursorOf(query.cursor);
    const filtered = query.table !== undefined || query.actorId !== undefined;
    const range = rangeOf(query.from, query.to, HISTORY_FILTER_MAX_DAYS, filtered);
    const policy = query.table ? policyOfResource(query.table) : undefined;
    if (query.table && (!policy || policy.global)) throw new DomainError("invalid_input");
    const read = await guarded(() =>
      this.db.withTenant(tenantContext(authz, clubId, { viewerPrivileged: true }), async (tx) => {
        const rows = await readClubHistory(
          tx,
          clubId,
          {
            tables: policy ? [policy.table] : CLUB_TABLES,
            ...(query.actorId ? { actorPersonId: query.actorId } : {}),
            ...range,
          },
          { before, limit: query.limit + 1 },
        );
        return this.readContext(tx, rows, query.limit);
      }),
    );
    return this.present(authz, clubId, read, {
      sharedFields: new Set(),
      leaderNotes: authz.actor.isClubManager(clubId),
    });
  }

  /** The club's audit log (action names and field names only, never values or IP hashes). */
  async auditEvents(
    authz: RequestAuthorization,
    clubId: string,
    query: AuditEventsQuery,
  ): Promise<AuditPage> {
    const before = cursorOf(query.cursor);
    const range = rangeOf(query.from, query.to, AUDIT_RANGE_MAX_DAYS, false);
    const actions = query.action
      ? [query.action]
      : query.category
        ? auditActionsOf(query.category)
        : undefined;
    const { events, context, names } = await guarded(() =>
      this.db.withTenant(tenantContext(authz, clubId, { viewerPrivileged: true }), async (tx) => {
        const read = await readAuditEvents(
          tx,
          clubId,
          {
            ...(actions ? { actions } : {}),
            ...(query.actorId ? { actorPersonId: query.actorId } : {}),
            ...(query.resourceType ? { resourceType: query.resourceType } : {}),
            ...(query.resourceId ? { resourceId: query.resourceId } : {}),
            ...range,
          },
          { before, limit: query.limit + 1 },
        );
        const events = read.slice(0, query.limit);
        const records = events.flatMap((e): HistoryRecordRef[] => {
          const policy = isHistoryResource(e.resourceType)
            ? policyOfResource(e.resourceType)
            : undefined;
          return policy && !policy.global && e.resourceId
            ? [{ table: policy.table, id: e.resourceId }]
            : [];
        });
        const context = await repo.currentContext(tx, records);
        const mentions = new Mentions();
        for (const e of events) {
          const target = this.auditTarget(e, context, clubId);
          if (target?.kind === "person") mentions.person(target.id);
          else if (target) mentions.record(target.type, target.id);
        }
        const names = await repo.recordNames(tx, mentions.records);
        return {
          events: { items: events, more: read.length > query.limit },
          context,
          names: { mentions, names },
        };
      }),
    );
    const actorIds = events.items.flatMap((e) =>
      [e.actorPersonId, e.onBehalfOfPersonId].filter((id): id is string => id !== null),
    );
    const resolved = await this.resolve(authz, clubId, names.mentions, actorIds, names.names);
    const items = events.items.map((e): AuditItem => {
      const target = this.auditTarget(e, context, clubId);
      const policy = isHistoryResource(e.resourceType)
        ? policyOfResource(e.resourceType)
        : undefined;
      return {
        id: e.id,
        createdAt: e.createdAt.toISOString(),
        action: e.action,
        category: auditCategoryOf(e.action) satisfies AuditCategory,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        link: this.auditLink(e, policy, context, clubId),
        about: target ? this.refOf(target, resolved) : null,
        actor: this.actorOf(e.actorKind, e.actorPersonId, e.requestId, resolved),
        onBehalfOf: e.onBehalfOfPersonId
          ? this.actorOf("person", e.onBehalfOfPersonId, null, resolved)
          : null,
        changedFields: e.changedFields.map((name) => ({
          name,
          labelKey: FIELD_LABELS.get(name) ?? null,
        })),
      };
    });
    const last = events.items.at(-1);
    return {
      items,
      nextCursor: events.more && last ? encodeHistoryCursor(last.createdAt, last.id) : null,
      retentionMonths: this.options.auditRetentionMonths,
    };
  }

  // --- reading --------------------------------------------------------------

  /** The page (limit rows), the current rows behind it and the record names it mentions. */
  private async readContext(tx: Tx, rows: RecordChange[], limit: number) {
    const page = rows.slice(0, limit);
    const context = await repo.currentContext(
      tx,
      page
        .filter((r) => !policyOfTable(r.tableName)?.global)
        .map((r) => ({ table: r.tableName, id: r.recordId })),
    );
    const mentions = new Mentions();
    for (const row of page) this.collect(row, context, mentions);
    const names = await repo.recordNames(tx, mentions.records);
    return { page, more: rows.length > limit, context, mentions, names };
  }

  /** The row's about and link values: the current row, else the change's own values. */
  private contextOf(
    row: RecordChange,
    context: ReadonlyMap<string, Record<string, string | null>>,
  ): (column: string) => string | null {
    const current = context.get(row.recordId);
    const values = { ...(row.oldValues ?? {}), ...(row.newValues ?? {}) };
    return (column) => {
      if (column === "id") return row.recordId;
      if (column === "club_id") return row.clubId;
      const v = current?.[column] ?? values[column];
      return isUuid(v) ? v : null;
    };
  }

  private collect(
    row: RecordChange,
    context: ReadonlyMap<string, Record<string, string | null>>,
    mentions: Mentions,
  ) {
    const policy = policyOfTable(row.tableName);
    if (!policy) return;
    const valueOf = this.contextOf(row, context);
    for (const a of policy.about) {
      const id = valueOf(a.column);
      if (!id) continue;
      if (a.kind === "person") mentions.person(id);
      else mentions.record(a.kind, id);
    }
    for (const values of [row.oldValues, row.newValues]) {
      for (const [column, v] of Object.entries(values ?? {})) {
        const rule = ruleOf(policy, column);
        if (typeof rule !== "object" || !isUuid(v)) continue;
        if (rule.kind === "person") mentions.person(v);
        else if (rule.kind === "ref" && rule.ref !== "person") mentions.record(rule.ref, v);
      }
    }
    if (row.actorPersonId) mentions.person(row.actorPersonId);
    if (row.onBehalfOfPersonId) mentions.person(row.onBehalfOfPersonId);
  }

  // --- presenting -----------------------------------------------------------

  /** People named on the page, in one call each to PeopleService and the presenter. */
  private async resolve(
    authz: RequestAuthorization,
    clubId: string,
    mentions: Mentions,
    actorIds: readonly string[],
    records: Map<string, repo.RecordName>,
  ): Promise<Resolved> {
    const ids = [...new Set([...mentions.people, ...actorIds])];
    const rows = await this.people.historyPeople(ids);
    const erased = new Set(rows.filter((r) => r.erased).map((r) => r.id));
    const shown = new Map(
      (
        await this.presenter.present(
          authz,
          clubId,
          rows.filter((r) => !r.erased),
        )
      ).map((s) => [s.id, s]),
    );
    const people = new Map<string, HistoryRef>();
    const actors = new Map<string, ActorReference>();
    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      const summary = shown.get(id);
      if (summary) {
        people.set(id, { kind: "person", person: summary });
        actors.set(id, { kind: "person", person: summary });
      } else if (erased.has(id) || !found.has(id)) {
        people.set(id, { kind: "erased_person" });
        actors.set(id, { kind: "erased" });
      } else {
        people.set(id, { kind: "hidden_person" });
        actors.set(id, { kind: "protected" });
      }
    }
    return { people, actors, records };
  }

  private async present(
    authz: RequestAuthorization,
    clubId: string,
    read: Awaited<ReturnType<HistoryService["readContext"]>>,
    view: { sharedFields: ReadonlySet<string>; leaderNotes: boolean },
  ): Promise<HistoryPage> {
    const resolved = await this.resolve(authz, clubId, read.mentions, [], read.names);
    const items = read.page.flatMap((row) => {
      const item = this.item(row, read.context, resolved, view);
      return item ? [item] : [];
    });
    const last = read.page.at(-1);
    return {
      items,
      nextCursor: read.more && last ? encodeHistoryCursor(last.changedAt, last.id) : null,
      retentionMonths: this.options.historyRetentionMonths,
    };
  }

  private item(
    row: RecordChange,
    context: ReadonlyMap<string, Record<string, string | null>>,
    resolved: Resolved,
    view: { sharedFields: ReadonlySet<string>; leaderNotes: boolean },
  ): HistoryItem | null {
    const policy = policyOfTable(row.tableName);
    if (!policy) return null;
    const valueOf = this.contextOf(row, context);
    const about: HistoryRef[] = [];
    for (const a of policy.about) {
      const id = valueOf(a.column);
      if (!id) continue;
      const ref = this.refOf(
        a.kind === "person" ? { kind: "person", id } : { kind: "record", type: a.kind, id },
        resolved,
      );
      // Rows about a person the viewer may not see are left out entirely.
      if (ref.kind === "hidden_person") return null;
      about.push(ref);
    }
    const linkId = policy.link ? valueOf(policy.link.column) : null;
    const { changes, other } = this.changesOf(row, policy, resolved, view);
    return {
      id: row.id,
      changedAt: row.changedAt.toISOString(),
      operation: OPERATIONS[row.operation],
      resource: policy.resource,
      recordId: row.recordId,
      link: policy.link && linkId ? { kind: policy.link.kind, id: linkId } : null,
      about,
      actor: this.actorOf(row.actorKind, row.actorPersonId, row.requestId, resolved),
      onBehalfOf: row.onBehalfOfPersonId
        ? this.actorOf("person", row.onBehalfOfPersonId, null, resolved)
        : null,
      changes,
      otherFieldsChanged: other,
      transactionId: String(row.transactionId),
    };
  }

  private changesOf(
    row: RecordChange,
    policy: TablePolicy,
    resolved: Resolved,
    view: { sharedFields: ReadonlySet<string>; leaderNotes: boolean },
  ): { changes: HistoryChange[]; other: boolean } {
    const columns =
      row.operation === "UPDATE"
        ? row.changedColumns
        : Object.keys((row.operation === "INSERT" ? row.newValues : row.oldValues) ?? {});
    const changes: HistoryChange[] = [];
    let other = false;
    for (const column of columns) {
      let rule: ColumnRule = ruleOf(policy, column);
      if (
        typeof rule === "object" &&
        rule.kind === "shared" &&
        !view.sharedFields.has(rule.field)
      ) {
        // Not shared with the club: left out entirely, not even "changed".
        continue;
      }
      if (typeof rule === "object" && rule.kind === "leader_notes" && !view.leaderNotes) {
        rule = "name_only";
      }
      if (rule === "hidden") continue;
      const oldRaw = row.oldValues?.[column] ?? null;
      const newRaw = row.newValues?.[column] ?? null;
      if (row.operation !== "UPDATE" && (oldRaw ?? newRaw) === null) continue;
      if (rule === "name_only") {
        if (row.operation === "UPDATE") other = true;
        continue;
      }
      const label = rule.label;
      if (oldRaw === ERASED || newRaw === ERASED) {
        changes.push({ column, labelKey: label, kind: "erased", old: null, new: null });
        continue;
      }
      if (oldRaw === REDACTED || newRaw === REDACTED) {
        changes.push({ column, labelKey: label, kind: "redacted", old: null, new: null });
        continue;
      }
      const format = (v: unknown) => this.valueOf(rule, v, resolved);
      const oldValue = format(oldRaw);
      const newValue = format(newRaw);
      if (oldValue === undefined || newValue === undefined) {
        // A value the policy cannot format (a JSON object): named only.
        if (row.operation === "UPDATE") other = true;
        continue;
      }
      changes.push({ column, labelKey: label, kind: "value", old: oldValue, new: newValue });
    }
    return { changes, other };
  }

  /** A raw value as the rule formats it; null for no value, undefined if it cannot be shown. */
  private valueOf(
    rule: Exclude<ColumnRule, "hidden" | "name_only">,
    raw: unknown,
    resolved: Resolved,
  ): HistoryValue | null | undefined {
    if (raw === null || raw === undefined) return null;
    if (rule.kind === "person") {
      return isUuid(raw)
        ? { type: "ref", ref: this.refOf({ kind: "person", id: raw }, resolved) }
        : undefined;
    }
    if (rule.kind === "ref") {
      if (!isUuid(raw)) return undefined;
      return {
        type: "ref",
        ref: this.refOf(
          rule.ref === "person"
            ? { kind: "person", id: raw }
            : { kind: "record", type: rule.ref, id: raw },
          resolved,
        ),
      };
    }
    const format: ValueFormat = rule.kind === "leader_notes" ? "text" : rule.format;
    if (typeof format === "object" && "list" in format) {
      if (!Array.isArray(raw)) return undefined;
      const items = raw.map((v) => scalarOf(format.list, v));
      return items.every((i): i is HistoryScalar => i !== undefined)
        ? { type: "list", items }
        : undefined;
    }
    return scalarOf(format, raw);
  }

  private refOf(target: Pending, resolved: Resolved): HistoryRef {
    if (target.kind === "person") {
      return resolved.people.get(target.id) ?? { kind: "erased_person" };
    }
    const name = resolved.records.get(`${target.type}:${target.id}`);
    return {
      kind: "record",
      type: target.type,
      id: target.id,
      name: name?.name ?? null,
      ...(name?.startsAt ? { startsAt: name.startsAt } : {}),
    };
  }

  private actorOf(
    actorKind: string,
    personId: string | null,
    requestId: string | null,
    resolved: Resolved,
  ): ActorReference {
    if (actorKind === "operator") return { kind: "operator" };
    if (actorKind === "person" && personId) {
      return resolved.actors.get(personId) ?? { kind: "erased" };
    }
    if (actorKind === "system_job" && requestId) {
      return { kind: "system", job: requestId.startsWith("job:") ? requestId.slice(4) : requestId };
    }
    return { kind: "system" };
  }

  /** What an audit event is about: its person, or its record's named subject. */
  private auditTarget(
    e: AuditEventRow,
    context: ReadonlyMap<string, Record<string, string | null>>,
    clubId: string,
  ): Pending | null {
    if (!e.resourceId) return null;
    if (e.resourceType === "person") return { kind: "person", id: e.resourceId };
    const policy = isHistoryResource(e.resourceType) ? policyOfResource(e.resourceType) : undefined;
    if (!policy || policy.global) return null;
    const current = context.get(e.resourceId);
    for (const a of policy.about) {
      const id = a.column === "id" ? e.resourceId : (current?.[a.column] ?? null);
      if (!isUuid(id)) continue;
      return a.kind === "person" ? { kind: "person", id } : { kind: "record", type: a.kind, id };
    }
    return policy.resource === "club" ? { kind: "record", type: "club", id: clubId } : null;
  }

  private auditLink(
    e: AuditEventRow,
    policy: TablePolicy | undefined,
    context: ReadonlyMap<string, Record<string, string | null>>,
    clubId: string,
  ): AuditItem["link"] {
    if (!e.resourceId) return null;
    if (e.resourceType === "person") return { kind: "person", id: e.resourceId };
    if (!policy?.link || policy.global) return null;
    const { column, kind } = policy.link;
    const id =
      column === "id"
        ? e.resourceId
        : column === "club_id"
          ? clubId
          : (context.get(e.resourceId)?.[column] ?? null);
    return isUuid(id) ? { kind, id } : null;
  }
}

function scalarOf(
  format: Exclude<ValueFormat, { list: unknown }>,
  raw: unknown,
): HistoryScalar | undefined {
  if (typeof format === "object") {
    return typeof raw === "string" ? { type: "enum", enumKey: format.enum, value: raw } : undefined;
  }
  switch (format) {
    case "text":
      return typeof raw === "string" || typeof raw === "number"
        ? { type: "text", value: String(raw) }
        : undefined;
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      return Number.isFinite(n) ? { type: "number", value: n } : undefined;
    }
    case "boolean":
      return typeof raw === "boolean" ? { type: "boolean", value: raw } : undefined;
    case "date":
      return typeof raw === "string" ? { type: "date", value: raw.slice(0, 10) } : undefined;
    case "datetime": {
      if (typeof raw !== "string") return undefined;
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? undefined : { type: "datetime", value: d.toISOString() };
    }
  }
}
