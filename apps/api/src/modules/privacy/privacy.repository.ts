// SPDX-License-Identifier: AGPL-3.0-only
// Consents, consent texts, board decisions on settings and the club's
// privacy policy versions (P1.8a). Statements start from the club or the
// person (their indexes), never from a whole table (ADR 0040).

import { schema, sql, type Tx } from "@clubadmin/db";
import type {
  ConsentPurpose,
  ConsentRevokedReason,
  ConsentSource,
  DecisionBody,
} from "@clubadmin/shared";

const { consents, clubSettingDecisions } = schema;

export type ConsentRow = typeof consents.$inferSelect;
export type ConsentTextRow = typeof schema.consentTexts.$inferSelect;
export type DecisionRow = typeof clubSettingDecisions.$inferSelect;
export type PolicyRow = typeof schema.clubPrivacyPolicies.$inferSelect;

const iso = (value: Date | string) => new Date(value).toISOString();

/** A person in a club as the consent rules need them. */
export interface ConsentSubject {
  clubId: string;
  personId: string;
  birthDate: string | null;
  /** Effective protected identity in the club (global or club flag). */
  protected: boolean;
  /** An open membership (any status). */
  member: boolean;
}

/** The people's facts in one club: birth date, protection, membership (one statement). */
export async function subjects(
  tx: Tx,
  clubId: string,
  personIds: readonly string[],
): Promise<ConsentSubject[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.execute<{
    person_id: string;
    birth_date: string | null;
    protected: boolean;
    member: boolean;
  }>(sql`
    SELECT p.id AS person_id, p.birth_date::text AS birth_date,
      (p.protected_identity OR coalesce(cp.protected_identity_club, false)) AS protected,
      EXISTS (SELECT 1 FROM public.club_memberships m
              WHERE m.club_id = ${clubId} AND m.person_id = p.id AND m.valid_to IS NULL) AS member
    FROM public.people p
    LEFT JOIN public.club_profiles cp ON cp.club_id = ${clubId} AND cp.person_id = p.id
    WHERE p.id = ANY (${`{${personIds.join(",")}}`}::uuid[])`);
  return rows.map((r) => ({
    clubId,
    personId: r.person_id,
    birthDate: r.birth_date,
    protected: r.protected,
    member: r.member,
  }));
}

/** A person's birth date and global protection (own-relationship policy on people). */
export async function personFacts(
  tx: Tx,
  personId: string,
): Promise<{ birthDate: string | null; protected: boolean } | null> {
  const { rows } = await tx.execute<{ birth_date: string | null; protected_identity: boolean }>(sql`
    SELECT birth_date::text AS birth_date, protected_identity FROM public.people WHERE id = ${personId}`);
  const r = rows[0];
  return r ? { birthDate: r.birth_date, protected: r.protected_identity } : null;
}

/** The clubs a set of people are members of (active or paused), with what the consent pages need. */
export interface MemberClub {
  clubId: string;
  personId: string;
  clubName: string;
  country: string;
  defaultLocale: string;
  consentPurposes: ConsentPurpose[];
  birthDate: string | null;
  protected: boolean;
}

/**
 * The people's open memberships with the club and the person's facts, in
 * one statement (GET /me/consents): through the caller's own-relationship
 * policies on memberships and people, and the insider policy on clubs.
 */
export async function memberClubs(tx: Tx, personIds: readonly string[]): Promise<MemberClub[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.execute<{
    club_id: string;
    person_id: string;
    name: string;
    country: string;
    default_locale: string;
    consent_purposes: ConsentPurpose[];
    birth_date: string | null;
    protected: boolean;
  }>(sql`
    SELECT m.club_id, m.person_id, c.name, c.country, c.default_locale, c.consent_purposes,
      p.birth_date::text AS birth_date,
      (p.protected_identity OR coalesce(cp.protected_identity_club, false)) AS protected
    FROM public.club_memberships m
    JOIN public.clubs c ON c.id = m.club_id
    JOIN public.people p ON p.id = m.person_id
    LEFT JOIN public.club_profiles cp ON cp.club_id = m.club_id AND cp.person_id = m.person_id
    WHERE m.person_id = ANY (${`{${personIds.join(",")}}`}::uuid[]) AND m.valid_to IS NULL
      AND m.status IN ('active', 'paused')
    ORDER BY c.name, m.club_id, m.person_id`);
  return rows.map((r) => ({
    clubId: r.club_id,
    personId: r.person_id,
    clubName: r.name,
    country: r.country,
    defaultLocale: r.default_locale,
    consentPurposes: r.consent_purposes,
    birthDate: r.birth_date,
    protected: r.protected,
  }));
}

