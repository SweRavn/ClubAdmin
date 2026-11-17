// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the car-pools module (P2.5, ADR 0048): an activity's
// car pool, offers and bookings, the rule of two, "Mina samåkningar" and
// the group's statistics.
export { CarpoolsModule } from "./carpools.module.ts";
export { CARPOOL_PERSON_REFERENCES } from "./carpools.references.ts";
export { CarpoolsService, type DriveRow } from "./carpools.service.ts";
