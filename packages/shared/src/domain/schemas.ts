// SPDX-License-Identifier: AGPL-3.0-only
// Input schemas of the core domain services (people, accounts, clubs, groups,
// memberships, guardianships). The API endpoints (P0.7 and later) use the same
// schemas, so validation and OpenAPI stay in one place.

import { z } from "../zod.ts";
import {
  ADMISSION_MODES,
  CLUB_ROLES,
  EMPLOYMENT_TYPES,
  GENDER_CATEGORIES,
  GENDERS,
  GROUP_FUNCTIONS,
  GROUP_KINDS,
  GUARDIANSHIP_KINDS,
  GUARDIANSHIP_RIGHTS,
  JOIN_POLICIES,
  MEMBERSHIP_TYPES,
  SHAREABLE_PERSON_FIELDS,
} from "./core.ts";

const name = z.string().trim().min(1).max(100);
const countryCode = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2 country code");

/** Normalised login email: trimmed and lower-cased (ADR 0020). */
export const EmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const PostalAddressSchema = z.object({
  street: z.string().trim().min(1).max(200),
  postalCode: z.string().trim().min(1).max(20),
  city: z.string().trim().min(1).max(100),
  country: countryCode,
});

export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{5,20}$/, "phone number");

/** A personal identity number with the country whose format it uses. */
export const PersonalIdentityNumberInputSchema = z.object({
  country: countryCode,
  value: z.string().trim().min(1).max(20),
});

export const CreatePersonSchema = z.object({
  givenName: name,
  familyName: name,
  birthDate: z.iso.date(),
  gender: z.enum(GENDERS).nullish(),
  personalIdentityNumber: PersonalIdentityNumberInputSchema.nullish(),
  phone: PhoneSchema.nullish(),
  address: PostalAddressSchema.nullish(),
  protectedIdentity: z.boolean().default(false),
});
export type CreatePersonInput = z.input<typeof CreatePersonSchema>;

export const UpdatePersonSchema = CreatePersonSchema.omit({ protectedIdentity: true })
  .partial()
  .strict();
export type UpdatePersonInput = z.input<typeof UpdatePersonSchema>;

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lower-case letters, digits and single hyphens");

export const CreateClubSchema = z.object({
  name: z.string().trim().min(2).max(200),
  shortName: z.string().trim().min(1).max(20).nullish(),
  slug,
  country: countryCode,
  /** Defaults from the country pack when not given. */
  defaultLocale: z.string().min(2).max(20).optional(),
  timeZone: z.string().min(1).max(64).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  joinPolicy: z.enum(JOIN_POLICIES).optional(),
  organizationNumber: z.string().trim().max(30).nullish(),
});
export type CreateClubInput = z.input<typeof CreateClubSchema>;

export const UpdateClubSettingsSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    shortName: z.string().trim().min(1).max(20).nullable(),
    defaultLocale: z.string().min(2).max(20),
    timeZone: z.string().min(1).max(64),
    currency: z.string().regex(/^[A-Z]{3}$/),
    organizationNumber: z.string().trim().max(30).nullable(),
    federationIds: z.record(z.string(), z.string().max(100)),
    address: PostalAddressSchema.nullable(),
    joinPolicy: z.enum(JOIN_POLICIES),
    ownersCanAppointCoOwners: z.boolean(),
    groupOwnersAdmitToClub: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateClubSettingsInput = z.input<typeof UpdateClubSettingsSchema>;

const year = z.number().int().min(1900).max(2200);

const groupFields = {
  name: z.string().trim().min(1).max(100),
  kind: z.enum(GROUP_KINDS),
  parentGroupId: z.uuid().nullable(),
  sport: z.string().trim().max(50).nullable(),
  birthYearFrom: year.nullable(),
  birthYearTo: year.nullable(),
  genderCategory: z.enum(GENDER_CATEGORIES).nullable(),
  level: z.string().trim().max(50).nullable(),
  capacity: z.number().int().min(0).max(10_000).nullable(),
  admissionMode: z.enum(ADMISSION_MODES),
  waitlistVisiblePublicly: z.boolean(),
  offerReplyDays: z.number().int().min(1).max(60),
};

export const CreateGroupSchema = z
  .object(groupFields)
  .partial()
  .required({ name: true, kind: true })
  .strict();
export type CreateGroupInput = z.input<typeof CreateGroupSchema>;

export const UpdateGroupSchema = z.object(groupFields).partial().strict();
export type UpdateGroupInput = z.input<typeof UpdateGroupSchema>;

export const ClubRoleSchema = z.enum(CLUB_ROLES);
export const GroupFunctionSchema = z.enum(GROUP_FUNCTIONS);
export const MembershipTypeSchema = z.enum(MEMBERSHIP_TYPES);
export const GuardianshipKindSchema = z.enum(GUARDIANSHIP_KINDS);
export const GuardianshipRightsSchema = z
  .array(z.enum(GUARDIANSHIP_RIGHTS))
  .max(GUARDIANSHIP_RIGHTS.length);
export const EmploymentTypeSchema = z.enum(EMPLOYMENT_TYPES);

export const UpdateClubProfileSchema = z
  .object({
    sharedFields: z.array(z.enum(SHAREABLE_PERSON_FIELDS)),
    emergencyContacts: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(100),
          phone: PhoneSchema,
          relation: z.string().trim().max(50).optional(),
        }),
      )
      .max(5),
    notes: z.string().max(5000).nullable(),
  })
  .partial()
  .strict();
export type UpdateClubProfileInput = z.input<typeof UpdateClubProfileSchema>;
