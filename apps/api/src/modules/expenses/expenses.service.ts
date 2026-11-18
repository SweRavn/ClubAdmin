// SPDX-License-Identifier: AGPL-3.0-only
// Expense claims and attestation (P2.5 part B, ADR 0048 decisions 9–10).
//
// - A driver turns drives (their cars of started activities, from the car
//   pools module) into a mileage claim for one group, at the rate the board
//   decided (the club's mileage_rate, minor units per km; none: off). One
//   line per drive: the distance (the driver's correction, else the
//   place's) times the rate. A drive is claimed once (unless rejected).
// - Routing: to the activity's creator when the claim is for one activity
//   and they may attest it; otherwise to the group's attesters, then the
//   club's (the worker tells them).
// - Attesting: approve or reject (with a reason) a submitted claim, never
//   one's own; who may attest which group is the controller's (the actor).
// - Export: approved claims decided in a period, at most
//   EXPENSE_EXPORT_MAX_ROWS, marked exported; the CSV is the controller's.
// The `finance` feature: the controller's (club paths) or checked here
// (POST /me/expense-claims names its club in the body).

import {
  type ActorContext,
  audit,
  type Database,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type CreateMileageClaimInput,
  CreateMileageClaimSchema,
  type DecideExpenseClaimInput,
  DecideExpenseClaimSchema,
  EXPENSE_EXPORT_MAX_ROWS,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import type { CarpoolsService, DriveRow } from "../carpools/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { EntitlementsService } from "../entitlements/index.ts";
import * as repo from "./expenses.repository.ts";

export type { ClaimLineRow, ClaimRow, ExportRow } from "./expenses.repository.ts";

/** Who may attest which of the club's groups (from the actor's roles). */
export type AttestScope =
  { club: true } | { club: false; groupIds: readonly string[]; ownedGroupIds: readonly string[] };

const localDate = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short" }).format(date);

export class ExpensesService {
  private readonly db: Database;
  private readonly carpools: CarpoolsService;
  private readonly clubs: ClubsService;
  private readonly entitlements: Pick<EntitlementsService, "has">;

  constructor(
    db: Database,
    deps: {
      carpools: CarpoolsService;
      clubs: ClubsService;
      entitlements: Pick<EntitlementsService, "has">;
    },
  ) {
    this.db = db;
    this.carpools = deps.carpools;
    this.clubs = deps.clubs;
    this.entitlements = deps.entitlements;
  }

  private async requireFinance(clubId: string): Promise<void> {
    if (!(await this.entitlements.has(clubId, "finance"))) {
      throw new ProblemError("entitlement-required", { detail: "finance" });
    }
  }

  /** The caller's drives in the club not yet claimed, with the club's rate. */
  async claimable(
    context: TenantContext,
  ): Promise<{ currency: string; mileageRate: number | null; drives: DriveRow[] }> {
    await this.requireFinance(context.clubId);
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const drives = await this.carpools.drivesInTx(tx, me);
      const claimed = await repo.claimedOffers(
        tx,
        drives.map((d) => d.offerId),
      );
      return {
        currency: club.currency,
        mileageRate: club.mileageRate ?? null,
        drives: drives.filter((d) => !claimed.has(d.offerId)),
      };
    });
  }

  async createMileageClaim(
    context: ActorContext,
    input: CreateMileageClaimInput,
  ): Promise<{ id: string }> {
    const data = parseInput(CreateMileageClaimSchema, input);
    const me = actorPersonId(context);
    await this.requireFinance(data.clubId);
    return this.db.withTenant({ ...context, clubId: data.clubId }, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, data.clubId);
      const rate = club.mileageRate ?? null;
      if (rate === null) throw new DomainError("mileage_off");
      const offerIds = [...new Set(data.offerIds)];
      const drives = await this.carpools.drivesInTx(tx, me, { offerIds, limit: offerIds.length });
      if (
        drives.length !== offerIds.length ||
        drives.some((d) => !d.groupIds.includes(data.groupId))
      ) {
        throw new DomainError("claim_drive_invalid");
      }
      if (drives.some((d) => d.distanceKm === null)) {
        throw new DomainError("claim_distance_missing");
      }
      if ((await repo.claimedOffers(tx, offerIds)).size > 0) {
        throw new DomainError("claim_drive_claimed");
      }
      const ordered = [...drives].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const lines = ordered.map((d) => {
        const km = Math.round(d.distanceKm! * 10) / 10;
        return {
          offerId: d.offerId,
          // The activity's title and local date (no names), the direction as an arrow.
          description:
            `${localDate(d.startsAt, club.timeZone)} ${d.direction === "out" ? "→" : "←"} ${d.activityTitle}`.slice(
              0,
              200,
            ),
          quantity: km,
          unitAmountMinor: rate,
          amountMinor: Math.round(km * rate),
        };
      });
      const activityIds = new Set(drives.map((d) => d.activityId));
      const activityId = activityIds.size === 1 ? [...activityIds][0]! : null;
      // Routed to the activity's creator when they may attest the group (never the claimant).
      const creator = activityId ? (drives[0]!.activityCreatorPersonId ?? null) : null;
      const routedTo =
        creator && creator !== me && (await repo.mayAttest(tx, data.clubId, creator, data.groupId))
          ? creator
          : null;
      const id = await repo.insertClaim(tx, {
        clubId: data.clubId,
        kind: "mileage",
        claimantPersonId: me,
        groupId: data.groupId,
        activityId,
        routedToPersonId: routedTo,
        amountMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0),
        currency: club.currency,
        lines,
      });
      await audit.record(tx, {
        action: "expense.claim.submitted",
        resourceType: "expense_claim",
        resourceId: id,
        changedFields: ["amount_minor", "lines"],
      });
      await outbox.publish(tx, "expense_claim.submitted", { clubId: data.clubId, claimId: id });
      return { id };
    });
  }

  myClaims(
    context: ActorContext,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: repo.ClaimRow[]; nextCursor: string | null }> {
    return this.db.withActor(context, async (tx) => {
      const rows = await repo.myClaims(tx, { cursor: page.cursor ?? null, limit: page.limit + 1 });
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  queue(
    context: TenantContext,
    scope: AttestScope,
    query: { status: repo.ClaimRow["status"]; cursor?: string | undefined; limit: number },
  ): Promise<{ items: repo.ClaimRow[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.queue(tx, context.clubId, {
        status: query.status,
        groupIds: scope.club ? null : await attestGroups(tx, context.clubId, scope),
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }

  decide(
    context: TenantContext,
    scope: AttestScope,
    claimId: string,
    input: DecideExpenseClaimInput,
  ): Promise<repo.ClaimRow> {
    const data = parseInput(DecideExpenseClaimSchema, input);
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const found = await repo.claim(tx, claimId, true);
      if (found?.clubId !== context.clubId) throw new DomainError("not_found");
      if (!scope.club && !(await attestGroups(tx, context.clubId, scope)).includes(found.groupId)) {
        throw new DomainError("not_found");
      }
      if (found.claimantPersonId === me) throw new DomainError("claim_own");
      if (found.status !== "submitted") throw new DomainError("claim_decided");
      const approved = data.decision === "approve";
      await repo.decide(tx, claimId, {
        status: approved ? "approved" : "rejected",
        by: me,
        reason: data.reason ?? null,
      });
      await audit.record(tx, {
        action: approved ? "expense.claim.approved" : "expense.claim.rejected",
        resourceType: "expense_claim",
        resourceId: claimId,
        changedFields: ["status", ...(data.reason ? ["reason"] : [])],
      });
      await outbox.publish(tx, "expense_claim.decided", { clubId: context.clubId, claimId });
      return (await repo.claim(tx, claimId))!;
    });
  }

  /**
   * Approved claims decided in [from, to] (dates in the club's time zone),
   * marked exported; export_too_large beyond EXPENSE_EXPORT_MAX_ROWS.
   */
  export(
    context: TenantContext,
    range: { from: string; to: string },
  ): Promise<{ rows: repo.ExportRow[]; timeZone: string }> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const from = zonedMidnight(range.from, club.timeZone);
      const to = zonedMidnight(nextDay(range.to), club.timeZone);
      if (!(to > from) || to.getTime() - from.getTime() > 400 * 86_400_000) {
        throw new DomainError("range_too_large");
      }
      const rows = await repo.exportRows(
        tx,
        context.clubId,
        { from, to },
        EXPENSE_EXPORT_MAX_ROWS + 1,
      );
      if (rows.length > EXPENSE_EXPORT_MAX_ROWS) throw new DomainError("export_too_large");
      await repo.markExported(
        tx,
        rows.filter((r) => r.status === "approved").map((r) => r.id),
      );
      await audit.record(tx, {
        action: "expense.claims.exported",
        resourceType: "club",
        resourceId: context.clubId,
        changedFields: ["status"],
      });
      return { rows, timeZone: club.timeZone };
    });
  }
}

/** The groups a group attester attests: their roles' and the owned groups with those under them. */
async function attestGroups(
  tx: Tx,
  clubId: string,
  scope: { groupIds: readonly string[]; ownedGroupIds: readonly string[] },
): Promise<string[]> {
  const owned = await repo.groupsUnder(tx, clubId, scope.ownedGroupIds);
  return [...new Set([...scope.groupIds, ...owned])];
}

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Midnight of a local date in a time zone, as an instant. */
function zonedMidnight(date: string, timeZone: string): Date {
  const utc = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(utc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(utc.getTime() - (shown - utc.getTime()));
}
