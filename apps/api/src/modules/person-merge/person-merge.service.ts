// SPDX-License-Identifier: AGPL-3.0-only
// Merging duplicate people (domain-model.md: both parents created the same
// child). The duplicate's relationships move to the kept person: global rows
// directly, club rows club by club in the same transaction (inClub). Where
// the kept person already has the same open relationship, the duplicate's is
// ended instead. Everything moved is recorded so the merge can be undone for
// 30 days. The duplicate stays as a stub with merged_into_person_id set.
//
// Allowed for a full guardian of both people (in every club of the ward), or a
// club manager for two members of their club (rows in that club only).
// A person with a login cannot be merged away; merge into them instead.

import { audit, type Database, inClub, outbox, type TenantContext, type Tx } from "@clubadmin/db";

import { DomainError } from "../../platform/domain/domain-error.ts";
import type { PersonReference } from "../../platform/domain/person-references.ts";
import { actorPersonId, type Context, hasClub, runAs } from "../../platform/domain/run.ts";
import { ACTIVITY_PERSON_REFERENCES } from "../activities/index.ts";
import {
  CLUB_PROFILE_PERSON_REFERENCES,
  type ClubProfilesService,
} from "../club-profiles/index.ts";
import { EVENT_PERSON_REFERENCES } from "../events/index.ts";
import { GROUP_PERSON_REFERENCES } from "../groups/index.ts";
import { GUARDIANSHIP_PERSON_REFERENCES } from "../guardianships/index.ts";
import { MEMBERS_PERSON_REFERENCES } from "../members/index.ts";
import { JOINING_PERSON_REFERENCES, MEMBERSHIP_PERSON_REFERENCES } from "../memberships/index.ts";
import type { PeopleService } from "../people/index.ts";
import { ROLE_PERSON_REFERENCES } from "../roles/index.ts";
import * as repo from "./person-merge.repository.ts";

export const MERGE_UNDO_DAYS = 30;

export const PERSON_REFERENCES: readonly PersonReference[] = [
  ...GUARDIANSHIP_PERSON_REFERENCES,
  ...CLUB_PROFILE_PERSON_REFERENCES,
  ...MEMBERSHIP_PERSON_REFERENCES,
  ...ROLE_PERSON_REFERENCES,
  ...GROUP_PERSON_REFERENCES,
  ...JOINING_PERSON_REFERENCES,
  ...MEMBERS_PERSON_REFERENCES,
  ...ACTIVITY_PERSON_REFERENCES,
  ...EVENT_PERSON_REFERENCES,
];

export type PersonMerge = repo.MergeRow;
export type { DuplicateCandidate, DuplicateDetails } from "./person-merge.repository.ts";
type DuplicatePerson = Awaited<ReturnType<PeopleService["duplicateCandidatePeople"]>>[number];
type ClubDuplicate = Awaited<ReturnType<PeopleService["clubDuplicates"]>>[number];

const referenceKey = (r: { table: string; column: string }) => `${r.table}.${r.column}`;

export class PersonMergeService {
  private readonly db: Database;
  private readonly people: PeopleService;
  private readonly profiles: ClubProfilesService;

  constructor(db: Database, deps: { people: PeopleService; profiles: ClubProfilesService }) {
    this.db = db;
    this.people = deps.people;
    this.profiles = deps.profiles;
  }