/** Open consents of people (in the given clubs, or in the transaction's club). */
export async function openConsents(
  tx: Tx,
  personIds: readonly string[],
  clubIds?: readonly string[],
): Promise<ConsentRow[]> {
  if (personIds.length === 0) return [];
  const people = `{${personIds.join(",")}}`;
  const clubs = clubIds ? `{${clubIds.join(",")}}` : null;
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT * FROM public.consents
    WHERE person_id = ANY (${people}::uuid[]) AND revoked_at IS NULL
      AND (${clubs}::uuid[] IS NULL OR club_id = ANY (${clubs}::uuid[]))
    ORDER BY club_id, person_id, purpose`);
  return rows.map(consentRow);
}

function consentRow(r: Record<string, unknown>): ConsentRow {
  return {
    id: r.id as string,
    clubId: r.club_id as string,
    personId: r.person_id as string,
    purpose: r.purpose as ConsentPurpose,
    textVersion: r.text_version as string,
    givenByPersonId: r.given_by_person_id as string,
    givenAt: new Date(r.given_at as string),
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string) : null,
    revokedByPersonId: (r.revoked_by_person_id as string | null) ?? null,
    source: r.source as ConsentSource,
    clubNote: (r.club_note as string | null) ?? null,
    revokedReason: (r.revoked_reason as ConsentRevokedReason | null) ?? null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

/** All consents (open and ended) of a person in the transaction's club, newest first. */
export async function consentHistory(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<ConsentRow[]> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT * FROM public.consents WHERE club_id = ${clubId} AND person_id = ${personId}
    ORDER BY given_at DESC, id DESC
    LIMIT 200`);
  return rows.map(consentRow);
}

export async function lockOpenConsent(
  tx: Tx,
  clubId: string,
  personId: string,
  purpose: ConsentPurpose,
): Promise<ConsentRow | null> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT * FROM public.consents
    WHERE club_id = ${clubId} AND person_id = ${personId} AND purpose = ${purpose}
      AND revoked_at IS NULL
    FOR UPDATE`);
  return rows[0] ? consentRow(rows[0]) : null;
}

export async function insertConsent(
  tx: Tx,
  row: {
    clubId: string;
    personId: string;
    purpose: ConsentPurpose;
    textVersion: string;
    givenByPersonId: string;
    source: ConsentSource;
    clubNote: string | null;
  },
): Promise<ConsentRow> {
  const [inserted] = await tx.insert(consents).values(row).returning();
  return inserted!;
}

/** Revokes open consents (one purpose, the given purposes, or all); their IDs. */
export async function revokeConsents(
  tx: Tx,
  where: {
    clubId: string;
    personId?: string;
    purposes?: readonly ConsentPurpose[];
    /** Only consents given for another text version than this one. */
    exceptTextVersion?: string;
  },
  by: string | null,
  reason: ConsentRevokedReason,
): Promise<{ id: string; personId: string; purpose: ConsentPurpose }[]> {
  const purposes = where.purposes ? `{${where.purposes.join(",")}}` : null;
  const { rows } = await tx.execute<{ id: string; person_id: string; purpose: ConsentPurpose }>(sql`
    UPDATE public.consents
    SET revoked_at = now(), revoked_by_person_id = ${by}, revoked_reason = ${reason}
    WHERE club_id = ${where.clubId} AND revoked_at IS NULL
      AND (${where.personId ?? null}::uuid IS NULL OR person_id = ${where.personId ?? null}::uuid)
      AND (${purposes}::text[] IS NULL OR purpose = ANY (${purposes}::text[]))
      AND (${where.exceptTextVersion ?? null}::text IS NULL
           OR text_version <> ${where.exceptTextVersion ?? null}::text)
    RETURNING id, person_id, purpose`);
  return rows.map((r) => ({ id: r.id, personId: r.person_id, purpose: r.purpose }));
}

/** The latest club text per purpose, for the given clubs (or the transaction's club). */
export async function latestTexts(tx: Tx, clubIds: readonly string[]): Promise<ConsentTextRow[]> {
  if (clubIds.length === 0) return [];
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT DISTINCT ON (club_id, purpose) *
    FROM public.consent_texts
    WHERE club_id = ANY (${`{${clubIds.join(",")}}`}::uuid[])
    ORDER BY club_id, purpose, version DESC`);
  return rows.map(textRow);
}

