// SPDX-License-Identifier: AGPL-3.0-only
// The core domain services wired by hand (the same graph Nest builds in
// DomainModule), for code that runs without Nest: the demo seed
// (src/seed) and integration tests (testing/services.ts).

import type { Database } from "@clubadmin/db";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";

import { AccountsService } from "./modules/accounts/index.ts";
import { ActivitiesService, AttendanceService } from "./modules/activities/index.ts";
import { AdministratorsService } from "./modules/administrators/index.ts";
import { ClubProfilesService } from "./modules/club-profiles/index.ts";
import { ClubsService } from "./modules/clubs/index.ts";
import { EventsService } from "./modules/events/index.ts";
import { GroupsService } from "./modules/groups/index.ts";
import { GuardianshipsService } from "./modules/guardianships/index.ts";
import {
  InvitationsService,
  JoinRequestsService,
  WaitlistsService,
} from "./modules/joining/index.ts";
import { MemberImportsService, MemberIntakeService } from "./modules/members/index.ts";
import { MembershipsService } from "./modules/memberships/index.ts";
import { OnboardingService } from "./modules/onboarding/index.ts";
import { PeopleService } from "./modules/people/index.ts";
import { PersonMergeService } from "./modules/person-merge/index.ts";
import {
  ClubPrivacyService,
  ConsentsService,
  DataExportsService,
  ErasureService,
  LeavingService,
  type OutstandingObligationsProvider,
} from "./modules/privacy/index.ts";
import { ClubRolesService, RolesService } from "./modules/roles/index.ts";
import type { FieldEncryption } from "./platform/crypto/field-encryption.ts";

export interface CoreServices {
  encryption: FieldEncryption;
  people: PeopleService;
  merge: PersonMergeService;
  accounts: AccountsService;
  clubs: ClubsService;
  onboarding: OnboardingService;
  roles: RolesService;
  /** Club-defined roles (P1.15 A2). */
  clubRoles: ClubRolesService;
  /** At least two administrators; suspensions (P1.15 A3). */
  administrators: AdministratorsService;
  profiles: ClubProfilesService;
  groups: GroupsService;
  memberships: MembershipsService;
  guardianships: GuardianshipsService;
  joinRequests: JoinRequestsService;
  waitlists: WaitlistsService;
  invitations: InvitationsService;
  intake: MemberIntakeService;
  imports: MemberImportsService;
  activities: ActivitiesService;
  attendance: AttendanceService;
  events: EventsService;
  consents: ConsentsService;
  clubPrivacy: ClubPrivacyService;
  leaving: LeavingService;
  dataExports: DataExportsService;
  erasure: ErasureService;
}

export function createCoreServices(
  db: Database,
  options: {
    encryption: FieldEncryption;
    defaultCountry?: string;
    invitationTokenKey?: string;
    webUrl?: string;
    storage?: ObjectStorage | null;
    /** What members owe their clubs (P1.8a; tests register a fake). */
    obligations?: readonly OutstandingObligationsProvider[];
    /** Days before a scheduled erasure runs (ERASURE_GRACE_DAYS, P1.8b). */
    erasureGraceDays?: number;
  },
): CoreServices {
  const { encryption } = options;
  const people = new PeopleService(db, encryption);
  const clubs = new ClubsService(db);
  const roles = new RolesService(db, clubs);
  const profiles = new ClubProfilesService(db);
  const groups = new GroupsService(db, clubs);
  const memberships = new MembershipsService(db, { clubs, profiles, groups, roles });
  const defaultCountry = options.defaultCountry ?? "SE";
  const accounts = new AccountsService(db, {
    people,
    memberships,
    clubs,
    defaultCountry,
    invitationTokenKey: options.invitationTokenKey,
  });
  const joinRequests = new JoinRequestsService(db, { clubs, groups, memberships, accounts });
  const invitations = new InvitationsService(db, {
    clubs,
    groups,
    memberships,
    roles,
    accounts,
    joinRequests,
    tokenKey: options.invitationTokenKey,
    webUrl: options.webUrl ?? "https://clubadmin.localhost",
  });
  const waitlists = new WaitlistsService(db, { clubs, groups, memberships, accounts });
  const guardianships = new GuardianshipsService(db, {
    people,
    accounts,
    memberships,
    tokenKey: options.invitationTokenKey,
  });
  const intake = new MemberIntakeService(db, {
    people,
    memberships,
    groups,
    guardianships,
    accounts,
    clubs,
  });
  const activities = new ActivitiesService(db, clubs);
  const attendance = new AttendanceService(db, { clubs, people, memberships });
  const events = new EventsService(db, { clubs, activities, attendance, encryption });
  const consents = new ConsentsService(db, { clubs });
  return {
    encryption,
    activities,
    attendance,
    events,
    consents,
    clubPrivacy: new ClubPrivacyService(db, { clubs }),
    dataExports: new DataExportsService(db, { storage: options.storage ?? null }),
    erasure: new ErasureService(db, {
      graceDays: options.erasureGraceDays ?? 14,
      obligations: options.obligations ?? [],
    }),
    leaving: new LeavingService(db, {
      clubs,
      roles,
      groups,
      memberships,
      joinRequests,
      events,
      consents,
      obligations: options.obligations ?? [],
    }),
    people,
    merge: new PersonMergeService(db, { people, profiles }),
    accounts,
    clubs,
    onboarding: new OnboardingService(db, {
      clubs,
      memberships,
      roles,
      people,
      accounts,
      invitations,
      defaultCountry,
    }),
    joinRequests,
    waitlists,
    invitations,
    roles,
    clubRoles: new ClubRolesService(db, clubs, roles),
    administrators: new AdministratorsService(db),
    profiles,
    groups,
    memberships,
    guardianships,
    intake,
    imports: new MemberImportsService(
      db,
      {
        storage: options.storage ?? null,
        encryption,
        intake,
        people,
        clubs,
        groups,
        profiles,
      },
      { importsPerClubPerDay: 1000, invitationsPerClubPerDay: 10_000, batchConcurrency: 4 },
    ),
  };
}
