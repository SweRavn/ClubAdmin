// SPDX-License-Identifier: AGPL-3.0-only
// From the cells of a file row to the values of a member (P1.3b), with issue
// codes, never values: names, dates in ISO or the country's order, the
// personal identity number (validated by the country pack; the birth date
// must match), guardians (any number of column groups), a minor's email
// moved to a guardian (never stored on the child, ADR 0020). Checks across
// rows (family keys, repeats in the file, member numbers, duplicates in the
// club) are the import service's.

import type { schema } from "@clubadmin/db";
import {
  EmailSchema,
  type GuardianshipKind,
  isImportErrorIssue,
  isLinkedGuardianshipKind,
  type MemberImportColumnMap,
  type MemberImportIssue,
  type MemberImportMemberField,
  type MemberImportOptions,
  parseImportTarget,
  PhoneSchema,
} from "@clubadmin/shared";

import {
  parseDate,
  parseGender,
  parseKind,
  parseMembershipType,
  parseYes,
  splitFullName,
  splitList,
} from "./values.ts";

export interface RowRules {
  country: string;
  dateOrder: "dmy" | "mdy";
  adultAge: number;
  /** Today in the club's time zone (ISO). */
  today: string;
  /** Lower-cased group name → ID (the club's groups; none are created). */
  groups: ReadonlyMap<string, string>;
  options: MemberImportOptions;
  /** The country pack's parser (PeopleService.parsePersonalIdentityNumber). */
  parsePin: (value: string) => { normalized: string; birthDate: string; hash: string } | null;
}

/** A mapped row: the values (identity number still plain, sealed by the caller) and issues. */
export interface MappedRow {
  data: schema.MemberImportRowData;
  /** The normalised identity number, to seal; never stored plain. */
  pin: string | null;
  issues: MemberImportIssue[];
  familyKey: string | null;
}

interface Columns {
  member: Map<MemberImportMemberField, number>;
  guardians: Map<number, Map<string, number>>;
}

/** The column map as lookups (unknown targets are ignored). */
export function columnsOf(map: MemberImportColumnMap): Columns {
  const member = new Map<MemberImportMemberField, number>();
  const guardians = new Map<number, Map<string, number>>();
  for (const [column, target] of Object.entries(map)) {
    const parsed = parseImportTarget(target);
    if (!parsed) continue;
    if (parsed.kind === "member") member.set(parsed.field, Number(column));
    else {
      const fields = guardians.get(parsed.index) ?? new Map<string, number>();
      fields.set(parsed.field, Number(column));
      guardians.set(parsed.index, fields);
    }
  }
  return { member, guardians };
}

/** Whether a mapping can produce members at all: names and a birth date (or identity number). */
export function mappingComplete(map: MemberImportColumnMap): boolean {
  const { member } = columnsOf(map);
  const names = member.has("fullName") || (member.has("givenName") && member.has("familyName"));
  return names && (member.has("birthDate") || member.has("personalIdentityNumber"));
}

const lower = (s: string) => s.trim().toLowerCase();

function ageAt(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age;
}