function textRow(r: Record<string, unknown>): ConsentTextRow {
  return {
    id: r.id as string,
    clubId: r.club_id as string,
    purpose: r.purpose as ConsentPurpose,
    version: Number(r.version),
    texts: r.texts as ConsentTextRow["texts"],
    publishedByPersonId: r.published_by_person_id as string,
    publishedAt: new Date(r.published_at as string),
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

export async function textVersions(
  tx: Tx,
  clubId: string,
  purpose: ConsentPurpose,
): Promise<ConsentTextRow[]> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT * FROM public.consent_texts WHERE club_id = ${clubId} AND purpose = ${purpose}
    ORDER BY version DESC`);
  return rows.map(textRow);
}

/** Publishes the next version (the caller holds the club row lock). */
export async function insertText(
  tx: Tx,
  row: {
    clubId: string;
    purpose: ConsentPurpose;
    texts: ConsentTextRow["texts"];
    publishedByPersonId: string;
  },
): Promise<ConsentTextRow> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    INSERT INTO public.consent_texts (club_id, purpose, version, texts, published_by_person_id)
    SELECT ${row.clubId}, ${row.purpose}, coalesce(max(version), 0) + 1,
      ${JSON.stringify(row.texts)}::jsonb, ${row.publishedByPersonId}
    FROM public.consent_texts WHERE club_id = ${row.clubId} AND purpose = ${row.purpose}
    RETURNING *`);
  return textRow(rows[0]!);
}

/** A page of a group's current members (keyset by person) with their open consents. */
export async function groupConsentsPage(
  tx: Tx,
  clubId: string,
  groupId: string,
  page: { cursor: string | null; limit: number },
): Promise<{ personId: string; protected: boolean; purposes: ConsentPurpose[] }[]> {
  const { rows } = await tx.execute<{
    person_id: string;
    protected: boolean;
    purposes: ConsentPurpose[];
  }>(sql`
    SELECT gm.person_id,
      (p.protected_identity OR coalesce(cp.protected_identity_club, false)) AS protected,
      ARRAY(SELECT k.purpose FROM public.consents k
            WHERE k.club_id = ${clubId} AND k.person_id = gm.person_id AND k.revoked_at IS NULL
            ORDER BY k.purpose) AS purposes
    FROM (SELECT DISTINCT person_id FROM public.group_memberships
          WHERE club_id = ${clubId} AND group_id = ${groupId} AND valid_to IS NULL
            AND participates) gm
    JOIN public.people p ON p.id = gm.person_id
    LEFT JOIN public.club_profiles cp ON cp.club_id = ${clubId} AND cp.person_id = gm.person_id
    WHERE (${page.cursor}::uuid IS NULL OR gm.person_id > ${page.cursor}::uuid)
    ORDER BY gm.person_id
    LIMIT ${page.limit}`);
  return rows.map((r) => ({ personId: r.person_id, protected: r.protected, purposes: r.purposes }));
}

