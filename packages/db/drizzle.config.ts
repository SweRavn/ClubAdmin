// SPDX-License-Identifier: AGPL-3.0-only
// drizzle-kit manages the application tables in the `public` schema
// (src/schema). Infrastructure schemas (app, history, audit, outbox, privacy,
// app_meta) are hand-written SQL migrations in the same sequence.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  schemaFilter: ["public"],
  casing: "snake_case",
  strict: true,
  verbose: true,
});
