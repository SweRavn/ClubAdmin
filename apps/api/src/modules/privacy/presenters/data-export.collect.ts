// SPDX-License-Identifier: AGPL-3.0-only
// What "download my data" contains (P1.8b, docs/api/data-export.md): the
// subject's own rows, platform-wide and per club, read by the system in
// one transaction per part (a job, not a request). Other people appear
// only as IDs, named in `people` through the PersonPresenter as the
// requester may see them (ADR 0022). Left out: club notes, other people's
// contact details, invitation addresses, token hashes, the identity
// provider's subject, IP hashes. Sealed event answers are decrypted only
// into this file.

import { type Database, type SQL, sql, type Tx } from "@clubadmin/db";
import type { Locale } from "@clubadmin/i18n";
import { type ConsentPurpose, DATA_EXPORT_SCHEMA_VERSION } from "@clubadmin/shared";

import type { PersonPresenter, RequestAuthorization } from "../../authorization/index.ts";
import type { EventsService } from "../../events/index.ts";
import type { PeopleService } from "../../people/index.ts";
import { renderDefaultText } from "../privacy-texts.ts";

/** A uuid[] parameter (IDs only, validated where they enter). */
const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

const JOB = "privacy:export";

export type ExportRow = Record<string, unknown>;

export interface ExportSection {
  /** Stable key (docs/api/data-export.md, message keys dataExport.sections.<key>). */
  key: string;
  rows: ExportRow[];
}

export interface PlatformPart {
  kind: "platform";
  sections: ExportSection[];
}

export interface ClubPart {
  kind: "club";
  clubId: string;
  clubName: string;
  sections: ExportSection[];
}

export interface ExportHeader {
  schemaVersion: number;
  generatedAt: string;
  locale: Locale;
  subjectPersonId: string;
  requestedByPersonId: string;
}

export interface CollectDeps {
  db: Database;
  /** History of global rows (people, accounts) is readable only by the retention role. */
  retentionDb: Database | null;
  people: PeopleService;
  events: EventsService;
  presenter: PersonPresenter;
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function camelRow(row: Record<string, unknown>): ExportRow {
  const out: ExportRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[camel(key)] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

async function rows(tx: Tx, query: SQL): Promise<ExportRow[]> {
  const result = await tx.execute<Record<string, unknown>>(query);
  return result.rows.map(camelRow);
}

/** Keys removed from history values: secrets, hashes, other people's notes and addresses. */
const HISTORY_SCRUB = new Set([
  "personal_identity_number",
  "personal_identity_number_hash",
  "idp_subject",
  "token_hash",
  "token_sealed",
  "session_handle",
  "notes",
  "owner_note",
  "club_note",
  "leader_notes",
  "sensitive_answers",
  "email",
]);

function scrub(values: unknown): unknown {
  if (!values || typeof values !== "object") return values;
  return Object.fromEntries(
    Object.entries(values as Record<string, unknown>)
      .filter(([key]) => !HISTORY_SCRUB.has(key))
      .map(([key, value]) => [camel(key), value]),
  );
}

const historyColumns = sql`
  changed_at, table_name, operation, changed_columns, old_values, new_values,
  actor_person_id, actor_kind`;

function historyRows(list: ExportRow[]): ExportRow[] {
  return list.map((r) => ({
    ...r,
    oldValues: scrub(r.oldValues),
    newValues: scrub(r.newValues),
    changedColumns: Array.isArray(r.changedColumns)
      ? (r.changedColumns as string[]).filter((c) => !HISTORY_SCRUB.has(c)).map(camel)
      : r.changedColumns,
  }));
}

/** Person IDs mentioned in rows (columns ending in PersonId, PersonIds or WardIds). */
export function personIdsIn(sections: readonly ExportSection[]): string[] {
  const ids = new Set<string>();
  const visit = (key: string, value: unknown) => {
    if (/PersonIds?$|WardIds$/.test(key)) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (typeof v === "string") ids.add(v);
      }
    }
  };
  for (const section of sections) {
    for (const row of section.rows) {
      for (const [key, value] of Object.entries(row)) visit(key, value);
    }
  }
  return [...ids];
}

/** The clubs the subject has or had a relationship with. */
async function clubsOf(deps: CollectDeps, authz: RequestAuthorization, subjectId: string) {
  const system = await deps.db.withSystem(JOB, {}, (tx) =>
    tx.execute<{ club_id: string }>(sql`
      SELECT club_id FROM public.club_memberships WHERE person_id = ${subjectId}
      UNION SELECT club_id FROM public.event_registrations WHERE person_id = ${subjectId}`),
  );
  // Join requests and waiting lists are visible to the person and their guardians.
  const own = await deps.db.withActor(authz.context, (tx) =>
    tx.execute<{ club_id: string }>(sql`
      SELECT club_id FROM public.join_requests WHERE person_id = ${subjectId}`),
  );
  return [...new Set([...system.rows, ...own.rows].map((r) => r.club_id))].sort();
}

