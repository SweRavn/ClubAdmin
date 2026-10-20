// SPDX-License-Identifier: AGPL-3.0-only
// Loaded with `node --import ./dist/instrumentation.js` before main.js.
import { loadEnvFiles } from "@clubadmin/server-kit";
import { startTelemetry } from "@clubadmin/server-kit/telemetry";

loadEnvFiles();
await startTelemetry({ serviceName: "clubadmin-worker" });
