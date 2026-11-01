// SPDX-License-Identifier: AGPL-3.0-only
// privacy:erase (P1.8b, ADR 0041): runs the account deletions and ward
// erasures whose grace period has passed, every ten minutes, in the API's
// job runner (ADR 0033: it acts through the domain services and the
// sessions). Per request, idempotently and one transaction at a time: the
// blockers are checked again (a role given during the grace period stops
// it, error_code `blocked`, and the person is told); each person leaves
// every club as the system, their guardianships end, their export files go;
// then privacy.erase_person runs as clubadmin_retention. After the database
// part the sessions are revoked and the Zitadel user deleted; a failure
// there leaves error_code and is retried, the database erasure is never
// rolled back. No notice afterwards: the address is gone.

import { type Database, outbox, sql } from "@clubadmin/db";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";

import type { GuardianshipsService } from "../guardianships/index.ts";
import { assignmentFactsAsRetention } from "./data-rights.repository.ts";
import { erasureBlockersInTx } from "./erasure.service.ts";
import type { LeavingService } from "./leaving.service.ts";
import type { OutstandingObligationsProvider } from "./outstanding-obligations.ts";

const JOB = "privacy:erase";
/** Attempts before a request is left as failed for an operator to look at. */
const MAX_ATTEMPTS = 10;

export interface ErasureJobDeps {
  db: Database;
  /** clubadmin_retention: privacy.erase_person (null: requests wait, erasure_unavailable). */
  retentionDb: Database | null;
  storage: ObjectStorage | null;
  leaving: LeavingService;
  guardianships: GuardianshipsService;
  obligations: readonly OutstandingObligationsProvider[];
  sessions: { revokeAllOf(personId: string): Promise<number> };
  /** Deletes the Zitadel user (absent with DEV_AUTH only or without the machine user). */
  zitadelUsers?: { delete(userId: string): Promise<void> } | undefined;
}

interface DueRow {
  id: string;
  person_id: string;
  kind: "account_deletion" | "ward_erasure";
  include_ward_ids: string[];
  attempts: number;
  [key: string]: unknown;
}

async function setError(db: Database, id: string, code: string, failed: boolean): Promise<void> {
  await db.withSystem(JOB, {}, (tx) =>
    tx.execute(sql`
      UPDATE public.erasure_requests
      SET error_code = ${code}, status = CASE WHEN ${failed} THEN 'failed' ELSE status END
      WHERE id = ${id}`),
  );
}

/** Erases one person (idempotent): leaves the clubs, ends guardianships, deletes files, erases. */
async function erasePerson(
  deps: ErasureJobDeps & { retentionDb: Database },
  request: DueRow,
  personId: string,
): Promise<void> {
  const { rows: clubs } = await deps.db.withSystem(JOB, {}, (tx) =>
    tx.execute<{ club_id: string }>(sql`
      SELECT club_id FROM public.club_memberships
      WHERE person_id = ${personId} AND valid_to IS NULL`),
  );
  for (const { club_id: clubId } of clubs) {
    await deps.db.withSystem(JOB, { clubId }, (tx) =>
      deps.leaving.leaveForErasureInTx(tx, clubId, personId),
    );
  }
  const files = await deps.db.withSystem(JOB, {}, async (tx) => {
    await deps.guardianships.endAllOfPersonInTx(tx, personId);
    // The login to delete after the database erasure (which clears it).
    if (personId === request.person_id && request.kind === "account_deletion") {
      await tx.execute(sql`
        UPDATE public.erasure_requests r SET pending_idp_subject = a.idp_subject
        FROM public.accounts a
        WHERE r.id = ${request.id} AND a.person_id = ${personId} AND a.idp_subject IS NOT NULL`);
    }
    const { rows } = await tx.execute<{ object_key: string }>(sql`
      SELECT object_key FROM public.data_exports
      WHERE (subject_person_id = ${personId} OR requested_by_person_id = ${personId})
        AND object_key IS NOT NULL`);
    return rows.map((r) => r.object_key);
  });
  for (const key of files) await deps.storage?.deleteObject(key);
  const reason =
    request.kind === "account_deletion" && personId === request.person_id
      ? "account_deleted"
      : "ward_erased";
  await deps.retentionDb.withSystem(JOB, {}, (tx) =>
    tx.execute(sql`SELECT privacy.erase_person(${personId}, ${reason})`),
  );
  await deps.sessions.revokeAllOf(personId);
}

async function runOne(deps: ErasureJobDeps, request: DueRow): Promise<void> {
  const retentionDb = deps.retentionDb;
  if (!retentionDb) {
    await setError(deps.db, request.id, "erasure_unavailable", false);
    return;
  }
  const people =
    request.kind === "account_deletion"
      ? [request.person_id, ...request.include_ward_ids]
      : [request.person_id];
  // As clubadmin_retention, which sees every club's rows (the caller filter of
  // app.erasure_assignments does not apply to a job).
  const blockers = await retentionDb.withSystem(JOB, {}, (tx) =>
    erasureBlockersInTx(tx, people, deps.obligations, assignmentFactsAsRetention),
  );
  if (blockers.length > 0) {
    await deps.db.withSystem(JOB, {}, async (tx) => {
      await tx.execute(sql`
        UPDATE public.erasure_requests SET status = 'failed', error_code = 'blocked'
        WHERE id = ${request.id}`);
      await outbox.publish(tx, "privacy.erasure.blocked", { requestId: request.id });
    });
    return;
  }
  for (const personId of people) {
    await erasePerson({ ...deps, retentionDb }, request, personId);
  }
  const { rows } = await deps.db.withSystem(JOB, {}, (tx) =>
    tx.execute<{ pending_idp_subject: string | null }>(sql`
      SELECT pending_idp_subject FROM public.erasure_requests WHERE id = ${request.id}`),
  );
  const idpSubject = rows[0]?.pending_idp_subject ?? null;
  if (idpSubject && deps.zitadelUsers) await deps.zitadelUsers.delete(idpSubject);
  await deps.db.withSystem(JOB, {}, (tx) =>
    tx.execute(sql`
      UPDATE public.erasure_requests
      SET status = 'done', done_at = now(), error_code = NULL, pending_idp_subject = NULL
      WHERE id = ${request.id}`),
  );
}

/**
 * Takes the due requests (scheduled past their date, or running and not
 * finished) and runs each. Returns how many finished.
 */
export async function runDueErasures(deps: ErasureJobDeps, limit = 20): Promise<number> {
  const { rows: due } = await deps.db.withSystem(JOB, {}, (tx) =>
    tx.execute<DueRow>(sql`
      UPDATE public.erasure_requests r
      SET status = 'running', started_at = coalesce(r.started_at, now()), attempts = r.attempts + 1
      WHERE r.id IN (
        SELECT id FROM public.erasure_requests
        WHERE status IN ('scheduled', 'running') AND scheduled_for <= now()
        ORDER BY scheduled_for FOR UPDATE SKIP LOCKED LIMIT ${limit})
      RETURNING r.id, r.person_id, r.kind, r.include_ward_ids, r.attempts`),
  );
  let done = 0;
  for (const request of due) {
    try {
      await runOne(deps, request);
      done++;
    } catch {
      // IDs and codes only; the next run retries (the database part is idempotent).
      await setError(deps.db, request.id, "retry", request.attempts >= MAX_ATTEMPTS);
    }
  }
  return done;
}