/** The platform's part: the person, the account, guardianships, notices, requests. */
async function platformPart(
  deps: CollectDeps,
  subjectId: string,
): Promise<{ part: PlatformPart; accountId: string | null }> {
  return deps.db.withSystem(JOB, {}, async (tx) => {
    const person = await rows(
      tx,
      sql`
        SELECT id, given_name, family_name, birth_date::text, gender, protected_identity,
          phone, address, deceased_at, created_at, updated_at
        FROM public.people WHERE id = ${subjectId}`,
    );
    const pin = await deps.people.personalIdentityNumberInTx(tx, subjectId);
    if (person[0] && pin) person[0].personalIdentityNumber = pin;
    const account = await rows(
      tx,
      sql`
        SELECT id, email, email_verified_at, locale, time_zone, theme, notification_settings,
          created_at FROM public.accounts WHERE person_id = ${subjectId}`,
    );
    const accountId = (account[0]?.id as string | undefined) ?? null;
    const sections: ExportSection[] = [
      { key: "person", rows: person },
      { key: "account", rows: account },
      {
        key: "pushDevices",
        rows: await rows(
          tx,
          sql`
            SELECT d.provider, d.platform, d.app_variant, d.last_seen_at, d.disabled_at,
              d.created_at
            FROM public.push_devices d JOIN public.accounts a ON a.id = d.account_id
            WHERE a.person_id = ${subjectId} ORDER BY d.created_at`,
        ),
      },
      // Calendar subscriptions (P1.11): never the secret or its hash.
      {
        key: "calendarFeeds",
        rows: await rows(
          tx,
          sql`
            SELECT f.id, f.scope, f.club_id, f.group_id, f.person_ids, f.label,
              f.last_fetched_at, f.access_lost_at, f.revoked_at, f.revoked_reason, f.created_at
            FROM public.calendar_feeds f
            WHERE f.person_id = ${subjectId} ORDER BY f.created_at`,
        ),
      },
      {
        key: "guardianships",
        rows: await rows(
          tx,
          sql`
            SELECT id, guardian_person_id, ward_person_id, kind, rights, status, valid_from,
              valid_to, adult_decision, adult_decided_at, created_at
            FROM public.guardianships
            WHERE guardian_person_id = ${subjectId} OR ward_person_id = ${subjectId}
            ORDER BY valid_from`,
        ),
      },
      {
        key: "guardianInvitations",
        rows: await rows(
          tx,
          sql`
            SELECT id, ward_person_id, kind, rights, created_at, expires_at, accepted_at,
              revoked_at
            FROM public.guardian_invitations WHERE invited_by_person_id = ${subjectId}
            ORDER BY created_at`,
        ),
      },
      {
        key: "notifications",
        rows: await rows(
          tx,
          sql`
            SELECT id, club_id, category, type, subject_type, subject_id, about_person_ids,
              params, read_at, created_at
            FROM public.notifications
            WHERE recipient_person_id = ${subjectId} AND created_at > now() - interval '90 days'
            ORDER BY created_at`,
        ),
      },
      {
        key: "dataExports",
        rows: await rows(
          tx,
          sql`
            SELECT id, subject_person_id, requested_by_person_id, status, size_bytes::float8,
              locale, ready_at, expires_at, created_at
            FROM public.data_exports
            WHERE subject_person_id = ${subjectId} OR requested_by_person_id = ${subjectId}
            ORDER BY created_at`,
        ),
      },
      {
        key: "erasureRequests",
        rows: await rows(
          tx,
          sql`
            SELECT id, person_id, requested_by_person_id, kind, status, scheduled_for,
              include_ward_ids, cancelled_at, done_at, created_at
            FROM public.erasure_requests
            WHERE person_id = ${subjectId} OR requested_by_person_id = ${subjectId}
              OR include_ward_ids @> ARRAY[${subjectId}::uuid]
            ORDER BY created_at`,
        ),
      },
    ];
    return { part: { kind: "platform", sections }, accountId };
  });
}

/** The record history of the person row and the account (the retention role reads it). */
async function platformHistory(
  deps: CollectDeps,
  subjectId: string,
  accountId: string | null,
): Promise<ExportSection> {
  if (!deps.retentionDb) return { key: "history", rows: [] };
  const list = await deps.retentionDb.withSystem(JOB, {}, (tx) =>
    rows(
      tx,
      sql`
        SELECT ${historyColumns} FROM history.record_changes
        WHERE (table_name = 'public.people' AND record_id = ${subjectId})
           OR (table_name = 'public.accounts' AND record_id = ${accountId}::uuid)
        ORDER BY changed_at`,
    ),
  );
  return { key: "history", rows: historyRows(list) };
}

