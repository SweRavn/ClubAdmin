// SPDX-License-Identifier: AGPL-3.0-only
// Background-check fixtures (P2.7 tests, item 5): one plugin per country,
// modelling who starts a check, how old a certificate may be, how often to
// check again, how it is verified and what the host keeps. Test tree only.

import { definePlugin, type PluginContext, type PresentedInput } from "../../src/index.ts";
import { texts } from "./util.ts";

const DAY = 86_400_000;
const daysBetween = (from: string, to: Date) =>
  Math.floor((to.getTime() - Date.parse(`${from}T00:00:00Z`)) / DAY);
const addMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};
const today = (ctx: PluginContext) => ctx.now().toISOString().slice(0, 10);

const COMMON = {
  version: "0.1.0",
  publisher: "ClubAdmin tests",
  licence: "AGPL-3.0-only",
  pluginApi: "^1.0.0",
  capabilities: ["background-checks" as const],
};

/**
 * Sweden: the person orders an extract from the police and shows it; at
 * most six months old; the verification code is checked with the police's
 * service during the call and never kept or returned.
 */
export const seCheck = definePlugin({
  manifest: {
    ...COMMON,
    id: "se.test.belastningsregister",
    regions: ["SE"],
    data: [],
    network: ["verify.polisen.example"],
    texts: texts({
      "se.extract": "Utdrag ur belastningsregistret",
      "se.too_old": "Older than six months",
      "se.code_rejected": "The code was not accepted",
      "se.law": "Lag (2013:852)",
    }),
  },
  backgroundChecks: {
    checkTypes: async () => [
      {
        key: "extract",
        name: "se.extract",
        initiator: "person",
        maxAgeDaysWhenPresented: 183,
        recheckMonths: null,
        minAge: 15,
        copyRetention: "none",
        methods: ["viewed", "code_lookup"],
        cost: null,
        integration: "available",
      },
    ],
    requirements: async () => [
      {
        category: "regular_contact_with_children",
        checkType: "extract",
        level: "required",
        basis: "se.law",
      },
    ],
    verifyPresented: async (ctx, input: PresentedInput) => {
      if (daysBetween(input.issuedOn, ctx.now()) > 183)
        return { outcome: "not_verified", reason: "se.too_old" };
      let method: "viewed" | "code_lookup" = "viewed";
      if (input.code) {
        const res = await ctx.http.request("https://verify.polisen.example/check", {
          method: "POST",
          body: JSON.stringify({ code: input.code }),
        });
        if (res.status !== 200) return { outcome: "not_verified", reason: "se.code_rejected" };
        const body = JSON.parse(res.body) as { clean: boolean };
        if (!body.clean) return { outcome: "closed" };
        method = "code_lookup";
      }
      return {
        outcome: "verified",
        result: {
          checkType: "extract",
          issuingCountry: "SE",
          issuedOn: input.issuedOn,
          method,
          validUntil: null,
        },
      };
    },
  },
});

/**
 * Norway: the club requests a police certificate (politiattest) with the
 * person's consent; from 15 years; the club sees the result in a digital
 * mailbox. Request state lives in the plugin's state per club.
 */
export const noCheck = definePlugin({
  manifest: {
    ...COMMON,
    id: "no.test.politiattest",
    regions: ["NO"],
    data: ["birthDate"],
    texts: texts({
      "no.attest": "Politiattest",
      "no.law": "Politiregisterloven § 39",
    }),
  },
  backgroundChecks: {
    checkTypes: async () => [
      {
        key: "attest",
        name: "no.attest",
        initiator: "club",
        maxAgeDaysWhenPresented: 90,
        recheckMonths: null,
        minAge: 15,
        copyRetention: "none",
        methods: ["digital_mailbox"],
        cost: null,
        integration: "stubbed",
      },
    ],
    requirements: async () => [
      {
        category: "regular_contact_with_children",
        checkType: "attest",
        level: "required",
        basis: "no.law",
      },
      { category: "overnight", checkType: "attest", level: "required", basis: "no.law" },
    ],
    startRequest: async (ctx, input) => {
      const reference = `req-${input.personId}`;
      await ctx.state.set(reference, { status: "consent_pending", step: 0 });
      return { reference, status: "consent_pending", result: null };
    },
    requestStatus: async (ctx, reference) => {
      const state = (await ctx.state.get(reference)) as { status: string; step: number } | null;
      // Each call moves one step: consent given, submitted, result, verified.
      const steps = ["consent_pending", "submitted", "result_available", "verified"] as const;
      const step = Math.min((state?.step ?? 0) + 1, steps.length - 1);
      await ctx.state.set(reference, { status: steps[step]!, step });
      const status = steps[step]!;
      return {
        reference,
        status,
        result:
          status === "verified"
            ? {
                checkType: "attest",
                issuingCountry: "NO",
                issuedOn: today(ctx),
                method: "digital_mailbox",
                validUntil: null,
              }
            : null,
      };
    },
  },
});

