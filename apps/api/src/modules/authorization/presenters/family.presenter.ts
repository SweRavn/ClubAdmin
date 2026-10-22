// SPDX-License-Identifier: AGPL-3.0-only
// Families (P1.3): guardians, relatives and contact persons of a ward as the
// viewer may see them. Names through the PersonPresenter (protected people
// left out for those who may not see them, ADR 0022); phone numbers and
// consent notes only for full guardians, the ward and the club's
// administrators; invitation emails only for full guardians and the inviter.

import type { z } from "@clubadmin/shared";
import type { PendingGuardianInvitationSchema } from "@clubadmin/shared";
import {
  type GuardianEntry,
  type GuardianshipKind,
  type GuardianshipRight,
  type GuardianshipStatus,
  isFullGuardianshipKind,
  type PersonSummary,
} from "@clubadmin/shared";

import type { RequestAuthorization } from "../request-authorization.ts";
import type { PersonPresenter, PresentablePerson } from "./person.presenter.ts";

export interface PresentableGuardianship {
  id: string;
  guardianPersonId: string;
  kind: GuardianshipKind;
  rights: GuardianshipRight[];
  status: GuardianshipStatus;
  validFrom: Date;
  recordedByClubId: string | null;
  consentNote: string | null;
}

export interface PresentableInvitation {
  id: string;
  kind: GuardianshipKind;
  rights: GuardianshipRight[];
  email: string;
  invitedByPersonId: string;
  expiresAt: Date;
  resentAt: Date | null;
}

/** The viewer's standing towards the ward (from GuardianshipsService.wardGuardians). */
export interface FamilyViewer {
  personId: string;
  fullGuardian: boolean;
  ward: boolean;
  wardMayLink: boolean;
  minor: boolean;
  /** Club manager or registrar of the club whose view this is. */
  clubAdmin?: boolean;
}

/** A guardian's person row with the contact field the presenter may show. */
export type GuardianPerson = PresentablePerson & { phone: string | null };

export class FamilyPresenter {
  private readonly people: PersonPresenter;

  constructor(people: PersonPresenter) {
    this.people = people;
  }

  async guardians(
    authorization: RequestAuthorization,
    clubId: string | null,
    rows: readonly PresentableGuardianship[],
    people: ReadonlyMap<string, GuardianPerson>,
    viewer: FamilyViewer,
  ): Promise<GuardianEntry[]> {
    const persons = rows.flatMap((r) => {
      const p = people.get(r.guardianPersonId);
      return p ? [p] : [];
    });
    const shown = new Map(
      (await this.people.present(authorization, clubId, persons)).map((p) => [p.id, p]),
    );
    const contact = viewer.fullGuardian || viewer.ward || viewer.clubAdmin === true;
    return rows.flatMap((r): GuardianEntry[] => {
      const person = shown.get(r.guardianPersonId);
      if (!person) return [];
      const isYou = r.guardianPersonId === viewer.personId;
      const linked = !isFullGuardianshipKind(r.kind);
      const managesLinks = (viewer.fullGuardian && viewer.minor) || viewer.wardMayLink;
      return [
        {
          guardianshipId: r.id,
          person,
          kind: r.kind,
          rights: r.rights,
          status: r.status,
          since: r.validFrom.toISOString(),
          ...(contact ? { phone: people.get(r.guardianPersonId)?.phone ?? null } : {}),
          recordedByClub: r.recordedByClubId !== null,
          ...(contact && linked ? { consentNote: r.consentNote } : {}),
          isYou,
          canEnd: isYou || (linked && managesLinks),
          canChangeRights: !isYou && linked && managesLinks,
        },
      ];
    });
  }

  invitations(
    rows: readonly PresentableInvitation[],
    viewer: FamilyViewer,
  ): z.infer<typeof PendingGuardianInvitationSchema>[] {
    // Relatives and contact persons never see invitations.
    if (!viewer.fullGuardian && !viewer.ward) return [];
    return rows.flatMap((r) => {
      const mine = r.invitedByPersonId === viewer.personId;
      // The ward sees the invitations they sent themselves, not their guardians'.
      if (viewer.ward && !mine) return [];
      return [
        {
          invitationId: r.id,
          kind: r.kind,
          rights: r.rights,
          ...(viewer.fullGuardian || mine ? { email: r.email } : {}),
          expiresAt: r.expiresAt.toISOString(),
          resentAt: r.resentAt?.toISOString() ?? null,
          canManage: viewer.fullGuardian || mine,
        },
      ];
    });
  }

  /**
   * The landing page of an invitation link (no viewer yet): the ward's given
   * name and the inviter's name, both only if neither is protected.
   */
  invitationLanding(
    ward: PresentablePerson | null,
    inviter: PresentablePerson | null,
  ): { wardGivenName: string | null; inviterName: string | null } {
    if (!ward || !inviter || ward.protectedIdentity || inviter.protectedIdentity) {
      return { wardGivenName: null, inviterName: null };
    }
    return {
      wardGivenName: ward.givenName,
      inviterName: this.people.presentSelf(inviter).displayName,
    };
  }

  /** People of a merge or duplicate notice the viewer may see, by ID. */
  async byId(
    authorization: RequestAuthorization,
    rows: readonly PresentablePerson[],
  ): Promise<Map<string, PersonSummary>> {
    return new Map((await this.people.present(authorization, null, rows)).map((p) => [p.id, p]));
  }
}
