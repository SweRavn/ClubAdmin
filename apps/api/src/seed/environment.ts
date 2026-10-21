// SPDX-License-Identifier: AGPL-3.0-only
// What seed steps get: the database, the domain services, the clock, the
// deterministic generator and the superuser hooks of the seed command.

import type { Database } from "@clubadmin/db";

import type { CoreServices } from "../domain-services.ts";
import type { DemoData } from "./demodata.ts";
import type { Generator } from "./generator.ts";
import type { SeedClock } from "./time.ts";

export interface SeedEnvironment {
  db: Database;
  services: CoreServices;
  clock: SeedClock;
  generator: Generator;
  /** Operator tooling (no API exists): registers a platform operator. */
  addPlatformOperator(personId: string): Promise<void>;
  /** Superuser SQL for the load scenario's fast path. */
  admin(sql: string): Promise<void>;
}

/** A step of the demo scenario; modules add theirs after "core" (ADR 0026). */
export interface DemoStep {
  name: string;
  run(env: SeedEnvironment, data: DemoData, core: DemoResult): Promise<void>;
}

export interface DemoResult {
  /** Fixed IDs by key (personas, clubs, groups). */
  ids: Map<string, string>;
  /** Generated members per group key, in creation order. */
  generated: Map<string, string[]>;
}