/** Per purpose: consented and protected members of the group, and the total (every member). */
export async function groupConsentCounts(
  tx: Tx,
  clubId: string,
  groupId: string,
): Promise<{ total: number; protected: number; consented: Map<ConsentPurpose, number> }> {
  const { rows } = await tx.execute<{
    total: number;
    protected: number;
    consented: Record<string, number> | null;
  }>(sql`
    WITH members AS (
      SELECT DISTINCT gm.person_id FROM public.group_memberships gm
      WHERE gm.club_id = ${clubId} AND gm.group_id = ${groupId} AND gm.valid_to IS NULL
        AND gm.participates)
    SELECT (SELECT count(*)::int FROM members) AS total,
      (SELECT count(*)::int FROM members m JOIN public.people p ON p.id = m.person_id
       LEFT JOIN public.club_profiles cp ON cp.club_id = ${clubId} AND cp.person_id = m.person_id
       WHERE p.protected_identity OR coalesce(cp.protected_identity_club, false)) AS protected,
      (SELECT jsonb_object_agg(purpose, n) FROM (
         SELECT k.purpose, count(*)::int AS n FROM members m
         JOIN public.consents k ON k.club_id = ${clubId} AND k.person_id = m.person_id
           AND k.revoked_at IS NULL
         GROUP BY k.purpose) x) AS consented`);
  const r = rows[0]!;
  return {
    total: r.total,
    protected: r.protected,
    consented: new Map(Object.entries(r.consented ?? {}) as [ConsentPurpose, number][]),
  };
}

/** People in the club with an open consent for a purpose, among the given (field visibility). */
export async function consentedAmong(
  tx: Tx,
  clubId: string,
  purposes: readonly ConsentPurpose[],
  personIds: readonly string[],
): Promise<Map<string, Set<ConsentPurpose>>> {
  const out = new Map<string, Set<ConsentPurpose>>();
  if (personIds.length === 0) return out;
  const { rows } = await tx.execute<{ person_id: string; purpose: ConsentPurpose }>(sql`
    SELECT person_id, purpose FROM public.consents
    WHERE club_id = ${clubId} AND revoked_at IS NULL
      AND purpose = ANY (${`{${purposes.join(",")}}`}::text[])
      AND person_id = ANY (${`{${personIds.join(",")}}`}::uuid[])`);
  for (const r of rows) {
    const set = out.get(r.person_id) ?? new Set<ConsentPurpose>();
    set.add(r.purpose);
    out.set(r.person_id, set);
  }
  return out;
}

// Board decisions and the privacy policy -----------------------------------

export async function insertDecision(
  tx: Tx,
  row: {
    clubId: string;
    body: DecisionBody;
    decidedOn: string;
    reference: string;
    effectiveFrom: string;
    settings: Record<string, unknown>;
    recordedByPersonId: string;
  },
): Promise<DecisionRow> {
  const [inserted] = await tx.insert(clubSettingDecisions).values(row).returning();
  return inserted!;
}

export async function markDecisionApplied(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.club_setting_decisions SET applied_at = now() WHERE id = ${id} AND applied_at IS NULL`);
}

function decisionRow(r: Record<string, unknown>): DecisionRow {
  return {
    id: r.id as string,
    clubId: r.club_id as string,
    body: r.body as DecisionBody,
    decidedOn: r.decided_on as string,
    reference: r.reference as string,
    effectiveFrom: r.effective_from as string,
    settings: r.settings as Record<string, unknown>,
    appliedAt: r.applied_at ? new Date(r.applied_at as string) : null,
    recordedByPersonId: r.recorded_by_person_id as string,
    recordedAt: new Date(r.recorded_at as string),
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

const decisionColumns = sql`id, club_id, body, decided_on::text AS decided_on, reference,
  effective_from::text AS effective_from, settings, applied_at, recorded_by_person_id, recorded_at,
  created_at, updated_at`;

export async function findDecision(tx: Tx, id: string): Promise<DecisionRow | null> {
  const { rows } = await tx.execute<Record<string, unknown>>(
    sql`SELECT ${decisionColumns} FROM public.club_setting_decisions WHERE id = ${id}`,
  );
  return rows[0] ? decisionRow(rows[0]) : null;
}

/** A page of the club's decisions, newest first (keyset by ID). */
export async function decisionsPage(
  tx: Tx,
  clubId: string,
  page: { cursor: string | null; limit: number },
): Promise<DecisionRow[]> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT ${decisionColumns} FROM public.club_setting_decisions
    WHERE club_id = ${clubId} AND (${page.cursor}::uuid IS NULL OR id < ${page.cursor}::uuid)
    ORDER BY id DESC LIMIT ${page.limit}`);
  return rows.map(decisionRow);
}