  merge(context: Context, keptPersonId: string, duplicatePersonId: string): Promise<PersonMerge> {
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      if (keptPersonId === duplicatePersonId) throw new DomainError("merge_not_allowed");
      const kept = await this.people.getPersonInTx(tx, keptPersonId);
      const duplicate = await this.people.getPersonInTx(tx, duplicatePersonId);
      if (kept.mergedIntoPersonId || duplicate.mergedIntoPersonId)
        throw new DomainError("merge_not_allowed");
      if (await repo.hasAccount(tx, duplicatePersonId)) throw new DomainError("merge_not_allowed");
      await this.authorize(tx, context, keptPersonId, duplicatePersonId);

      // Find the clubs first: the actor sees them through their guardianship
      // of the duplicate, which the global moves below end.
      const clubRefs = PERSON_REFERENCES.filter((r) => r.clubScoped);
      const clubIds = await repo.clubsWithReferences(tx, clubRefs, duplicatePersonId);
      // Likewise mark the duplicate while it is still reachable.
      await this.people.setMergedIntoInTx(tx, duplicatePersonId, keptPersonId);
      const moved: repo.MovedReference[] = [];
      for (const ref of PERSON_REFERENCES.filter((r) => !r.clubScoped)) {
        moved.push(...(await repo.moveReferences(tx, ref, duplicatePersonId, keptPersonId, null)));
      }
      for (const clubId of clubIds) {
        await inClub(tx, clubId, async () => {
          for (const ref of clubRefs) {
            moved.push(
              ...(await repo.moveReferences(tx, ref, duplicatePersonId, keptPersonId, clubId)),
            );
          }
        });
      }

      const merge = await repo.insertMerge(tx, {
        keptPersonId,
        mergedPersonId: duplicatePersonId,
        mergedByPersonId: actor,
        undoUntil: new Date(Date.now() + MERGE_UNDO_DAYS * 86_400_000),
        movedReferences: moved,
      });
      await audit.record(tx, {
        action: "person.merged",
        resourceType: "person",
        resourceId: keptPersonId,
        changedFields: [...new Set(moved.map((m) => m.table))],
      });
      await outbox.publish(tx, "person.merged", {
        keptPersonId,
        mergedPersonId: duplicatePersonId,
        undone: false,
      });
      return merge;
    });
  }

  undo(context: Context, mergeId: string): Promise<void> {
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      const merge = await repo.lockMerge(tx, mergeId);
      if (!merge || merge.undoneAt) throw new DomainError("not_found");
      if (merge.undoUntil <= new Date()) throw new DomainError("merge_undo_expired");
      // The duplicate has no relationships left, so access goes through the kept person.
      if (merge.mergedByPersonId !== actor)
        await this.authorizeUndo(tx, context, merge.keptPersonId);

      const refs = new Map(PERSON_REFERENCES.map((r) => [referenceKey(r), r]));
      const restore = async (items: repo.MovedReference[]) => {
        for (const [key, ref] of refs) {
          const mine = items.filter((i) => referenceKey(i) === key);
          // Fewer rows than recorded: some are no longer reachable or were changed since.
          if ((await repo.restoreReferences(tx, ref, mine, merge.mergedPersonId)) !== mine.length) {
            throw new DomainError("merge_undo_conflict");
          }
        }
      };
      try {
        await restore(merge.movedReferences.filter((m) => m.clubId === null));
        const clubIds = [
          ...new Set(merge.movedReferences.flatMap((m) => (m.clubId ? [m.clubId] : []))),
        ];
        for (const clubId of clubIds) {
          await inClub(tx, clubId, () =>
            restore(merge.movedReferences.filter((m) => m.clubId === clubId)),
          );
        }
      } catch (error) {
        // A restored row would duplicate a relationship the kept person has since gained.
        if (error instanceof DomainError) throw error;
        throw new DomainError("merge_undo_conflict");
      }

      await this.people.setMergedIntoInTx(tx, merge.mergedPersonId, null);
      await repo.markUndone(tx, merge.id, actor);
      await audit.record(tx, {
        action: "person.merge.undone",
        resourceType: "person",
        resourceId: merge.keptPersonId,
      });
      await outbox.publish(tx, "person.merged", {
        keptPersonId: merge.keptPersonId,
        mergedPersonId: merge.mergedPersonId,
        undone: true,
      });
    });
  }

  /**
   * Duplicate candidates of a guardian: pairs of their wards (as a full
   * guardian) and their own or their co-guardians' wards (P1.3). The details
   * of co-guardians' wards are read without an actor, for the candidates'
   * IDs only; the controller leaves out people the guardian may not see.
   */
  async familyDuplicates(context: Context): Promise<{
    candidates: repo.DuplicateCandidate[];
    people: DuplicatePerson[];
    details: repo.DuplicateDetails[];
    merges: PersonMerge[];
  }> {
    const { candidates, merges } = await runAs(this.db, context, async (tx) => {
      const me = actorPersonId(context);
      return {
        candidates: await repo.familyDuplicateCandidates(tx),
        merges: await repo.undoableMergesBy(tx, me),
      };
    });
    const ids = [...new Set(candidates.flatMap((c) => [c.personId, c.duplicatePersonId]))];
    if (ids.length === 0) return { candidates, people: [], details: [], merges };
    // After the actor's transaction and one after the other: one connection
    // per request at a time (ADR 0040).
    const job = "person-merge:family_duplicates";
    const people = await this.people.duplicateCandidatePeople(job, ids);
    const details = await this.db.withSystem(job, {}, (system) =>
      repo.duplicateDetails(system, ids),
    );
    return { candidates, people, details, merges };
  }

  /** Pairs of the club's members that look like the same person, paged (club administrators). */
  clubDuplicates(
    context: TenantContext,
    options: { after: [string, string] | null; limit: number },
  ): Promise<ClubDuplicate[]> {
    return this.people.clubDuplicates(context, options);
  }

  private async authorizeUndo(tx: Tx, context: Context, keptPersonId: string): Promise<void> {
    if (await repo.actorIsFullGuardianOfBoth(tx, keptPersonId, keptPersonId)) return;
    if (
      hasClub(context) &&
      (await repo.actorIsClubManager(tx)) &&
      (await this.profiles.hasProfileInTx(tx, context.clubId, keptPersonId))
    ) {
      return;
    }
    throw new DomainError("merge_not_allowed");
  }

  private async authorize(
    tx: Tx,
    context: Context,
    keptPersonId: string,
    duplicatePersonId: string,
  ): Promise<void> {
    if (await repo.actorIsFullGuardianOfBoth(tx, keptPersonId, duplicatePersonId)) return;
    if (
      hasClub(context) &&
      (await repo.actorIsClubManager(tx)) &&
      (await this.profiles.hasProfileInTx(tx, context.clubId, keptPersonId)) &&
      (await this.profiles.hasProfileInTx(tx, context.clubId, duplicatePersonId))
    ) {
      return;
    }
    throw new DomainError("merge_not_allowed");
  }
}
