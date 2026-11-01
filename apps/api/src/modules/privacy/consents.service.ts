// SPDX-License-Identifier: AGPL-3.0-only
// Consents (P1.8a, ADR 0041): given and withdrawn per purpose and club, by
// the person from the consent age, by full guardians for younger wards, and
// recorded by the club from a paper form. Withdrawing is as easy as giving
// and takes effect at once. Texts are versioned: a consent records the
// version agreed to; a club's new version revokes older consents only if the
// club decided so (consent_reconfirm_on_new_version).

import { type AgeRules, getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type ConsentPurpose,
  CONTACT_PURPOSES,
  type GiveConsentInput,
  GiveConsentSchema,
  type GroupConsentsQuery,
  type PublishConsentTextInput,
  PublishConsentTextSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { Club, ClubsService } from "../clubs/index.ts";
import {
  type ConsentCaller,
  consentRights,
  currentTextVersion,
  giveRefusal,
  isApplicable,
} from "./consent-rules.ts";
import * as repo from "./privacy.repository.ts";

export type { ConsentCaller } from "./consent-rules.ts";

const DEFAULT_AGE_RULES: AgeRules = { consentAge: 13, ownAccountMinAge: 13, adultAge: 18 };
export const ageRulesOf = (country: string): AgeRules =>
  isSupportedCountry(country) ? getCountryPack(country).ageRules : DEFAULT_AGE_RULES;

/** One purpose of one person in one club, with what the caller may do. */
export interface PurposeStatus {
  purpose: ConsentPurpose;
  applicable: boolean;
  open: repo.ConsentRow | null;
  /** The open consent was given for the club's current text. */
  current: boolean;
  mayGive: boolean;
  mayWithdraw: boolean;
}

export interface ClubTexts {
  clubId: string;
  clubName: string;
  defaultLocale: string;
  purposes: ConsentPurpose[];
  /** The club's latest text per purpose (none: the platform default). */
  texts: Map<ConsentPurpose, repo.ConsentTextRow>;
}

export interface ConsentOverview {
  clubs: (ClubTexts & {
    people: { personId: string; caller: ConsentCaller; purposes: PurposeStatus[] }[];
  })[];
}

export class ConsentsService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly now: () => Date;

  constructor(db: Database, deps: { clubs: ClubsService }, now: () => Date = () => new Date()) {
    this.db = db;
    this.clubs = deps.clubs;
    this.now = now;
  }

  /**
   * The consents of the caller and the wards they decide for, per club the
   * caller or a ward is a member of (GET /me/consents). In a ward's club
   * where the caller is not a member, the caller decides only their own
   * contact purposes (their phone shown on the ward's card).
   */
  overview(context: ActorContext, wardIds: readonly string[]): Promise<ConsentOverview> {
    const me = actorPersonId(context);
    const people = [me, ...wardIds.filter((id) => id !== me)];
    return this.db.withActor(context, async (tx) => {
      const memberships = await repo.memberClubs(tx, people);
      const clubIds = [...new Set(memberships.map((m) => m.clubId))];
      const consents = await repo.openConsents(tx, people, clubIds);
      const texts = await repo.latestTexts(tx, clubIds);
      const myFacts =
        memberships.find((m) => m.personId === me) ?? (await repo.personFacts(tx, me));
      const now = this.now();
      const clubs = new Map<string, ConsentOverview["clubs"][number]>();
      for (const m of memberships) {
        let club = clubs.get(m.clubId);
        if (!club) {
          club = {
            clubId: m.clubId,
            clubName: m.clubName,
            defaultLocale: m.defaultLocale,
            purposes: m.consentPurposes,
            texts: new Map(texts.filter((t) => t.clubId === m.clubId).map((t) => [t.purpose, t])),
            people: [],
          };
          clubs.set(m.clubId, club);
        }
        club.people.push({
          personId: m.personId,
          caller: m.personId === me ? "self" : "guardian",
          purposes: this.statuses(
            m.personId === me ? "self" : "guardian",
            club,
            { ...m, ageRules: ageRulesOf(m.country) },
            consents.filter((c) => c.clubId === m.clubId && c.personId === m.personId),
            now,
          ),
        });
      }
      // The caller's own contact purposes in their wards' clubs.
      for (const club of clubs.values()) {
        if (club.people.some((p) => p.personId === me)) continue;
        const asked = club.purposes.filter((p) =>
          (CONTACT_PURPOSES as readonly string[]).includes(p),
        );
        if (asked.length === 0) continue;
        const country = memberships.find((m) => m.clubId === club.clubId)!.country;
        club.people.unshift({
          personId: me,
          caller: "self",
          purposes: this.statuses(
            "self",
            { ...club, purposes: asked },
            {
              birthDate: myFacts?.birthDate ?? null,
              protected: myFacts?.protected ?? false,
              ageRules: ageRulesOf(country),
            },
            consents.filter((c) => c.clubId === club.clubId && c.personId === me),
            now,
          ),
        });
      }
      return { clubs: [...clubs.values()] };
    });
  }

  private statuses(
    caller: ConsentCaller,
    club: Pick<ClubTexts, "purposes" | "texts">,
    person: { birthDate: string | null; protected: boolean; ageRules: AgeRules },
    open: readonly repo.ConsentRow[],
    now: Date,
  ): PurposeStatus[] {
    // Asked purposes, then any purpose with an open consent the club no longer asks for.
    const purposes = [
      ...club.purposes,
      ...open.map((c) => c.purpose).filter((p) => !club.purposes.includes(p)),
    ];
    return purposes.map((purpose) => {
      const consent = open.find((c) => c.purpose === purpose) ?? null;
      const rights = consentRights(
        caller,
        { purpose, asked: club.purposes.includes(purpose), open: consent !== null, ...person },
        now,
      );
      return {
        purpose,
        applicable: isApplicable(purpose, person.protected),
        open: consent,
        current:
          consent !== null &&
          consent.textVersion ===
            currentTextVersion(purpose, club.texts.get(purpose)?.version ?? null),
        ...rights,
      };
    });
  }

  /** One person's consents in the club, with the history (GET /people/:personId/consents). */
  personConsents(
    context: TenantContext,
    personId: string,
    caller: ConsentCaller | "leader",
  ): Promise<{ club: ClubTexts; statuses: PurposeStatus[]; history: repo.ConsentRow[] }> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubTextsInTx(tx, context.clubId);
      const [subject] = await repo.subjects(tx, context.clubId, [personId]);
      if (!subject) throw new DomainError("not_found");
      const history = await repo.consentHistory(tx, context.clubId, personId);
      const open = history.filter((c) => c.revokedAt === null);
      const statuses = this.statuses(
        caller === "leader" ? "admin" : caller,
        club,
        { ...subject, ageRules: ageRulesOf(club.country) },
        open,
        this.now(),
      ).map((s) => (caller === "leader" ? { ...s, mayGive: false, mayWithdraw: false } : s));
      return { club, statuses, history: caller === "leader" ? [] : history };
    });
  }

  private async clubTextsInTx(
    tx: Tx,
    clubId: string,
  ): Promise<ClubTexts & { country: string; club: Club }> {
    const club = await this.clubs.getClubInTx(tx, clubId);
    const texts = await repo.latestTexts(tx, [clubId]);
    return {
      clubId,
      clubName: club.name,
      defaultLocale: club.defaultLocale,
      purposes: club.consentPurposes,
      texts: new Map(texts.map((t) => [t.purpose, t])),
      country: club.country,
      club,
    };
  }

  /**
   * Gives a consent for the club's current text (idempotent). A consent of
   * an older text is replaced. Registrars and managers record a paper
   * consent with a note (source club_record).
   */
  give(
    context: TenantContext,
    caller: ConsentCaller,
    personId: string,
    purpose: ConsentPurpose,
    input: GiveConsentInput,
  ): Promise<void> {
    const by = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(GiveConsentSchema, input);
      if (caller === "admin" ? !data.clubNote : data.clubNote !== undefined) {
        throw new DomainError("invalid_input");
      }
      const club = await this.clubTextsInTx(tx, context.clubId);
      const [subject] = await repo.subjects(tx, context.clubId, [personId]);
      if (!subject) throw new DomainError("not_found");
      // Contact purposes: a guardian's own details on a ward's card need no membership.
      if (!subject.member && !(CONTACT_PURPOSES as readonly string[]).includes(purpose)) {
        throw new DomainError("not_a_member");
      }
      const refusal = giveRefusal(
        caller,
        {
          purpose,
          asked: club.purposes.includes(purpose),
          protected: subject.protected,
          birthDate: subject.birthDate,
          ageRules: ageRulesOf(club.country),
        },
        this.now(),
      );
      if (refusal) throw new DomainError(refusal);
      const current = currentTextVersion(purpose, club.texts.get(purpose)?.version ?? null);
      if (data.textVersion !== current) throw new DomainError("consent_text_outdated");

      const open = await repo.lockOpenConsent(tx, context.clubId, personId, purpose);
      if (open?.textVersion === current) return;
      if (open) {
        await repo.revokeConsents(
          tx,
          { clubId: context.clubId, personId, purposes: [purpose] },
          by,
          "superseded",
        );
      }
      const row = await repo.insertConsent(tx, {
        clubId: context.clubId,
        personId,
        purpose,
        textVersion: current,
        givenByPersonId: by,
        source: caller === "admin" ? "club_record" : caller,
        clubNote: data.clubNote ?? null,
      });
      await audit.record(tx, {
        action: caller === "admin" ? "consent.recorded" : "consent.given",
        resourceType: "consent",
        resourceId: row.id,
        changedFields: ["purpose", "text_version", "source"],
      });
      await outbox.publish(tx, "consent.changed", { clubId: context.clubId, personId, purpose });
    });
  }

  /** Withdraws a consent at once (idempotent). */
  withdraw(
    context: TenantContext,
    caller: ConsentCaller,
    personId: string,
    purpose: ConsentPurpose,
  ): Promise<void> {
    const by = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const open = await repo.lockOpenConsent(tx, context.clubId, personId, purpose);
      if (!open) return;
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const [subject] = await repo.subjects(tx, context.clubId, [personId]);
      if (!subject) throw new DomainError("not_found");
      const { mayWithdraw } = consentRights(
        caller,
        {
          purpose,
          asked: true,
          open: true,
          protected: subject.protected,
          birthDate: subject.birthDate,
          ageRules: ageRulesOf(club.country),
        },
        this.now(),
      );
      if (!mayWithdraw) throw new DomainError("consent_age_required");
      await repo.revokeConsents(
        tx,
        { clubId: context.clubId, personId, purposes: [purpose] },
        by,
        "withdrawn",
      );
      await audit.record(tx, {
        action: "consent.withdrawn",
        resourceType: "consent",
        resourceId: open.id,
        changedFields: ["revoked_at", "revoked_reason"],
      });
      await outbox.publish(tx, "consent.changed", { clubId: context.clubId, personId, purpose });
    });
  }

  /** Open contact consents of people in the club (field visibility, P1.8a). */
  contactConsentsOf(
    context: TenantContext,
    personIds: readonly string[],
  ): Promise<Map<string, Set<ConsentPurpose>>> {
    if (personIds.length === 0) return Promise.resolve(new Map<string, Set<ConsentPurpose>>());
    return this.db.withTenant(context, (tx) =>
      repo.consentedAmong(tx, context.clubId, CONTACT_PURPOSES, personIds),
    );
  }

  /** Ends the person's open consents in the club when they leave it (P1.8a). */
  async revokeForLeavingInTx(tx: Tx, context: TenantContext, personId: string): Promise<number> {
    const revoked = await repo.revokeConsents(
      tx,
      { clubId: context.clubId, personId },
      context.personId ?? null,
      "left_club",
    );
    for (const r of revoked) {
      await audit.record(tx, {
        action: "consent.withdrawn",
        resourceType: "consent",
        resourceId: r.id,
        changedFields: ["revoked_at", "revoked_reason"],
      });
      await outbox.publish(tx, "consent.changed", {
        clubId: context.clubId,
        personId,
        purpose: r.purpose,
      });
    }
    return revoked.length;
  }

  /** The consent overview of a group (leaders): a page of members and counts of all. */
  groupConsents(
    context: TenantContext,
    groupId: string,
    query: GroupConsentsQuery,
  ): Promise<{
    purposes: ConsentPurpose[];
    counts: { purpose: ConsentPurpose; consented: number; notApplicable: number; total: number }[];
    items: { personId: string; protected: boolean; given: Set<ConsentPurpose> }[];
    nextCursor: string | null;
  }> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const purposes = query.purpose ? [query.purpose] : club.consentPurposes;
      const rows = await repo.groupConsentsPage(tx, context.clubId, groupId, {
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      const counts = await repo.groupConsentCounts(tx, context.clubId, groupId);
      const items = rows.slice(0, query.limit);
      return {
        purposes,
        counts: purposes.map((purpose) => {
          const inapplicable = !isApplicable(purpose, true);
          return {
            purpose,
            consented: counts.consented.get(purpose) ?? 0,
            notApplicable: inapplicable ? counts.protected : 0,
            total: counts.total,
          };
        }),
        items: items.map((r) => ({
          personId: r.personId,
          protected: r.protected,
          given: new Set(r.purposes),
        })),
        nextCursor: rows.length > query.limit ? items.at(-1)!.personId : null,
      };
    });
  }

  /** The club's published versions of a purpose's text (newest first). */
  textVersions(context: TenantContext, purpose: ConsentPurpose): Promise<repo.ConsentTextRow[]> {
    return this.db.withTenant(context, (tx) => repo.textVersions(tx, context.clubId, purpose));
  }

  /**
   * Publishes the club's next version of a purpose's text. With
   * consent_reconfirm_on_new_version, open consents of older versions are
   * revoked (superseded) in the same transaction and families are asked
   * again.
   */
  publishText(
    context: TenantContext,
    input: PublishConsentTextInput,
  ): Promise<repo.ConsentTextRow> {
    const by = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(PublishConsentTextSchema, input);
      const club = await this.clubs.lockClubInTx(tx, context.clubId);
      const language = club.defaultLocale.slice(0, 2) as "sv" | "en" | "nb";
      // At least the club's own language (or any language for a club in another one).
      if (
        ["sv", "en", "nb"].includes(language)
          ? !data.texts[language]
          : Object.keys(data.texts).length === 0
      ) {
        throw new DomainError("consent_text_language_required");
      }
      const row = await repo.insertText(tx, {
        clubId: context.clubId,
        purpose: data.purpose,
        texts: Object.fromEntries(
          Object.entries(data.texts).filter(([, text]) => text !== undefined),
        ),
        publishedByPersonId: by,
      });
      await audit.record(tx, {
        action: "consent_text.published",
        resourceType: "consent_text",
        resourceId: row.id,
        changedFields: ["purpose", "version", ...Object.keys(data.texts).map((l) => `texts.${l}`)],
      });
      if (club.consentReconfirmOnNewVersion) {
        const revoked = await repo.revokeConsents(
          tx,
          {
            clubId: context.clubId,
            purposes: [data.purpose],
            exceptTextVersion: `club:${row.version}`,
          },
          by,
          "superseded",
        );
        for (const r of revoked) {
          await outbox.publish(tx, "consent.changed", {
            clubId: context.clubId,
            personId: r.personId,
            purpose: r.purpose,
          });
        }
      }
      return row;
    });
  }
}
