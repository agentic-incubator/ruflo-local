// =============================================================================
// otel-span.mjs — minimal, dependency-free OTLP/HTTP JSON span export.
//
// This repo's zero-runtime-deps convention (package.json: "the only deps are OPTIONAL
// packages, all loaded via dynamic import with graceful fallback") rules out pulling in
// the full @opentelemetry/* SDK for a single span-per-request use case. The collector's
// otlp receiver (config/observability/otel-collector-config.yaml) accepts OTLP/HTTP as
// JSON as well as protobuf, so this hand-builds the JSON wire format and POSTs it with
// the platform `fetch` — the SAME :4318 /v1/traces endpoint litellm's own
// OTEL_EXPORTER=otlp_http callback already posts gen_ai.* spans to (config.mjs's
// otelConfig), so both flow through one shared traces pipeline, never a second one.
// =============================================================================

import { randomBytes } from "node:crypto";
import { otelConfig } from "./config.mjs";

const hex = (nBytes) => randomBytes(nBytes).toString("hex");

/** OTLP AnyValue for a JS primitive. Caller filters out undefined/null before this runs. */
function anyValue(v) {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  return { stringValue: String(v) };
}

/**
 * Builds one OTLP/HTTP JSON trace-export payload (a single span). `attributes` is a
 * plain {key: value} object — undefined/null values are dropped rather than sent as a
 * typeless attribute, so an unrouted request's absent floor/budget_rung simply omits
 * those keys instead of emitting a bogus empty string.
 * @returns {object} the resourceSpans payload, ready for JSON.stringify
 */
export function buildSpanPayload({ name, startTimeMs, endTimeMs, attributes = {}, serviceName = "route-gateway" }) {
  const otAttributes = Object.entries(attributes)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeSpans: [
          {
            scope: { name: "route-gateway" },
            spans: [
              {
                traceId: hex(16),
                spanId: hex(8),
                name,
                kind: 2, // SPAN_KIND_SERVER
                startTimeUnixNano: String(Math.round(startTimeMs * 1e6)),
                endTimeUnixNano: String(Math.round(endTimeMs * 1e6)),
                attributes: otAttributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Fire-and-forget OTLP/HTTP JSON exporter — POSTs to the same collector endpoint
 * (OTEL_ENDPOINT, config.mjs's otelConfig) litellm's own gen_ai spans already use.
 * Never throws: a collector that's down/unreachable is best-effort telemetry, exactly
 * like a recorder or reflex failure — it must never affect an already-served response.
 */
export function otelSpanExporter(env = process.env, fetchImpl = fetch) {
  const { endpoint } = otelConfig(env);
  return async function emitSpan(spanInput) {
    try {
      await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSpanPayload(spanInput)),
      });
    } catch {
      // collector unreachable/down — telemetry is best-effort, never surfaces to the caller.
    }
  };
}