/** The applied decision each setting rests on (the latest one that contains it). */
export async function decisionsBySetting(
  tx: Tx,
  clubId: string,
): Promise<Map<string, DecisionRow>> {
  const { rows } = await tx.execute<Record<string, unknown> & { key: string }>(sql`
    SELECT DISTINCT ON (k.key) k.key, ${decisionColumns}
    FROM public.club_setting_decisions d, LATERAL jsonb_object_keys(d.settings) AS k(key)
    WHERE d.club_id = ${clubId} AND d.applied_at IS NOT NULL
    ORDER BY k.key, d.effective_from DESC, d.id DESC`);
  return new Map(rows.map((r) => [r.key, decisionRow(r)]));
}

/** Decisions recorded but not yet in effect. */
export async function pendingDecisions(tx: Tx, clubId: string): Promise<DecisionRow[]> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT ${decisionColumns} FROM public.club_setting_decisions
    WHERE club_id = ${clubId} AND applied_at IS NULL ORDER BY effective_from, id`);
  return rows.map(decisionRow);
}

/** Decisions whose effective date has come (system: the worker's daily run). */
export async function dueDecisions(
  tx: Tx,
  limit: number,
): Promise<{ id: string; clubId: string }[]> {
  const { rows } = await tx.execute<{ id: string; club_id: string }>(sql`
    SELECT d.id, d.club_id FROM public.club_setting_decisions d
    JOIN public.clubs c ON c.id = d.club_id
    WHERE d.applied_at IS NULL
      AND d.effective_from <= (now() AT TIME ZONE c.time_zone)::date
    ORDER BY d.effective_from, d.id LIMIT ${limit}`);
  return rows.map((r) => ({ id: r.id, clubId: r.club_id }));
}

function policyRow(r: Record<string, unknown>): PolicyRow {
  return {
    id: r.id as string,
    clubId: r.club_id as string,
    version: Number(r.version),
    templateVersion: Number(r.template_version),
    settings: r.settings as Record<string, unknown>,
    decisionId: (r.decision_id as string | null) ?? null,
    effectiveFrom: r.effective_from as string,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

const policyColumns = sql`id, club_id, version, template_version, settings, decision_id,
  effective_from::text AS effective_from, created_at, updated_at`;

/** The club's policy versions, newest first (few rows per club). */
export async function policies(tx: Tx, clubId: string): Promise<PolicyRow[]> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT ${policyColumns} FROM public.club_privacy_policies
    WHERE club_id = ${clubId} ORDER BY version DESC LIMIT 100`);
  return rows.map(policyRow);
}

export async function insertPolicy(
  tx: Tx,
  row: {
    clubId: string;
    templateVersion: number;
    settings: Record<string, unknown>;
    decisionId: string | null;
    effectiveFrom: string;
  },
): Promise<PolicyRow> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    INSERT INTO public.club_privacy_policies
      (club_id, version, template_version, settings, decision_id, effective_from)
    SELECT ${row.clubId}, coalesce(max(version), 0) + 1, ${row.templateVersion},
      ${JSON.stringify(row.settings)}::jsonb, ${row.decisionId}, ${row.effectiveFrom}::date
    FROM public.club_privacy_policies WHERE club_id = ${row.clubId}
    RETURNING ${policyColumns}`);
  return policyRow(rows[0]!);
}

export const _test = { iso };
