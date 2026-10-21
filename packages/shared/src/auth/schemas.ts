// SPDX-License-Identifier: AGPL-3.0-only
// Responses of the identity endpoints (/api/v1/me, /api/v1/dev/personas).

import { CLUB_ROLES } from "../domain/core.ts";
import { z } from "../zod.ts";
import { SessionMetadataSchema } from "./sessions.ts";

/**
 * A person as the viewer may see them. Produced only by the PersonPresenter
 * (apps/api/src/modules/authorization/presenters, ADR 0022): people the
 * viewer may not see are left out of lists entirely.
 */
export const PersonSummarySchema = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    givenName: z.string(),
    familyName: z.string(),
    /** Protected identity: show the crossed-camera icon; do not photograph, film, publish or share. */
    protected: z.boolean(),
  })
  .openapi("PersonSummary");
export type PersonSummary = z.infer<typeof PersonSummarySchema>;

export const MeResponseSchema = z
  .object({
    personId: z.uuid(),
    accountId: z.uuid().nullable(),
    mfa: z.boolean(),
    authTime: z.iso.datetime().nullable(),
    person: PersonSummarySchema,
  })
  .openapi("Me");
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const SecurityResponseSchema = z
  .object({ mfa: z.literal(true), authTime: z.iso.datetime().nullable() })
  .openapi("Security");

export const SessionListSchema = z
  .object({ sessions: z.array(SessionMetadataSchema.extend({ current: z.boolean() })) })
  .openapi("SessionList");
export type SessionList = z.infer<typeof SessionListSchema>;

export const PersonaSchema = z
  .object({
    person: PersonSummarySchema,
    hasAccount: z.boolean(),
    /** From docs/demodata/personas.json (what the persona tests); null for others. */
    description: z.string().nullable(),
    tags: z.array(z.string()),
    clubs: z.array(
      z.object({ clubId: z.uuid(), clubName: z.string(), roles: z.array(z.enum(CLUB_ROLES)) }),
    ),
  })
  .openapi("Persona");
export const PersonaListSchema = z
  .object({ personas: z.array(PersonaSchema) })
  .openapi("PersonaList");
export type PersonaList = z.infer<typeof PersonaListSchema>;

/** Header carrying a "give own login" invitation token through sign-up (ADR 0020). */
export const ACCOUNT_INVITATION_HEADER = "x-clubadmin-invitation";
/** Header carrying the ID token issued together with the access token (ADR 0024). */
export const ID_TOKEN_HEADER = "x-id-token";
