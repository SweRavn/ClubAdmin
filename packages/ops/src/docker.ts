// SPDX-License-Identifier: AGPL-3.0-only
// Docker for the operator tools: one-off containers of the backup image, and
// docker compose for the installation's services.

import { BACKUP_IMAGE, composeBaseArgs, PROJECT_NAME } from "@clubadmin/devtools/compose";
import { capture, run } from "@clubadmin/devtools/process";

import type { OpsEnv } from "./env.ts";

export const backupImage = (env: OpsEnv) => env.get("OPS_BACKUP_IMAGE") ?? BACKUP_IMAGE;

/**
 * The Docker network one-off containers join (to reach S3 by the same names
 * as the services): OPS_DOCKER_NETWORK, else the compose project's network
 * if it exists.
 */
export function dockerNetwork(env: OpsEnv): string | null {
  const configured = env.get("OPS_DOCKER_NETWORK");
  if (configured) return configured;
  const project = env.get("COMPOSE_PROJECT_NAME") ?? PROJECT_NAME;
  const name = `${project}_backend`;
  return capture("docker", ["network", "inspect", name]).status === 0 ? name : null;
}

/** `docker compose` for this installation: COMPOSE_FILE if the operator set it, else the development files. */
export function composeArgs(env: OpsEnv): string[] {
  if (process.env.COMPOSE_FILE) return ["compose", "--profile", "backup"];
  const args = composeBaseArgs({ backup: true });
  const project = env.get("COMPOSE_PROJECT_NAME");
  if (project) args.splice(args.indexOf("--project-name") + 1, 1, project);
  return args;
}

export const compose = (env: OpsEnv, args: readonly string[]) =>
  run("docker", [...composeArgs(env), ...args]);

export const composeCapture = (env: OpsEnv, args: readonly string[], input?: string) =>
  capture("docker", [...composeArgs(env), ...args], input);

export { capture, run };
