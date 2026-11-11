// SPDX-License-Identifier: AGPL-3.0-only
// At least two administrators; suspending one (P1.15 A3, ADR 0046). Who
// counts and the club's state come from app.club_administrators (SQL); the
// two-person rule's confirmation is app.confirm_administrator_suspension,
// which also sets the exception to the minimum (only it can). The club's
// relationship sets follow through the administrator.suspended event.

import {
  audit,
  type Database,
  databaseError,
  isUniqueViolation,
  outbox,
  sql,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  ADMINISTRATORS_GRACE_EXTENSION_DAYS,
  type AdministratorsState,
  type StartSuspensionInput,
  StartSuspensionSchema,
  SUSPENSION_REQUEST_HOURS,
  SUSPENSION_REVIEW_DAYS,
  type SuspensionReason,
  type SuspensionStatus,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";

export interface AdministratorRow {
  personId: string;
  counts: boolean;
  reason: "no_account" | "minor" | null;
  roleIds: string[];
}

export interface SuspensionRow {
  id: string;
  clubId: string;
  targetPersonId: string;
  requestedByPersonId: string;
  confirmedByPersonId: string | null;
  reason: SuspensionReason;
  note: string | null;
  demote: boolean;
  status: SuspensionStatus;
  expiresAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface AdministratorsFacts {
  administrators: AdministratorRow[];
  count: number;
  state: AdministratorsState;
  graceUntil: Date | null;
  graceExtended: boolean;
  suspensions: SuspensionRow[];
}

export interface ConfirmedSuspension {
  suspension: SuspensionRow;
  endedRoles: number;
  endedGroupRoles: number;
  /** The login whose identity provider sessions end (compromised). */
  idpSubject: string | null;
}

export interface ReviewRow {
  action: string;
  resourceType: string;
  resourceId: string | null;
  occurredAt: Date;
}

interface SuspensionDbRow {
  id: string;
  club_id: string;
  target_person_id: string;
  requested_by_person_id: string;
  confirmed_by_person_id: string | null;
  reason: SuspensionReason;
  note: string | null;
  demote: boolean;
  status: SuspensionStatus;
  expires_at: string | Date;
  decided_at: string | Date | null;
  created_at: string | Date;
  [key: string]: unknown;
}

const toSuspension = (r: SuspensionDbRow): SuspensionRow => ({
  id: r.id,
  clubId: r.club_id,
  targetPersonId: r.target_person_id,
  requestedByPersonId: r.requested_by_person_id,
  confirmedByPersonId: r.confirmed_by_person_id,
  reason: r.reason,
  note: r.note,
  demote: r.demote,
  status: r.status,
  // Raw statements return text: dates are made here.
  expiresAt: new Date(r.expires_at),
  decidedAt: r.decided_at === null ? null : new Date(r.decided_at),
  createdAt: new Date(r.created_at),
});

const SUSPENSION_COLUMNS = sql`id, club_id, target_person_id, requested_by_person_id,
  confirmed_by_person_id, reason, note, demote, status, expires_at, decided_at, created_at`;

/** The errors app.confirm_administrator_suspension raises, as domain errors. */
function confirmError(error: unknown): DomainError | null {
  const info = databaseError(error);
  if (!info) return null;
  if (info.code === "P0002") return new DomainError("not_found");
  if (info.code === "55000") return new DomainError("suspension_not_open");
  if (info.code === "42501") return new DomainError("suspension_not_allowed");
  return null;
}

export function administratorsState(count: number, graceUntil: Date | null): AdministratorsState {
  if (count >= 3) return "ok";
  if (count === 2) return "recommend_third";
  return graceUntil && graceUntil.getTime() > Date.now() ? "grace" : "needs_administrators";
}

export class AdministratorsService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** The club's administrators, who counts, its state and the open suspension requests. */
  overview(context: TenantContext): Promise<AdministratorsFacts> {
    return this.db.withTenant(context, (tx) => this.factsInTx(tx, context.clubId));
  }

  async factsInTx(tx: Tx, clubId: string): Promise<AdministratorsFacts> {
    const { rows } = await tx.execute<{
      person_id: string;
      counts: boolean;
      reason: "no_account" | "minor" | null;
      role_ids: string[];
      grace_until: string | null;
      grace_extended: boolean;
    }>(sql`
      WITH club AS (
        SELECT administrators_grace_until AS grace_until,
          administrators_grace_extended_at IS NOT NULL AS grace_extended
        FROM public.clubs WHERE id = ${clubId}),
      admins AS (
        SELECT a.person_id, a.counts, a.reason,
          ARRAY(SELECT DISTINCT r.role_id FROM public.club_role_assignments r
                JOIN public.role_permissions rp ON rp.club_id = r.club_id AND rp.role_id = r.role_id
                WHERE r.club_id = ${clubId} AND r.person_id = a.person_id AND r.valid_to IS NULL
                  AND rp.permission = 'club.roles.manage') AS role_ids
        FROM app.club_administrators(${clubId}) a)
      SELECT admins.person_id, admins.counts, admins.reason, admins.role_ids,
        club.grace_until, club.grace_extended
      FROM club LEFT JOIN admins ON true`);
    const first = rows[0];
    const graceUntil = first?.grace_until ? new Date(first.grace_until) : null;
    const administrators = rows
      .filter((r) => r.person_id !== null)
      .map((r) => ({
        personId: r.person_id,
        counts: r.counts,
        reason: r.reason,
        roleIds: r.role_ids,
      }));
    const count = administrators.filter((a) => a.counts).length;
    const { rows: open } = await tx.execute<SuspensionDbRow>(sql`
      SELECT ${SUSPENSION_COLUMNS} FROM public.administrator_suspensions
      WHERE club_id = ${clubId} AND status = 'requested' AND expires_at > now()
      ORDER BY created_at`);
    return {
      administrators,
      count,
      state: administratorsState(count, graceUntil),
      graceUntil,
      graceExtended: first?.grace_extended === true,
      suspensions: open.map(toSuspension),
    };
  }

  /**
   * Starts "Stäng av som föreningsadministratör" for another administrator
   * (the controller requires a second factor and a recent login). The
   * target is told at once.
   */
  start(
    context: TenantContext,
    targetPersonId: string,
    input: StartSuspensionInput,
  ): Promise<SuspensionRow> {
    const data = parseInput(StartSuspensionSchema, input);
    const me = actorPersonId(context);
    if (me === targetPersonId) throw new DomainError("suspension_not_allowed");
    return this.db.withTenant(context, async (tx) => {
      const { rows: admin } = await tx.execute<{ person_id: string }>(sql`
        SELECT person_id FROM app.club_administrators(${context.clubId})
        WHERE person_id = ${targetPersonId}`);
      if (admin.length === 0) throw new DomainError("not_an_administrator");
      let row: SuspensionDbRow;
      try {
        const { rows } = await tx.execute<SuspensionDbRow>(sql`
          INSERT INTO public.administrator_suspensions
            (club_id, target_person_id, requested_by_person_id, reason, note, demote, expires_at)
          VALUES (${context.clubId}, ${targetPersonId}, ${me}, ${data.reason},
            ${data.note ?? null}, ${data.demote ?? data.reason === "compromised"},
            now() + make_interval(hours => ${SUSPENSION_REQUEST_HOURS}))
          RETURNING ${SUSPENSION_COLUMNS}`);
        row = rows[0]!;
      } catch (error) {
        if (isUniqueViolation(error, "administrator_suspensions_open_unique"))
          throw new DomainError("suspension_requested");
        throw error;
      }
      await audit.record(tx, {
        action: "administrator.suspension.requested",
        resourceType: "administrator_suspension",
        resourceId: row.id,
        changedFields: ["target_person_id", "reason", "note", "demote"],
      });
      await outbox.publish(tx, "administrator.suspension.requested", {
        clubId: context.clubId,
        suspensionId: row.id,
      });
      return toSuspension(row);
    });
  }

  /**
   * Confirms a request (the policy has checked the two-person rule; the
   * database checks it again). Returns what ended; the caller revokes the
   * sessions after the commit.
   */
  async confirm(context: TenantContext, suspensionId: string): Promise<ConfirmedSuspension> {
    try {
      return await this.db.withTenant(context, async (tx) => {
        const { rows } = await tx.execute<{
          target_person_id: string;
          ended_roles: number;
          ended_group_roles: number;
          idp_subject: string | null;
        }>(sql`SELECT * FROM app.confirm_administrator_suspension(${suspensionId})`);
        const result = rows[0]!;
        await audit.record(tx, {
          action: "administrator.suspended",
          resourceType: "administrator_suspension",
          resourceId: suspensionId,
          changedFields: ["status", "confirmed_by_person_id"],
        });
        await outbox.publish(tx, "administrator.suspended", {
          clubId: context.clubId,
          suspensionId,
          personId: result.target_person_id,
        });
        return {
          suspension: await this.getInTx(tx, context.clubId, suspensionId),
          endedRoles: result.ended_roles,
          endedGroupRoles: result.ended_group_roles,
          idpSubject: result.idp_subject,
        };
      });
    } catch (error) {
      throw confirmError(error) ?? error;
    }
  }

  /** The initiator withdraws an open request. */
  cancel(context: TenantContext, suspensionId: string): Promise<SuspensionRow> {
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const { rows } = await tx.execute<SuspensionDbRow>(sql`
        SELECT ${SUSPENSION_COLUMNS} FROM public.administrator_suspensions
        WHERE id = ${suspensionId} AND club_id = ${context.clubId} FOR UPDATE`);
      const row = rows[0];
      if (!row) throw new DomainError("not_found");
      if (row.requested_by_person_id !== me) throw new DomainError("suspension_not_allowed");
      if (row.status !== "requested") throw new DomainError("suspension_not_open");
      await tx.execute(sql`
        UPDATE public.administrator_suspensions SET status = 'cancelled', decided_at = now()
        WHERE id = ${suspensionId}`);
      await audit.record(tx, {
        action: "administrator.suspension.cancelled",
        resourceType: "administrator_suspension",
        resourceId: suspensionId,
        changedFields: ["status"],
      });
      await outbox.publish(tx, "administrator.suspension.closed", {
        clubId: context.clubId,
        suspensionId,
        status: "cancelled",
      });
      return this.getInTx(tx, context.clubId, suspensionId);
    });
  }

  /**
   * The target's role, permission and invitation changes of the last
   * SUSPENSION_REVIEW_DAYS days, to review and undo (the club's audit log,
   * by its actor index).
   */
  review(context: TenantContext, suspensionId: string): Promise<ReviewRow[]> {
    return this.db.withTenant(context, async (tx) => {
      const suspension = await this.getInTx(tx, context.clubId, suspensionId);
      const { rows } = await tx.execute<{
        action: string;
        resource_type: string;
        resource_id: string | null;
        created_at: string;
      }>(sql`
        SELECT action, resource_type, resource_id, created_at FROM audit.events
        WHERE club_id = ${context.clubId} AND actor_person_id = ${suspension.targetPersonId}
          AND created_at > now() - make_interval(days => ${SUSPENSION_REVIEW_DAYS})
          AND (action LIKE 'role.%' OR action LIKE 'club.role.%' OR action LIKE 'invitation.%'
            OR action LIKE 'club.manager.%' OR action LIKE 'group.member%')
        ORDER BY created_at DESC, id DESC
        LIMIT 100`);
      return rows.map((r) => ({
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        occurredAt: new Date(r.created_at),
      }));
    });
  }

  /** An operator gives the club more time, once (ADMINISTRATORS_GRACE_EXTENSION_DAYS). */
  extendGrace(context: TenantContext): Promise<Date> {
    const { clubId } = context;
    return this.db.withTenant(context, async (tx) => {
      const { rows } = await tx.execute<{
        grace_until: string | null;
        extended_at: string | null;
      }>(sql`
        SELECT administrators_grace_until AS grace_until,
          administrators_grace_extended_at AS extended_at
        FROM public.clubs WHERE id = ${clubId} FOR UPDATE`);
      const club = rows[0];
      if (!club) throw new DomainError("not_found");
      if (club.extended_at) throw new DomainError("grace_already_extended");
      if (!club.grace_until) throw new DomainError("no_grace_period");
      const { rows: updated } = await tx.execute<{ grace_until: string }>(sql`
        UPDATE public.clubs
        SET administrators_grace_until = greatest(administrators_grace_until, now())
            + make_interval(days => ${ADMINISTRATORS_GRACE_EXTENSION_DAYS}),
          administrators_grace_extended_at = now()
        WHERE id = ${clubId}
        RETURNING administrators_grace_until AS grace_until`);
      await audit.record(tx, {
        action: "club.administrators.grace_extended",
        resourceType: "club",
        resourceId: clubId,
        changedFields: ["administrators_grace_until", "administrators_grace_extended_at"],
      });
      return new Date(updated[0]!.grace_until);
    });
  }

  private async getInTx(tx: Tx, clubId: string, id: string): Promise<SuspensionRow> {
    const { rows } = await tx.execute<SuspensionDbRow>(sql`
      SELECT ${SUSPENSION_COLUMNS} FROM public.administrator_suspensions
      WHERE id = ${id} AND club_id = ${clubId}`);
    if (!rows[0]) throw new DomainError("not_found");
    return toSuspension(rows[0]);
  }
}