/** Germany: the person presents an erweitertes Führungszeugnis at most three months old; again after five years. */
export const deCheck = definePlugin({
  manifest: {
    ...COMMON,
    id: "de.test.fuehrungszeugnis",
    regions: ["DE"],
    data: [],
    texts: texts({
      "de.efz": "Erweitertes Führungszeugnis",
      "de.too_old": "Older than three months",
      "de.law": "§ 72a SGB VIII",
    }),
  },
  backgroundChecks: {
    checkTypes: async () => [
      {
        key: "efz",
        name: "de.efz",
        initiator: "person",
        maxAgeDaysWhenPresented: 92,
        recheckMonths: 60,
        minAge: 14,
        copyRetention: "none",
        methods: ["viewed"],
        cost: null,
        integration: "none",
      },
    ],
    requirements: async () => [
      {
        category: "regular_contact_with_children",
        checkType: "efz",
        level: "required",
        basis: "de.law",
      },
      { category: "overnight", checkType: "efz", level: "required", basis: "de.law" },
    ],
    verifyPresented: async (ctx, input) =>
      daysBetween(input.issuedOn, ctx.now()) > 92
        ? { outcome: "not_verified", reason: "de.too_old" }
        : {
            outcome: "verified",
            result: {
              checkType: "efz",
              issuingCountry: "DE",
              issuedOn: input.issuedOn,
              method: "viewed",
              validUntil: addMonths(today(ctx), 60),
            },
          },
  },
});

/** France: the federation checks its licensees automatically each season (honorabilité) and reports a feed. */
export const frCheck = definePlugin({
  manifest: {
    ...COMMON,
    id: "fr.test.honorabilite",
    regions: ["FR"],
    data: ["personalIdentityNumber"],
    network: ["api.federation.example"],
    texts: texts({
      "fr.honorabilite": "Contrôle d'honorabilité",
      "fr.law": "Code du sport L.212-9",
    }),
  },
  backgroundChecks: {
    checkTypes: async () => [
      {
        key: "honorabilite",
        name: "fr.honorabilite",
        initiator: "federation",
        maxAgeDaysWhenPresented: null,
        recheckMonths: 12,
        minAge: 18,
        copyRetention: "none",
        methods: ["federation_feed"],
        cost: null,
        integration: "available",
      },
    ],
    requirements: async () => [
      {
        category: "regular_contact_with_children",
        checkType: "honorabilite",
        level: "required",
        basis: "fr.law",
      },
      { category: "board", checkType: "honorabilite", level: "required", basis: "fr.law" },
    ],
    feed: async (ctx, since, people) => {
      const res = await ctx.http.request(`https://api.federation.example/checked?since=${since}`);
      const checked = new Set(
        (JSON.parse(res.body) as { licence: string }[]).map((r) => r.licence),
      );
      return people
        .filter((p) => p.personalIdentityNumber && checked.has(p.personalIdentityNumber))
        .map((p) => ({
          personId: p.id,
          result: {
            checkType: "honorabilite",
            issuingCountry: "FR",
            issuedOn: since,
            method: "federation_feed" as const,
            validUntil: addMonths(since, 12),
          },
        }));
    },
  },
});

/** Ireland: the organisation applies (Garda vetting) and receives the result itself. */
export const ieCheck = definePlugin({
  manifest: {
    ...COMMON,
    id: "ie.test.garda",
    regions: ["IE"],
    data: ["birthDate"],
    texts: texts({ "ie.vetting": "Garda vetting", "ie.law": "National Vetting Bureau Act 2012" }),
  },
  backgroundChecks: {
    checkTypes: async () => [
      {
        key: "vetting",
        name: "ie.vetting",
        initiator: "club",
        maxAgeDaysWhenPresented: null,
        recheckMonths: 36,
        minAge: 16,
        copyRetention: "until_verified",
        methods: ["received_by_club"],
        cost: null,
        integration: "none",
      },
    ],
    requirements: async () => [
      {
        category: "regular_contact_with_children",
        checkType: "vetting",
        level: "required",
        basis: "ie.law",
      },
    ],
    startRequest: async (_ctx, input) => ({
      reference: `ie-${input.personId}`,
      status: "requested",
      result: null,
    }),
    requestStatus: async (ctx, reference) => ({
      reference,
      status: "verified",
      result: {
        checkType: "vetting",
        issuingCountry: "IE",
        issuedOn: today(ctx),
        method: "received_by_club",
        validUntil: addMonths(today(ctx), 36),
      },
    }),
  },
});

/** Spain: the person shows a certificado de delitos sexuales; its CSV code is looked up. */
export const esCheck = definePlugin({
  manifest: {
    ...COMMON,
    id: "es.test.delitos-sexuales",
    regions: ["ES"],
    data: [],
    network: ["sede.mjusticia.example"],
    texts: texts({
      "es.certificado": "Certificado de delitos de naturaleza sexual",
      "es.code_rejected": "Code not found",
      "es.law": "LO 1/1996 art. 13.5",
    }),
  },
  backgroundChecks: {
    checkTypes: async () => [
      {
        key: "certificado",
        name: "es.certificado",
        initiator: "person",
        maxAgeDaysWhenPresented: null,
        recheckMonths: null,
        minAge: 18,
        copyRetention: "none",
        methods: ["code_lookup"],
        cost: null,
        integration: "available",
      },
    ],
    requirements: async () => [
      {
        category: "regular_contact_with_children",
        checkType: "certificado",
        level: "required",
        basis: "es.law",
      },
    ],
    verifyPresented: async (ctx, input) => {
      const res = await ctx.http.request(
        `https://sede.mjusticia.example/csv/${encodeURIComponent(input.code ?? "")}`,
      );
      if (res.status === 404) return { outcome: "not_verified", reason: "es.code_rejected" };
      if (res.body.includes('"entries":true')) return { outcome: "closed" };
      return {
        outcome: "verified",
        result: {
          checkType: "certificado",
          issuingCountry: "ES",
          issuedOn: input.issuedOn,
          method: "code_lookup",
          validUntil: null,
        },
      };
    },
  },
});
