// SPDX-License-Identifier: AGPL-3.0-only
// pnpm --filter @clubadmin/api bench — measures the request pipeline on a
// trivial endpoint (no database), so regressions in framework overhead stay
// visible. Usage: node dist/scripts/bench.js [path] [seconds] [connections]
import { Agent, request } from "node:http";

import { createLogger } from "@clubadmin/server-kit";

import { createApp } from "../app.ts";
import { loadApiConfig } from "../config.ts";

const path = process.argv[2] ?? "/health/live";
const durationMs = Number(process.argv[3] ?? "10") * 1000;
const connections = Number(process.argv[4] ?? "1");

const config = loadApiConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  RATE_LIMIT_MAX: "100000000",
});
const app = await createApp(config, {
  logger: createLogger({ service: "bench", level: "silent" }),
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.getHttpServer().address();
const port = typeof address === "object" && address ? address.port : 0;
const agent = new Agent({ keepAlive: true, maxSockets: connections });

function once(): Promise<{ ms: number; ok: boolean }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, agent }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ms: performance.now() - started, ok: res.statusCode === 200 }));
    });
    req.on("error", () => resolve({ ms: performance.now() - started, ok: false }));
    req.end();
  });
}

const latencies: number[] = [];
let errors = 0;
const deadline = performance.now() + durationMs;
await Promise.all(
  Array.from({ length: connections }, async () => {
    while (performance.now() < deadline) {
      const { ms, ok } = await once();
      latencies.push(ms);
      if (!ok) errors++;
    }
  }),
);
agent.destroy();
await app.close();

latencies.sort((a, b) => a - b);
const pct = (p: number) =>
  (
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0
  ).toFixed(2);
process.stdout.write(
  `${path} (${connections} connection(s)): ${Math.round(latencies.length / (durationMs / 1000))} req/s, ` +
    `latency p50 ${pct(50)} ms, p95 ${pct(95)} ms, p99 ${pct(99)} ms, errors ${errors}\n`,
);
