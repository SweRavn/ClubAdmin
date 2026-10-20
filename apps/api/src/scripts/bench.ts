// SPDX-License-Identifier: AGPL-3.0-only
// pnpm --filter @clubadmin/api bench — measures framework overhead on a
// trivial endpoint, so regressions in the request pipeline stay visible.
// Usage: node dist/scripts/bench.js [path] [seconds] [connections]
import { createLogger } from "@clubadmin/server-kit";
import autocannon from "autocannon";

import { createApp } from "../app.ts";
import { loadApiConfig } from "../config.ts";

const path = process.argv[2] ?? "/health/live";
const duration = Number(process.argv[3] ?? "10");
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

const result = await autocannon({ url: `http://127.0.0.1:${port}${path}`, connections, duration });
await app.close();

process.stdout.write(
  `${path} (${connections} connection(s)): ${Math.round(result.requests.average)} req/s, latency p50 ${result.latency.p50} ms, ` +
    `p97.5 ${result.latency.p97_5} ms, p99 ${result.latency.p99} ms, errors ${result.errors + result.non2xx}\n`,
);
