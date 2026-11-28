// SPDX-License-Identifier: AGPL-3.0-only
// Sweden's begränsat registerutdrag for work with children in sport, as a
// background-check plugin (ADR 0051 decision 6, P2.8). Sources (consulted
// 2026-11-28, README.md):
// - Lag (2013:852) om registerkontroll av personer som ska arbeta med barn:
//   a right to ask for the extract ("arbete med barn i annan verksamhet än
//   skola och barnomsorg", Polisen's form 442.14 or the e-service), not a
//   duty under law.
// - Riksidrottsförbundet's statutes 5.8 and "Lathund registerutdrag" (RF,
//   2023): since 1 January 2020 every club checks the extract of everyone
//   from 15 with direct and regular contact with children; the original is
//   shown and handed back, nothing is filed.
// - Polisen: the extract may be at most six months old when shown; a digital
//   extract is shown from the person's digital mailbox (Polisen's check
//   service needs a person at the screen, so no integration); the club keeps
//   no copy and no result of a check.
// RF sets no re-check interval: the club sets one (its stricter
// requirements, P2.8). The person orders and pays nothing to the club; the
// plugin never sees the extract, only the issue date the verifier reads off.

import { type CheckType, definePlugin, type PresentedInput } from "@clubadmin/plugin-api";

import { TEXTS } from "./texts.ts";

const TYPE = "extract";
/** At most six months old when shown (Polisen). */
const MAX_AGE_MONTHS = 6;

const EXTRACT: CheckType = {
  key: TYPE,
  name: "se.bc.extract",
  initiator: "person",
  maxAgeDaysWhenPresented: 183,
  recheckMonths: null,
  minAge: 15,
  copyRetention: "none",
  methods: ["viewed", "digital_mailbox"],
  cost: null,
  integration: "none",
};

/** The date six calendar months after `date` (ISO), the extract's last day to be shown. */
export function lastDayToShow(issuedOn: string): string {
  const d = new Date(`${issuedOn}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + MAX_AGE_MONTHS);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export const seBackgroundCheck = definePlugin({
  manifest: {
    id: "se.rf.registerutdrag",
    version: "1.0.0",
    publisher: "ClubAdmin",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["background-checks"],
    regions: ["SE"],
    data: [],
    texts: TEXTS,
  },
  backgroundChecks: {
    checkTypes: () => Promise.resolve([EXTRACT]),
    requirements: () =>
      Promise.resolve([
        {
          category: "regular_contact_with_children",
          checkType: TYPE,
          level: "required",
          basis: "se.bc.basis.rf",
        },
        {
          category: "alone_with_children",
          checkType: TYPE,
          level: "required",
          basis: "se.bc.basis.rf",
        },
        { category: "overnight", checkType: TYPE, level: "required", basis: "se.bc.basis.rf" },
        { category: "board", checkType: TYPE, level: "recommended", basis: "se.bc.basis.club" },
      ]),
    // The verifier reads the issue date off the extract they are shown; a
    // negative outcome is never entered (the role ends without a reason).
    verifyPresented: (ctx, input: PresentedInput) => {
      if (input.checkType !== TYPE) {
        return Promise.resolve({ outcome: "not_verified" as const, reason: "se.bc.wrong_type" });
      }
      const today = ctx.now().toISOString().slice(0, 10);
      if (input.issuedOn > today) {
        return Promise.resolve({ outcome: "not_verified" as const, reason: "se.bc.future" });
      }
      if (lastDayToShow(input.issuedOn) < today) {
        return Promise.resolve({ outcome: "not_verified" as const, reason: "se.bc.too_old" });
      }
      return Promise.resolve({
        outcome: "verified" as const,
        result: {
          checkType: TYPE,
          issuingCountry: "SE",
          issuedOn: input.issuedOn,
          method: input.method === "digital_mailbox" ? "digital_mailbox" : "viewed",
          validUntil: null,
        },
      });
    },
  },
});
