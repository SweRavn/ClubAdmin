// SPDX-License-Identifier: AGPL-3.0-only
// Meetings and tasks (P2.4 part B, ADR 0049 decisions 3–5, ADR 0052).
//
// - A meeting is an activity (a board's or committee's, of its group) or an
//   event (the annual meeting, for the club). Its agenda is replaced as a
//   whole (items kept by ID): titles, presenters, minutes per item,
//   decisions, papers (documents of the club) and action items (tasks with
//   their assignees). One editor at a time per meeting.
// - Agenda templates: the club's own, and the country pack's defaults to
//   start from.
// - Assembling the minutes writes one Markdown governing document of the
//   items (one § per item) in a series: created the first time, saved as
//   the draft (or a new draft after an adoption) when assembled again.
//   Names are never written into the text (ADR 0022): action items carry
//   their due date only; the agenda shows the assignees.
// - "Mina uppgifter": the caller's and their wards' assignments across clubs.
// Who may do what is the controller's: reading follows the activity or
// event (activity.read, event.read), editing activity.manage or
// event.manage; templates club.governing_documents.manage.

import { getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import { type ActorContext, audit, type Database, type TenantContext } from "@clubadmin/db";
import { format, type Locale, localeOf } from "@clubadmin/i18n";
import type {
  PutAgendaInput,
  PutAgendaTemplatesInput,
  SetTaskStatusInput,
} from "@clubadmin/shared";
import { uuidv7 } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { GoverningService } from "../documents/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import * as repo from "./meetings.repository.ts";

export type {
  ActionRow,
  ItemRow,
  MeetingKey,
  MyTaskRow,
  TemplateRow,
} from "./meetings.repository.ts";

export interface AgendaView {
  meeting: { title: string; groupId: string | null; startsAt: Date };
  items: repo.ItemRow[];
  decisions: Map<string, { id: string; text: string }[]>;
  papers: Map<string, { id: string; name: string }[]>;
  actions: Map<string, repo.ActionRow[]>;
  minutesDocumentId: string | null;
}

export interface TemplateView {
  id: string | null;
  packKey: string | null;
  meetingKind: repo.TemplateRow["meetingKind"];
  name: string;
  items: repo.TemplateRow["items"];
}

export class MeetingsService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly memberships: MembershipsService;
  private readonly governing: GoverningService;

  constructor(
    db: Database,
    deps: { clubs: ClubsService; memberships: MembershipsService; governing: GoverningService },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.memberships = deps.memberships;
    this.governing = deps.governing;
  }

  // --- Templates ----------------------------------------------------------------

  /** The club's templates by name, then its country pack's defaults. */
  templates(context: TenantContext): Promise<TemplateView[]> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const own = await repo.templates(tx, context.clubId);
      const pack = isSupportedCountry(club.country)
        ? (getCountryPack(club.country).agendaTemplates ?? [])
        : [];
      return [
        ...own.map((t) => ({ ...t, packKey: null })),
        ...pack.map((t) => ({
          id: null,
          packKey: t.key,
          meetingKind: t.meetingKind,
          name: t.name,
          items: t.items.map((i) => ({
            title: i.title,
            durationMinutes: i.durationMinutes ?? null,
          })),
        })),
      ];
    });
  }

  /** Replaces the club's templates (kept by ID, new ones without, missing ones removed). */
  async putTemplates(context: TenantContext, input: PutAgendaTemplatesInput): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const names = new Set(input.templates.map((t) => t.name.toLowerCase()));
      if (names.size !== input.templates.length)
        throw new DomainError("agenda_template_name_taken");
      const own = new Set((await repo.templates(tx, context.clubId)).map((t) => t.id));
      const keep: string[] = [];
      // Removed first, so a new template may take a removed one's name.
      await repo.deleteTemplatesExcept(
        tx,
        context.clubId,
        input.templates.flatMap((t) => (t.id && own.has(t.id) ? [t.id] : [])),
      );
      for (const t of input.templates) {
        if (t.id && !own.has(t.id)) throw new DomainError("not_found");
        const id = t.id ?? uuidv7();
        keep.push(id);
        await repo.upsertTemplate(tx, {
          id,
          clubId: context.clubId,
          by: personId,
          meetingKind: t.meetingKind,
          name: t.name,
          items: t.items.map((i) => ({
            title: i.title,
            durationMinutes: i.durationMinutes ?? null,
          })),
        });
      }
      await audit.record(tx, {
        action: "meeting.templates.updated",
        resourceType: "club",
        resourceId: context.clubId,
      });
    });
  }

  // --- Agendas ------------------------------------------------------------------

  /** A meeting's agenda in one query set. */
  agenda(context: TenantContext, m: repo.MeetingKey): Promise<AgendaView> {
    return this.db.withTenant(context, async (tx) => {
      const meeting = await repo.meeting(tx, m);
      if (!meeting) throw new DomainError("not_found");
      const agenda = await repo.agenda(tx, m);
      return { meeting, ...agenda, minutesDocumentId: await repo.minutesOf(tx, m) };
    });
  }

  /**
   * Replaces the agenda: items in the order given (kept by ID), their
   * decisions, papers and action items. Presenters and assignees are the
   * club's members; papers the club's documents.
   */
  async putAgenda(
    context: TenantContext,
    m: repo.MeetingKey,
    input: PutAgendaInput,
  ): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const meeting = await repo.meeting(tx, m);
      if (!meeting) throw new DomainError("not_found");
      await repo.lockAgenda(tx, m);
      const current = await repo.agenda(tx, m);
      const itemIds = new Set(current.items.map((i) => i.id));
      const taskIds = new Set([...current.actions.values()].flat().map((a) => a.taskId));
      const people = new Set(
        input.items.flatMap((i) => [
          ...(i.presenterPersonId ? [i.presenterPersonId] : []),
          ...(i.actions ?? []).flatMap((a) => a.assignees.map((x) => x.personId)),
        ]),
      );
      for (const id of people) {
        if (!(await this.memberships.isMemberInTx(tx, context.clubId, id))) {
          throw new DomainError("agenda_person_invalid");
        }
      }
      for (const item of input.items) {
        if (item.id && !itemIds.has(item.id)) throw new DomainError("not_found");
        for (const a of item.actions ?? []) {
          if (a.taskId && !taskIds.has(a.taskId)) throw new DomainError("not_found");
        }
      }

      await repo.deleteItemsExcept(
        tx,
        m,
        input.items.flatMap((i) => (i.id ? [i.id] : [])),
      );
      for (const [index, item] of input.items.entries()) {
        const id = item.id ?? uuidv7();
        await repo.upsertItem(tx, m, {
          id,
          clubId: context.clubId,
          position: index + 1,
          title: item.title,
          presenterPersonId: item.presenterPersonId ?? null,
          durationMinutes: item.durationMinutes ?? null,
          minutes: item.minutes ?? null,
        });
        if (item.decisions !== undefined) {
          await repo.replaceDecisions(tx, context.clubId, id, item.decisions);
        }
        if (item.paperIds !== undefined) {
          if (!(await repo.replacePapers(tx, context.clubId, id, [...new Set(item.paperIds)]))) {
            throw new DomainError("not_found");
          }
        }
        if (item.actions !== undefined) {
          const keep: string[] = [];
          for (const a of item.actions) {
            const taskId = a.taskId ?? uuidv7();
            keep.push(taskId);
            if (
              !(await repo.upsertTask(tx, {
                id: taskId,
                clubId: context.clubId,
                groupId: meeting.groupId,
                kind: "action_item",
                title: a.title,
                description: a.description ?? null,
                dueDate: a.dueDate ?? null,
                itemId: id,
                by: personId,
              }))
            ) {
              // A task of another item of this meeting: moving it is not supported.
              throw new DomainError("not_found");
            }
            const assignees = new Map(a.assignees.map((x) => [x.personId, x]));
            await repo.replaceAssignees(tx, {
              clubId: context.clubId,
              taskId,
              assignees: [...assignees.values()],
              by: personId,
            });
          }
          await repo.deleteTasksExcept(tx, id, keep);
        }
      }
      await audit.record(tx, {
        action: "meeting.agenda.updated",
        resourceType: m.kind,
        resourceId: m.id,
      });
    });
  }

  /**
   * Assembles the minutes: one § per item with its minutes, decisions and
   * action items, as a governing document in the series (the first time)
   * or as its draft again.
   */
  async assembleMinutes(
    context: TenantContext,
    m: repo.MeetingKey,
    input: { seriesId?: string | undefined },
  ): Promise<{ documentId: string; versionId: string }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const meeting = await repo.meeting(tx, m);
      if (!meeting) throw new DomainError("not_found");
      await repo.lockAgenda(tx, m);
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const locale: Locale = localeOf(club.defaultLocale) ?? "sv";
      const agenda = await repo.agenda(tx, m);
      if (agenda.items.length === 0) throw new DomainError("agenda_empty");
      const date = new Intl.DateTimeFormat(club.defaultLocale, {
        timeZone: club.timeZone,
        dateStyle: "long",
      }).format(meeting.startsAt);
      const body = minutesText(locale, meeting.title, date, agenda);
      const name = format(locale, "minutes.name", { meeting: meeting.title, date }).slice(0, 200);

      const existing = await repo.minutesOf(tx, m);
      let result: { documentId: string; versionId: string };
      if (existing) {
        const saved = await this.governing.updateInTx(tx, context, existing, { body });
        result = { documentId: existing, versionId: saved.versionId! };
      } else {
        if (!input.seriesId) throw new DomainError("minutes_series_required");
        const created = await this.governing.createInTx(tx, context, {
          seriesId: input.seriesId,
          name,
          body,
        });
        result = { documentId: created.id, versionId: created.versionId };
      }
      await repo.saveMinutes(tx, m, {
        clubId: context.clubId,
        documentId: result.documentId,
        by: personId,
      });
      await audit.record(tx, {
        action: "meeting.minutes.assembled",
        resourceType: m.kind,
        resourceId: m.id,
      });
      return result;
    });
  }

  // --- "Mina uppgifter" -------------------------------------------------------------

  /** The caller's and their wards' assignments across clubs, by day, keyset. */
  myTasks(
    context: ActorContext,
    query: { status: "open" | "closed"; cursor?: string | undefined; limit: number },
  ): Promise<{ rows: repo.MyTaskRow[]; nextCursor: string | null }> {
    return this.db.withActor(context, async (tx) => {
      const rows = (
        await repo.myTasks(tx, {
          cursor: query.cursor ?? null,
          limit: query.limit + 1,
          open: query.status === "open",
        })
      ).sort((a, b) =>
        a.sortDay === b.sortDay
          ? a.assignmentId.localeCompare(b.assignmentId)
          : a.sortDay < b.sortDay
            ? -1
            : 1,
      );
      const items = rows.slice(0, query.limit);
      return {
        rows: items,
        nextCursor: rows.length > query.limit ? items.at(-1)!.assignmentId : null,
      };
    });
  }

  /** Marks one of the caller's (or a ward's) assignments done, missed or planned again. */
  async setMyTaskStatus(
    context: ActorContext,
    assignmentId: string,
    input: SetTaskStatusInput,
  ): Promise<void> {
    const personId = actorPersonId(context);
    const clubId = await this.db.withActor(context, (tx) => repo.assignmentClub(tx, assignmentId));
    if (!clubId) throw new DomainError("not_found");
    await this.db.withTenant({ ...context, clubId }, async (tx) => {
      const marked = await repo.markAssignment(tx, {
        assignmentId,
        status: input.status,
        by: personId,
      });
      if (!marked) throw new DomainError("not_found");
      await audit.record(tx, {
        action: input.status === "done" ? "task.assignment.completed" : "task.assignment.updated",
        resourceType: marked.activityId ? "activity" : marked.eventId ? "event" : "club",
        resourceId: marked.activityId ?? marked.eventId ?? clubId,
        changedFields: ["status"],
      });
    });
  }
}

/** The minutes' Markdown: a heading, then one § per item. */
function minutesText(
  locale: Locale,
  title: string,
  date: string,
  agenda: Awaited<ReturnType<typeof repo.agenda>>,
): string {
  const lines = [`# ${format(locale, "minutes.heading", { meeting: title })}`, "", date, ""];
  for (const item of agenda.items) {
    lines.push(`## § ${item.position} ${item.title}`, "");
    if (item.minutes?.trim()) lines.push(item.minutes.trim(), "");
    const decisions = agenda.decisions.get(item.id) ?? [];
    if (decisions.length > 0) {
      lines.push(`**${format(locale, "minutes.decisions")}**`, "");
      for (const d of decisions) lines.push(`- ${d.text.replace(/\s*\n\s*/g, " ")}`);
      lines.push("");
    }
    const actions = agenda.actions.get(item.id) ?? [];
    if (actions.length > 0) {
      lines.push(`**${format(locale, "minutes.actions")}**`, "");
      for (const a of actions) {
        lines.push(
          a.dueDate
            ? `- ${format(locale, "minutes.actionDue", { action: a.title, date: a.dueDate })}`
            : `- ${a.title}`,
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
