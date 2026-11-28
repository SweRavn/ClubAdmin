// SPDX-License-Identifier: AGPL-3.0-only
// Norway's politiattest (barneomsorgsattest) in sport, as a background-check
// plugin (ADR 0051 decision 6, P2.8). Sources (consulted 2026-11-28,
// README.md): Norges idrettsforbund's pages on politiattest, politiregister-
// loven §§ 37 and 39, politiregisterforskriften § 34-1, Idrettsstyret's
// decisions of 2008 and 2017 (sak 185).
// - The club confirms the purpose (bekreftelse på formål); the person
//   applies to the police (or through NIF's digital service) and shows the
//   attest to the club's politiattestansvarlig, on paper or in the digital
//   mailbox. The club records only that a certificate without remarks was
//   seen and when; never a copy, never a remark (a certificate with remarks
//   closes the case without a reason).
// - From 15 years. No periodic renewal (the police issue no new attest for
//   the same role in the same club); a new one after a break of more than
//   five months or in a new club, which the host sees as a missing record.
//   No maximum age is set by NIF.
// The confirmation of purpose is the request (initiator `club`): it is
// recorded in the plugin's state; there is no remote service to ask.

import {
  type CheckType,
  definePlugin,
  type PresentedInput,
  type RequestState,
} from "@clubadmin/plugin-api";

import { TEXTS } from "./texts.ts";

const TYPE = "attest";

const ATTEST: CheckType = {
  key: TYPE,
  name: "no.bc.attest",
  initiator: "club",
  maxAgeDaysWhenPresented: null,
  recheckMonths: null,
  minAge: 15,
  copyRetention: "none",
  methods: ["viewed", "digital_mailbox"],
  cost: null,
  integration: "none",
};

const requested = (reference: string): RequestState => ({
  reference,
  status: "requested",
  result: null,
});

export const noBackgroundCheck = definePlugin({
  manifest: {
    id: "no.nif.politiattest",
    version: "1.0.0",
    publisher: "ClubAdmin",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["background-checks"],
    regions: ["NO"],
    data: [],
    texts: TEXTS,
  },
  backgroundChecks: {
    checkTypes: () => Promise.resolve([ATTEST]),
    requirements: () =>
      Promise.resolve([
        {
          category: "regular_contact_with_children",
          checkType: TYPE,
          level: "required",
          basis: "no.bc.basis.nif",
        },
        {
          category: "alone_with_children",
          checkType: TYPE,
          level: "required",
          basis: "no.bc.basis.nif",
        },
        { category: "overnight", checkType: TYPE, level: "required", basis: "no.bc.basis.nif" },
        { category: "board", checkType: TYPE, level: "recommended", basis: "no.bc.basis.club" },
      ]),
    // The club's confirmation of purpose: the person applies with it.
    startRequest: async (ctx, input) => {
      const reference = `purpose-${input.personId}-${ctx.now().toISOString().slice(0, 10)}`;
      await ctx.state.set(reference, { status: "requested" });
      return requested(reference);
    },
    // Nothing to ask remotely: the request stays requested until the
    // attest is shown and recorded (the host closes it then).
    requestStatus: (_ctx, reference) => Promise.resolve(requested(reference)),
    verifyPresented: (ctx, input: PresentedInput) => {
      if (input.checkType !== TYPE) {
        return Promise.resolve({ outcome: "not_verified" as const, reason: "no.bc.wrong_type" });
      }
      if (input.issuedOn > ctx.now().toISOString().slice(0, 10)) {
        return Promise.resolve({ outcome: "not_verified" as const, reason: "no.bc.future" });
      }
      return Promise.resolve({
        outcome: "verified" as const,
        result: {
          checkType: TYPE,
          issuingCountry: "NO",
          issuedOn: input.issuedOn,
          method: input.method === "digital_mailbox" ? "digital_mailbox" : "viewed",
          validUntil: null,
        },
      });
    },
  },
});