function consentText(
  locale: Locale,
  row: ExportRow,
  clubName: string,
  clubDefaultLocale: string,
): string | null {
  const version = typeof row.textVersion === "string" ? row.textVersion : "";
  const [source, number] = version.split(":");
  if (source === "default") {
    return renderDefaultText(locale, row.purpose as ConsentPurpose, Number(number), clubName);
  }
  const texts = row.clubTexts as Record<string, string> | null;
  if (!texts) return null;
  return texts[locale] ?? texts[clubDefaultLocale.slice(0, 2)] ?? Object.values(texts)[0] ?? null;
}

/** One club's part: profile, memberships, groups, roles, consents, answers, attendance, events. */
async function clubPart(
  deps: CollectDeps,
  locale: Locale,
  clubId: string,
  subjectId: string,
): Promise<ClubPart> {
  return deps.db.withSystem(JOB, { clubId }, async (tx) => {
    const { rows: club } = await tx.execute<{ name: string; default_locale: string }>(
      sql`SELECT name, default_locale FROM public.clubs WHERE id = ${clubId}`,
    );
    const clubName = club[0]?.name ?? "";
    const of = (query: SQL) => rows(tx, query);
    const consents = await of(sql`
      SELECT c.id, c.purpose, c.text_version, c.source, c.given_by_person_id, c.given_at,
        c.revoked_at, c.revoked_by_person_id, c.revoked_reason, ct.texts AS club_texts
      FROM public.consents c
      LEFT JOIN public.consent_texts ct ON ct.club_id = c.club_id AND ct.purpose = c.purpose
        AND 'club:' || ct.version = c.text_version
      WHERE c.club_id = ${clubId} AND c.person_id = ${subjectId} ORDER BY c.given_at`);
    for (const c of consents) {
      c.text = consentText(locale, c, clubName, club[0]?.default_locale ?? "sv");
      delete c.clubTexts;
    }
    const registrations = await of(sql`
      SELECT r.id, r.event_id, e.title AS event_title, e.starts_at AS event_starts_at, r.status,
        r.answers, r.sensitive_answers, r.registered_by_person_id, r.queued_at, r.decided_at,
        r.created_at
      FROM public.event_registrations r JOIN public.events e ON e.id = r.event_id
      WHERE r.club_id = ${clubId} AND r.person_id = ${subjectId} ORDER BY r.created_at`);
    for (const r of registrations) {
      r.sensitiveAnswers =
        typeof r.sensitiveAnswers === "string"
          ? await deps.events.unsealAnswersInTx(tx, r.id as string, r.sensitiveAnswers)
          : null;
    }
    const sections: ExportSection[] = [
      {
        key: "clubProfile",
        rows: await of(sql`
          SELECT id, member_number, shared_fields, emergency_contacts, protected_identity_club,
            created_at FROM public.club_profiles
          WHERE club_id = ${clubId} AND person_id = ${subjectId}`),
      },
      {
        key: "memberships",
        rows: await of(sql`
          SELECT id, status, membership_type, valid_from, valid_to FROM public.club_memberships
          WHERE club_id = ${clubId} AND person_id = ${subjectId} ORDER BY valid_from`),
      },
      {
        key: "groupMemberships",
        rows: await of(sql`
          SELECT gm.id, gm.group_id, g.name AS group_name, gm.function, gm.valid_from,
            gm.valid_to
          FROM public.group_memberships gm JOIN public.groups g ON g.id = gm.group_id
          WHERE gm.club_id = ${clubId} AND gm.person_id = ${subjectId} ORDER BY gm.valid_from`),
      },
      {
        key: "roles",
        rows: await of(sql`
          SELECT id, role, assigned_by_person_id, valid_from, valid_to
          FROM public.club_role_assignments
          WHERE club_id = ${clubId} AND person_id = ${subjectId} ORDER BY valid_from`),
      },
      {
        key: "employments",
        rows: await of(sql`
          SELECT id, title, employment_type, starts_on::text, ends_on::text, hours_per_week
          FROM public.employments
          WHERE club_id = ${clubId} AND person_id = ${subjectId} ORDER BY starts_on`),
      },
      { key: "consents", rows: consents },
      {
        key: "joinRequests",
        rows: await of(sql`
          SELECT id, status, message, decision_message, preferred_group_ids,
            requested_by_person_id, decided_at, created_at
          FROM public.join_requests
          WHERE club_id = ${clubId} AND person_id = ${subjectId} ORDER BY created_at`),
      },
      {
        key: "waitingLists",
        rows: await of(sql`
          SELECT w.id, w.group_id, g.name AS group_name, w.status, w.queued_at, w.applicant_note,
            w.requested_by_person_id, w.decided_at, w.created_at
          FROM public.group_waitlist_entries w JOIN public.groups g ON g.id = w.group_id
          WHERE w.club_id = ${clubId} AND w.person_id = ${subjectId} ORDER BY w.created_at`),
      },
      {
        key: "responses",
        rows: await of(sql`
          SELECT r.id, r.activity_id, a.title AS activity_title,
            a.starts_at AS activity_starts_at, r.status, r.note, r.responded_by_person_id,
            r.responded_at
          FROM public.activity_responses r JOIN public.activities a ON a.id = r.activity_id
          WHERE r.club_id = ${clubId} AND r.person_id = ${subjectId} ORDER BY a.starts_at`),
      },
      {
        key: "attendance",
        rows: await of(sql`
          SELECT ar.id, ar.activity_id, a.title AS activity_title,
            a.starts_at AS activity_starts_at, ar.status, ar.role, ar.guest,
            ar.recorded_by_person_id, ar.recorded_at, ar.corrected_reason
          FROM public.attendance_records ar JOIN public.activities a ON a.id = ar.activity_id
          WHERE ar.club_id = ${clubId} AND ar.person_id = ${subjectId} ORDER BY a.starts_at`),
      },
      {
        key: "callUps",
        rows: await of(sql`
          SELECT i.id, i.activity_id, a.title AS activity_title,
            a.starts_at AS activity_starts_at, i.invited_by_person_id, i.created_at
          FROM public.activity_invitees i JOIN public.activities a ON a.id = i.activity_id
          WHERE i.club_id = ${clubId} AND i.person_id = ${subjectId} ORDER BY a.starts_at`),
      },
      { key: "eventRegistrations", rows: registrations },
      {
        key: "invitationsSent",
        rows: await of(sql`
          SELECT id, kind, role_preset, group_id, created_at, expires_at, uses, accepted_at,
            revoked_at
          FROM public.invitations
          WHERE club_id = ${clubId} AND created_by_person_id = ${subjectId}
          ORDER BY created_at`),
      },
    ];
    const ids = sections.flatMap((s) =>
      s.rows.map((r) => r.id).filter((id): id is string => typeof id === "string"),
    );
    const history =
      ids.length === 0
        ? []
        : await of(sql`
            SELECT ${historyColumns} FROM history.record_changes
            WHERE club_id = ${clubId} AND record_id = ANY (${uuidArray(ids)}::uuid[])
            ORDER BY changed_at`);
    sections.push({ key: "history", rows: historyRows(history) });
    return { kind: "club", clubId, clubName, sections };
  });
}

