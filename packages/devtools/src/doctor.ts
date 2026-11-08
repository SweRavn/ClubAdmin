// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm dev:doctor`: checks the machine is ready for `pnpm dev` and prints fixes.

import { X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { getCACertificates } from "node:tls";

import { DEV_SERVICES, serviceStates } from "./compose.ts";
import { ALL_KEYS, loadEnv } from "./env.ts";
import { caddyRootCertFile, envLocalFile, repoRoot } from "./paths.ts";
import { isWindowsMountPath, isWsl, portInUse } from "./platform.ts";
import { capture } from "./process.ts";
import type { CheckResult } from "./report.ts";
import { printResults } from "./report.ts";

export function nodeVersionCheck(actual: string, wanted: string): CheckResult {
  const major = (v: string) => v.replace(/^v/, "").split(".")[0];
  return major(actual) === major(wanted)
    ? { name: "Node.js version", status: "ok", detail: actual }
    : {
        name: "Node.js version",
        status: "fail",
        detail: `${actual}, expected ${wanted} (from .nvmrc)`,
        fix: "install the version in .nvmrc, e.g. `nvm install` or `fnm use`",
      };
}

/**
 * Sends `request` to 127.0.0.1:port and resolves with the first bytes of the
 * answer, or an error message. A container can be healthy while its
 * published port no longer reaches it (Docker's port forwarding after WSL2
 * slept or changed network): the connection is then reset.
 */
export function probePort(port: number, request: Buffer, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (result: string) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done("error: timeout"));
    socket.on("connect", () => socket.write(request));
    socket.on("data", (data) => done(data.toString("latin1")));
    socket.on("error", (error) => done(`error: ${error.message}`));
    socket.on("close", () => done("error: closed without an answer"));
  });
}

/** Valkey answers PING with +PONG; PostgreSQL answers an SSL request with S or N. */
export const HOST_PROBES = [
  {
    service: "valkey",
    portKey: "VALKEY_PORT",
    defaultPort: 6379,
    request: Buffer.from("PING\r\n"),
    ok: (answer: string) => answer.startsWith("+PONG"),
  },
  {
    service: "postgres",
    portKey: "POSTGRES_PORT",
    defaultPort: 5432,
    request: Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]),
    ok: (answer: string) => answer === "S" || answer === "N",
  },
] as const;

const isLoopback = (address: string) => address === "::1" || address.startsWith("127.");

