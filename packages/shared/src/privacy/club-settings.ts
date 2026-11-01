// SPDX-License-Identifier: AGPL-3.0-only
// The club settings registry (ADR 0037, started in P1.8a). Every club setting
// that a decision of the club could set has a stable key here (never renamed:
// governing documents in Phase 2 refer to it), a type, its limits, the API
// field it is written through (ClubsService.updateSettings) and who decides
// it: the board (changed only through a recorded decision, P1.8a) or the
// club managers. Country packs may narrow the limits (retentionLimits).

import { CONSENT_PURPOSES, type ConsentPurpose, JOIN_POLICIES } from "../domain/core.ts";
import { z } from "../zod.ts";

export type SettingDecidedBy = "board" | "manager";

interface BaseSetting {
  /** The field of UpdateClubSettingsSchema (and the API) that holds it. */
  field: string;
  decidedBy: SettingDecidedBy;
}
export interface IntegerSetting extends BaseSetting {
  type: "integer";
  default: number;
  min: number;
  max: number;
  unit: "days" | "months";
}
export interface BooleanSetting extends BaseSetting {
  type: "boolean";
  default: boolean;
}
export interface PurposesSetting extends BaseSetting {
  type: "purposes";
  default: readonly ConsentPurpose[];
}
export interface EnumSetting extends BaseSetting {
  type: "enum";
  values: readonly string[];
  default: string;
}
export interface EmailSetting extends BaseSetting {
  type: "email";
  default: null;
}
export type ClubSettingDefinition =
  IntegerSetting | BooleanSetting | PurposesSetting | EnumSetting | EmailSetting;

export const CLUB_SETTINGS = {
  former_member_retention_months: {
    field: "formerMemberRetentionMonths",
    type: "integer",
    default: 24,
    min: 6,
    max: 120,
    unit: "months",
    decidedBy: "board",
  },
  attendance_retention_months: {
    field: "attendanceRetentionMonths",
    type: "integer",
    default: 12,
    min: 12,
    max: 120,
    unit: "months",
    decidedBy: "board",
  },
  consent_purposes: {
    field: "consentPurposes",
    type: "purposes",
    default: ["photo_publication", "video_publication"],
    decidedBy: "board",
  },
  consent_reconfirm_on_new_version: {
    field: "consentReconfirmOnNewVersion",
    type: "boolean",
    default: false,
    decidedBy: "board",
  },
  attendance_lock_days: {
    field: "attendanceLockDays",
    type: "integer",
    default: 30,
    min: 1,
    max: 365,
    unit: "days",
    decidedBy: "manager",
  },
  join_policy: {
    field: "joinPolicy",
    type: "enum",
    values: JOIN_POLICIES,
    default: "approval",
    decidedBy: "manager",
  },
  owners_can_appoint_co_owners: {
    field: "ownersCanAppointCoOwners",
    type: "boolean",
    default: false,
    decidedBy: "manager",
  },
  group_owners_admit_to_club: {
    field: "groupOwnersAdmitToClub",
    type: "boolean",
    default: true,
    decidedBy: "manager",
  },
  privacy_contact_email: {
    field: "privacyContactEmail",
    type: "email",
    default: null,
    decidedBy: "manager",
  },
} as const satisfies Record<string, ClubSettingDefinition>;

export type ClubSettingKey = keyof typeof CLUB_SETTINGS;
export const CLUB_SETTING_KEYS = Object.keys(CLUB_SETTINGS) as ClubSettingKey[];

/** The settings the board decides: changed only through a recorded decision. */
export const BOARD_SETTING_KEYS = CLUB_SETTING_KEYS.filter(
  (key) => CLUB_SETTINGS[key].decidedBy === "board",
);
export type BoardSettingKey =
  | "former_member_retention_months"
  | "attendance_retention_months"
  | "consent_purposes"
  | "consent_reconfirm_on_new_version";

/** The API fields of the board settings (refused by PATCH /clubs/:clubId/settings). */
export const BOARD_SETTING_FIELDS: readonly string[] = BOARD_SETTING_KEYS.map(
  (key) => CLUB_SETTINGS[key].field,
);

/** Limits narrowed by a country pack (retentionLimits) never widen the registry's. */
export function settingLimits(
  key: ClubSettingKey,
  narrowed?: { min?: number; max?: number },
): { min: number; max: number } | null {
  const definition: ClubSettingDefinition = CLUB_SETTINGS[key];
  if (definition.type !== "integer") return null;
  return {
    min: Math.max(definition.min, narrowed?.min ?? definition.min),
    max: Math.min(definition.max, narrowed?.max ?? definition.max),
  };
}

/** Validates a value for a setting against the registry (and a pack's narrowed limits). */
export function settingValueSchema(
  key: ClubSettingKey,
  narrowed?: { min?: number; max?: number },
): z.ZodType {
  const definition: ClubSettingDefinition = CLUB_SETTINGS[key];
  switch (definition.type) {
    case "integer": {
      const limits = settingLimits(key, narrowed)!;
      return z.number().int().min(limits.min).max(limits.max);
    }
    case "boolean":
      return z.boolean();
    case "purposes":
      return z
        .array(z.enum(CONSENT_PURPOSES))
        .max(CONSENT_PURPOSES.length)
        .refine((values) => new Set(values).size === values.length, "duplicate purpose");
    case "enum":
      return z.enum(definition.values as [string, ...string[]]);
    case "email":
      return z.email().max(254).nullable();
  }
}
