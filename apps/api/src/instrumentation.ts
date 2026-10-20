// SPDX-License-Identifier: AGPL-3.0-only
// Loaded with `node --import ./dist/instrumentation.js` before main.js, so
// OpenTelemetry can instrument modules as they load.
import { loadEnvFiles } from "@clubadmin/server-kit";
import { startTelemetry } from "@clubadmin/server-kit/telemetry";

loadEnvFiles();
await startTelemetry({ serviceName: "clubadmin-api" });
