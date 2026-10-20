// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "../zod.ts";

export const VersionResponseSchema = z
  .object({
    version: z.string().openapi({ example: "0.0.0" }),
    commit: z.string().openapi({ example: "c366744" }),
  })
  .openapi("VersionResponse");

/** AGPL-3.0 section 13: where to get the exact source of the running version. */
export const SourceResponseSchema = z
  .object({
    url: z.url().openapi({ example: "https://github.com/SweRavn/ClubAdmin/tree/c366744" }),
    license: z.literal("AGPL-3.0-only"),
    commit: z.string(),
  })
  .openapi("SourceResponse");

export const HealthCheckSchema = z.object({
  status: z.enum(["ok", "fail", "skipped"]),
  durationMs: z.number(),
  detail: z.string().optional(),
});

export const HealthResponseSchema = z
  .object({
    status: z.enum(["ok", "fail"]),
    checks: z.record(z.string(), HealthCheckSchema).optional(),
  })
  .openapi("HealthResponse");

export type VersionResponse = z.infer<typeof VersionResponseSchema>;
export type SourceResponse = z.infer<typeof SourceResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
