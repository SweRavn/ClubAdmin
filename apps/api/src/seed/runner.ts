// SPDX-License-Identifier: AGPL-3.0-only
// Seed scenarios (docs/seed-data.md, ADR 0026): `demo` (the named personas
// from docs/demodata), `minimal` (one club, three people) and `load`
// (generated volume, fast path). Steps run in order; later modules register
// their own step after the core one.

import type { DemoData } from "./demodata.ts";
import { loadDemoData } from "./demodata.ts";
import type { DemoStep, SeedEnvironment } from "./environment.ts";
import { Generator } from "./generator.ts";
import { seedLoad } from "./load.ts";
import { seedMinimal } from "./minimal.ts";
import { type DemoResult, seedCore } from "./steps/core.ts";
import { SeedClock } from "./time.ts";

export const SCENARIOS = ["demo", "minimal", "load"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const DEMO_STEPS: readonly DemoStep[] = [];

export interface SeedOptions {
  scenario: Scenario;
  /** load: number of clubs (about 200 people each). */
  size?: number;
  data?: DemoData;
  log?: (message: string) => void;
}

export async function seed(
  env: Omit<SeedEnvironment, "clock" | "generator"> & { clock?: SeedClock },
  options: SeedOptions,
): Promise<DemoResult | null> {
  const full: SeedEnvironment = {
    ...env,
    clock: env.clock ?? new SeedClock(),
    // Fixed seeds: the same scenario gives the same generated people.
    generator: new Generator(
      options.scenario === "demo" ? 20_260_101 : 7,
      namespaceOf(options.scenario),
    ),
  };
  const log = options.log ?? (() => undefined);
  switch (options.scenario) {
    case "demo": {
      const data = options.data ?? loadDemoData();
      const result = await seedCore(full, data);
      log(
        `core: ${data.personas.length} personas, ${data.clubs.length} clubs, ${data.groups.length} groups`,
      );
      for (const step of DEMO_STEPS) {
        await step.run(full, data, result);
        log(`${step.name}: done`);
      }
      return result;
    }
    case "minimal":
      await seedMinimal(full);
      log("minimal: one club, three people");
      return null;
    case "load":
      await seedLoad(full, options.size ?? 1_000);
      log(`load: ${options.size ?? 1_000} clubs`);
      return null;
  }
}

function namespaceOf(scenario: Scenario): number {
  return { demo: 0x100, minimal: 0x200, load: 0x300 }[scenario];
}

export type { DemoStep, SeedEnvironment };