export async function doctor(): Promise<boolean> {
  const results: CheckResult[] = [];
  const env = loadEnv();
  const wsl = isWsl();

  // Toolchain
  const nvmrc = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();
  results.push(nodeVersionCheck(process.version, nvmrc));

  if (wsl && isWindowsMountPath(repoRoot)) {
    results.push({
      name: "Repository location",
      status: "warn",
      detail: `${repoRoot} is on the Windows drive: installs are slow and file watching does not work`,
      fix: "clone the repository inside WSL instead, e.g. `git clone … ~/ClubAdmin`",
    });
  }

  const pnpm = capture("pnpm", ["--version"]);
  results.push(
    pnpm.status === 0
      ? { name: "pnpm", status: "ok", detail: pnpm.stdout.trim() }
      : { name: "pnpm", status: "fail", fix: "run `corepack enable`" },
  );

  const docker = capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  results.push(
    docker.status === 0
      ? { name: "Docker daemon", status: "ok", detail: `server ${docker.stdout.trim()}` }
      : {
          name: "Docker daemon",
          status: "fail",
          detail: docker.stderr.split("\n")[0]?.trim() ?? "not reachable",
          fix: wsl
            ? "start Docker Desktop on Windows and enable Settings → Resources → WSL integration for this distro " +
              "(or install Docker Engine inside WSL), then open a new terminal"
            : "install Docker (Docker Desktop on macOS/Windows, Docker Engine on Linux) and start it",
        },
  );
  const composeVersion = capture("docker", ["compose", "version", "--short"]);
  results.push(
    composeVersion.status === 0
      ? { name: "Docker Compose", status: "ok", detail: composeVersion.stdout.trim() }
      : docker.status !== 0
        ? { name: "Docker Compose", status: "fail", detail: "needs Docker (see above)" }
        : { name: "Docker Compose", status: "fail", fix: "install the Docker Compose v2 plugin" },
  );

  // Configuration
  const missing = ALL_KEYS.filter((key) => !env.has(key));
  results.push(
    !existsSync(envLocalFile)
      ? {
          name: ".env.local",
          status: "warn",
          detail: "not created yet",
          fix: "run `pnpm dev` (creates it)",
        }
      : missing.length > 0
        ? {
            name: ".env.local",
            status: "warn",
            detail: `missing ${missing.join(", ")}`,
            fix: "run `pnpm dev`",
          }
        : { name: ".env.local", status: "ok" },
  );

  // Services and ports
  const states = docker.status === 0 ? serviceStates() : [];
  const running = new Set(states.filter((s) => s.state === "running").map((s) => s.service));
  const ports: [string, string, string][] = [
    ["CADDY_HTTPS_PORT", "443", "caddy"],
    ["CADDY_HTTP_PORT", "80", "caddy"],
    ["POSTGRES_PORT", "5432", "postgres"],
    ["VALKEY_PORT", "6379", "valkey"],
    ["S3_PORT", "3900", "garage"],
    ["GARAGE_ADMIN_PORT", "3903", "garage"],
    ["SMTP_PORT", "1025", "mailpit"],
    ["MAILPIT_UI_PORT", "8025", "mailpit"],
  ];
  for (const [key, fallback, service] of ports) {
    const port = Number(env.get(key) ?? fallback);
    if (running.has(service)) continue; // in use by our own container
    if (await portInUse(port)) {
      results.push({
        name: `Port ${port} (${service})`,
        status: "fail",
        detail: "in use by another program",
        fix: `stop that program or set ${key} to a free port in .env.local`,
      });
    }
  }
  if (!results.some((r) => r.name.startsWith("Port "))) {
    results.push({ name: "Ports", status: "ok", detail: "free or used by ClubAdmin containers" });
  }

  if (states.length === 0) {
    results.push({
      name: "Services",
      status: "warn",
      detail: "not running",
      fix: "run `pnpm dev:services`",
    });
  } else {
    for (const service of DEV_SERVICES) {
      const state = states.find((s) => s.service === service);
      const healthy =
        state?.state === "running" && (state.health === "" || state.health === "healthy");
      results.push(
        healthy
          ? { name: `Service ${service}`, status: "ok", detail: state.health || state.state }
          : {
              name: `Service ${service}`,
              status: "fail",
              detail: state
                ? `${state.state}${state.health ? ` (${state.health})` : ""}`
                : "missing",
              fix: `see \`pnpm dev:logs ${service}\``,
            },
      );
    }
  }

  // The services as the apps reach them: through the published ports.
  for (const probe of HOST_PROBES) {
    const state = states.find((s) => s.service === probe.service);
    if (state?.state !== "running") continue;
    const port = Number(env.get(probe.portKey) ?? probe.defaultPort);
    const answer = await probePort(port, probe.request);
    results.push(
      probe.ok(answer)
        ? { name: `${probe.service} reachable on 127.0.0.1:${port}`, status: "ok" }
        : {
            name: `${probe.service} reachable on 127.0.0.1:${port}`,
            status: "fail",
            detail: answer.startsWith("error") ? answer : "unexpected answer",
            fix: `the container is healthy but its port does not reach it: \`docker restart clubadmin-${probe.service}-1\` (or \`pnpm dev:services\`)`,
          },
    );
  }

  // Names and certificates
  const domains = [
    env.get("APP_DOMAIN") ?? "clubadmin.localhost",
    env.get("AUTH_DOMAIN") ?? "auth.clubadmin.localhost",
    `mail.${env.get("APP_DOMAIN") ?? "clubadmin.localhost"}`,
  ];
  const unresolved: string[] = [];
  for (const domain of domains) {
    try {
      const { address } = await lookup(domain);
      if (!isLoopback(address)) unresolved.push(domain);
    } catch {
      unresolved.push(domain);
    }
  }
  results.push(
    unresolved.length === 0
      ? { name: "*.localhost names resolve to this machine", status: "ok" }
      : {
          name: "*.localhost names resolve to this machine",
          status: "warn",
          detail: `not resolved: ${unresolved.join(", ")}`,
          fix: `add to /etc/hosts (Windows: C:\\Windows\\System32\\drivers\\etc\\hosts): 127.0.0.1 ${unresolved.join(" ")}`,
        },
  );

  if (!existsSync(caddyRootCertFile)) {
    results.push({
      name: "Caddy local CA trusted",
      status: "warn",
      detail: "certificate not exported yet",
      fix: "run `pnpm dev:trust-ca` while the services are running",
    });
  } else {
    const ours = new X509Certificate(readFileSync(caddyRootCertFile)).fingerprint256;
    const trusted = getCACertificates("system").some((pem) => {
      try {
        return new X509Certificate(pem).fingerprint256 === ours;
      } catch {
        return false;
      }
    });
    results.push(
      trusted
        ? { name: "Caddy local CA trusted by the operating system", status: "ok" }
        : {
            name: "Caddy local CA trusted by the operating system",
            status: "warn",
            detail: "browsers will show certificate warnings",
            fix: "run `pnpm dev:trust-ca` (Firefox may need the certificate imported separately)",
          },
    );
  }

  return printResults("ClubAdmin development environment", results);
}