/** Names of the people mentioned, as the requester may see them (hidden people left out). */
export async function namesOf(
  deps: CollectDeps,
  authz: RequestAuthorization,
  clubId: string | null,
  ids: readonly string[],
): Promise<Record<string, { name: string; protected: boolean }>> {
  if (ids.length === 0) return {};
  const summaries = await deps.people.summaries(authz.context, ids);
  const shown = await deps.presenter.present(authz, clubId, summaries);
  return Object.fromEntries(
    shown.map((s) => [s.id, { name: s.displayName, protected: s.protected }]),
  );
}

export function exportHeader(
  locale: Locale,
  subjectId: string,
  requesterId: string,
  now: Date,
): ExportHeader {
  return {
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    locale,
    subjectPersonId: subjectId,
    requestedByPersonId: requesterId,
  };
}

/**
 * The parts of the export in order: the platform's, then each club's, each
 * with the names of the people it mentions. Each part is read and handed
 * on before the next is read, so memory stays bounded by one club.
 */
export async function* collectExport(
  deps: CollectDeps,
  authz: RequestAuthorization,
  locale: Locale,
  subjectId: string,
): AsyncGenerator<{
  part: PlatformPart | ClubPart;
  names: Record<string, { name: string; protected: boolean }>;
}> {
  const { part, accountId } = await platformPart(deps, subjectId);
  part.sections.push(await platformHistory(deps, subjectId, accountId));
  yield { part, names: await namesOf(deps, authz, null, personIdsIn(part.sections)) };
  for (const clubId of await clubsOf(deps, authz, subjectId)) {
    const club = await clubPart(deps, locale, clubId, subjectId);
    yield { part: club, names: await namesOf(deps, authz, clubId, personIdsIn(club.sections)) };
  }
}