export function mapRow(cells: readonly string[], columns: Columns, rules: RowRules): MappedRow {
  const issues = new Set<MemberImportIssue>();
  const cell = (index: number | undefined) => (index === undefined ? "" : (cells[index] ?? ""));
  const get = (field: MemberImportMemberField) => cell(columns.member.get(field)).trim();

  // Names: given and family, or one column split at the last space.
  let given = get("givenName");
  let family = get("familyName");
  if ((!given || !family) && get("fullName")) {
    const split = splitFullName(get("fullName"));
    if (split) [given, family] = [given || split[0], family || split[1]];
  }
  if (!given || !family) issues.add("name_missing");

  const relationValue = get("relation");
  let relation: GuardianshipKind | null = null;
  if (relationValue) {
    relation = parseKind(relationValue);
    if (!relation) issues.add("relation_invalid");
  }
  const guardianRow = relationValue !== "";

  // Birth date, from the identity number when there is one.
  let birthDate: string | null = null;
  const birthValue = get("birthDate");
  if (birthValue) {
    birthDate = parseDate(birthValue, rules.dateOrder);
    if (!birthDate) issues.add("birth_date_invalid");
  }
  let pin: string | null = null;
  let pinHash: string | null = null;
  const pinValue = get("personalIdentityNumber");
  if (pinValue) {
    const parsed = rules.parsePin(pinValue);
    if (!parsed) {
      // An IdrottOnline-style column with only a birth date.
      const date = parseDate(pinValue, rules.dateOrder);
      if (date && !birthDate) birthDate = date;
      else issues.add("personal_identity_number_invalid");
    } else {
      if (birthDate && birthDate !== parsed.birthDate)
        issues.add("personal_identity_number_mismatch");
      birthDate = parsed.birthDate;
      pin = parsed.normalized;
      pinHash = parsed.hash;
    }
  }
  if (!guardianRow) {
    if (!birthDate && !birthValue && !pinValue) issues.add("birth_date_missing");
    if (birthDate && birthDate > rules.today) issues.add("birth_date_in_future");
  }

  const genderValue = get("gender");
  const gender = genderValue ? parseGender(genderValue) : null;
  if (genderValue && !gender) issues.add("gender_invalid");

  const phoneValue = get("phone");
  const phone = phoneValue ? (PhoneSchema.safeParse(phoneValue).data ?? null) : null;
  if (phoneValue && !phone) issues.add("phone_invalid");

  const emailValue = get("email");
  let email = emailValue ? (EmailSchema.safeParse(emailValue).data ?? null) : null;
  if (emailValue && !email) issues.add("email_invalid");

  const isProtected = parseYes(get("protected"));
  const [street, postalCode, city] = [get("street"), get("postalCode"), get("city")];
  let address: schema.MemberImportRowData["address"] = null;
  if (street || postalCode || city) {
    if (!street || !postalCode || !city) issues.add("address_incomplete");
    else if (isProtected) issues.add("protected_address_dropped");
    else address = { street, postalCode, city, country: rules.country };
  }

  const typeValue = get("membershipType");
  const membershipType = typeValue ? parseMembershipType(typeValue) : null;
  if (typeValue && !membershipType) issues.add("membership_type_invalid");

  const startValue = get("startDate");
  const startDate = startValue ? parseDate(startValue, rules.dateOrder) : null;
  if (startValue && (!startDate || startDate > rules.today)) issues.add("start_date_invalid");

  let memberNumber: number | null = null;
  const numberValue = get("memberNumber");
  if (numberValue && rules.options.memberNumbers === "keep") {
    memberNumber = /^[0-9]{1,9}$/.test(numberValue) ? Number(numberValue) : null;
    if (!memberNumber) issues.add("member_number_invalid");
  }

  const groupNames = splitList(get("groups"));
  const groupIds: string[] = [];
  for (const name of groupNames) {
    const id = rules.groups.get(lower(name));
    if (id) groupIds.push(id);
    else issues.add("group_not_found");
  }

  const guardians: schema.MemberImportRowData["guardians"] = [];
  for (const index of [...columns.guardians.keys()].sort((a, b) => a - b)) {
    const fields = columns.guardians.get(index)!;
    const value = (f: string) => cell(fields.get(f)).trim();
    let gGiven = value("givenName");
    let gFamily = value("familyName");
    if ((!gGiven || !gFamily) && value("fullName")) {
      const split = splitFullName(value("fullName"));
      if (split) [gGiven, gFamily] = [gGiven || split[0], gFamily || split[1]];
    }
    const gPhoneValue = value("phone");
    const gEmailValue = value("email");
    const gKindValue = value("kind");
    if (!gGiven && !gFamily && !gPhoneValue && !gEmailValue && !gKindValue) continue;
    const kind = parseKind(gKindValue);
    if (!kind) issues.add("guardian_kind_invalid");
    const gPhone = gPhoneValue ? (PhoneSchema.safeParse(gPhoneValue).data ?? null) : null;
    if (gPhoneValue && !gPhone) issues.add("guardian_phone_invalid");
    const gEmail = gEmailValue ? (EmailSchema.safeParse(gEmailValue).data ?? null) : null;
    if (gEmailValue && !gEmail) issues.add("guardian_email_invalid");
    // Without a name only an invitation can create the guardianship.
    if ((!gGiven || !gFamily) && !(gEmail && rules.options.sendInvitations))
      issues.add("guardian_name_missing");
    guardians.push({
      given: gGiven || null,
      family: gFamily || null,
      phone: gPhone,
      email: gEmail,
      kind: kind ?? "parent",
      personId: null,
    });
  }

  // ADR 0020: a minor never has an email; it becomes a guardian's.
  if (email && !guardianRow && birthDate && ageAt(birthDate, rules.today) < rules.adultAge) {
    const without = guardians.find((g) => !g.email);
    if (without) {
      without.email = email;
      issues.add("minor_email_moved");
    } else {
      issues.add("minor_email_dropped");
    }
    email = null;
  }

  const linked =
    guardians.some((g) => isLinkedGuardianshipKind(g.kind)) ||
    (relation !== null && isLinkedGuardianshipKind(relation));
  if (linked && !rules.options.consentNote) issues.add("guardian_consent_note_missing");

  return {
    data: {
      given: given || null,
      family: family || null,
      birthDate,
      personalIdentityNumber: null,
      personalIdentityNumberHash: pinHash,
      gender,
      phone,
      email,
      address,
      membershipType,
      startDate,
      memberNumber,
      groupIds,
      groupNames,
      protected: isProtected,
      relation,
      guardians,
    },
    pin,
    issues: [...issues],
    familyKey: get("familyKey") || null,
  };
}

export const hasErrors = (issues: readonly string[]): boolean => issues.some(isImportErrorIssue);
