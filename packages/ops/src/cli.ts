#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Entry point for the pnpm ops:* scripts (docs/operations/backup-restore.md).
// Usage: node packages/ops/src/cli.ts <command> [options]

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { compose } from "./docker.ts";
import { loadOpsEnv, required } from "./env.ts";
import { checkObjectLock } from "./object-lock.ts";
import { replayLedger, restoreInPlace } from "./restore.ts";
import { formatChecks, verifyBackup } from "./verify.ts";

const USAGE = `Usage: pnpm ops:<command> [options]

  verify-backup [--time <ISO time>] [--no-record] [--keep]
                    restore the latest backup (or a point in time) into a temporary
                    container, check it, replay the deletion ledger, record the result
  restore [--time <ISO time>] [--ledger-from <database URL>] [--no-backup] [--yes]
                    restore this installation's database in place (stops PostgreSQL)
  replay-ledger [--database-url <URL>] [--ledger-from <database URL>]
                    erase again everyone in the deletion ledger (after any restore)
  backup full|diff|incr|monthly|files
                    run a backup now in the backup sidecar
  object-lock       check that the backup bucket is immutable (object lock)

Settings come from the environment, then .env.local (infra/backup/README.md).`;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function time(args: readonly string[]): Date | undefined {
  const value = option(args, "--time");
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--time: not a time: ${value}`);
  return parsed;
}

const log = (message: string) => console.log(message);

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const flag = (name: string) => args.includes(name);
  const env = loadOpsEnv();

  switch (command) {
    case "verify-backup": {
      const target = time(args);
      const result = await verifyBackup(env, {
        ...(target ? { time: target } : {}),
        record: !flag("--no-record"),
        keep: flag("--keep"),
        log,
      });
      const report = formatChecks(result.checks);
      console.log(
        `\nRestore verification ${result.ok ? "PASSED" : "FAILED"} (backup ${result.label ?? "?"}, ${Math.round(result.durationMs / 1000)} s)\n${report}`,
      );
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### Restore verification: ${result.ok ? "passed" : "failed"}\n\n\`\`\`\n${report}\n\`\`\`\n`,
        );
      }
      return result.ok ? 0 : 1;
    }
    case "restore": {
      if (!flag("--yes")) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(
          "This stops PostgreSQL and replaces the database with the backup. Continue? [y/N] ",
        );
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) return 1;
      }
      const ledgerFrom = option(args, "--ledger-from");
      const target = time(args);
      await restoreInPlace(env, {
        ...(target ? { time: target } : {}),
        ...(ledgerFrom ? { ledgerFrom } : {}),
        backupAfter: !flag("--no-backup"),
        log,
      });
      log("Restored. Next: pnpm ops:verify-backup");
      return 0;
    }
    case "replay-ledger": {
      const url = option(args, "--database-url") ?? required(env, "DATABASE_ADMIN_URL");
      const result = await replayLedger(env, url, option(args, "--ledger-from"));
      log(
        `Deletion ledger: ${result.ledgerEntries} entries (${result.added} from outside the backup), ${result.erased} people erased again, ${result.unerased} left with personal data.`,
      );
      return result.unerased === 0 ? 0 : 1;
    }
    case "backup": {
      const kind = args[0] ?? "";
      if (!["full", "diff", "incr", "monthly", "files"].includes(kind)) {
        console.error(USAGE);
        return 1;
      }
      const sub = kind === "files" ? ["files"] : ["backup", kind];
      return compose(env, ["exec", "-T", "backup", "clubadmin-backup", ...sub]);
    }
    case "object-lock": {
      const report = await checkObjectLock(env);
      log(`Object lock: ${report.status}: ${report.detail}`);
      return report.status === "active" ? 0 : report.status === "error" ? 1 : 2;
    }
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`ops: ${(error as Error).message}`);
  process.exitCode = 1;
}
