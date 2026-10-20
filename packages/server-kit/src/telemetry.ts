// SPDX-License-Identifier: AGPL-3.0-only
// OpenTelemetry tracing and metrics via OTLP. Loaded with
// `node --import ./dist/instrumentation.js` so instrumentation is in place
// before application modules load. Does nothing (and loads nothing) unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set. Span attributes never carry personal
// data: query strings are removed and Redis/SQL statements carry no values.

import { register } from "node:module";

import { scrubSpanAttributes } from "./telemetry-scrub.ts";

export { scrubSpanAttributes } from "./telemetry-scrub.ts";

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
}

/** Starts OpenTelemetry if configured. Returns a shutdown function, or undefined. */
export async function startTelemetry(
  options: TelemetryOptions,
): Promise<(() => Promise<void>) | undefined> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;

  // ESM modules can only be instrumented through a loader hook.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [
    { OTLPMetricExporter },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { IORedisInstrumentation },
    { PgInstrumentation },
    { resourceFromAttributes },
    { PeriodicExportingMetricReader },
    { NodeSDK },
    { BatchSpanProcessor },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
  ] = await Promise.all([
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-ioredis"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/semantic-conventions"),
  ]);

  const exporter = new BatchSpanProcessor(new OTLPTraceExporter());
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? process.env.APP_VERSION ?? "0.0.0",
    }),
    spanProcessors: [
      {
        onStart: (span, parentContext) => exporter.onStart(span, parentContext),
        onEnd: (span) => {
          scrubSpanAttributes(span.attributes);
          exporter.onEnd(span);
        },
        forceFlush: () => exporter.forceFlush(),
        shutdown: () => exporter.shutdown(),
      },
    ],
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => request.url?.startsWith("/health/") ?? false,
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      // Only the command name, never keys or values.
      new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
    ],
  });
  sdk.start();
  return () => sdk.shutdown();
}
