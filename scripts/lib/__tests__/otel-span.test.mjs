// Tests for otel-span.mjs's OTLP/HTTP JSON payload builder and fire-and-forget exporter.
// A fake `fetch` is always injected — these never touch a real collector.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpanPayload, otelSpanExporter } from "../otel-span.mjs";

test("buildSpanPayload emits one span with the given name/timing and OTLP-shaped ids", () => {
  const payload = buildSpanPayload({ name: "gateway.route", startTimeMs: 1000, endTimeMs: 1250, attributes: {} });
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];

  assert.equal(span.name, "gateway.route");
  assert.equal(span.kind, 2);
  assert.equal(span.startTimeUnixNano, String(1000 * 1e6));
  assert.equal(span.endTimeUnixNano, String(1250 * 1e6));
  assert.match(span.traceId, /^[0-9a-f]{32}$/, "traceId must be 16 bytes of hex");
  assert.match(span.spanId, /^[0-9a-f]{16}$/, "spanId must be 8 bytes of hex");
  assert.equal(
    payload.resourceSpans[0].resource.attributes[0].value.stringValue,
    "route-gateway",
    "default service.name",
  );
});

test("buildSpanPayload maps string/boolean/number attributes to typed OTLP AnyValues", () => {
  const payload = buildSpanPayload({
    name: "gateway.route",
    startTimeMs: 0,
    endTimeMs: 1,
    attributes: {
      "ruflo.route.tier": "tier-fast",
      "ruflo.route.escalated": true,
      "ruflo.route.judge_score": 0.83,
      "ruflo.route.budget_rung": "0",
    },
  });
  const attrs = Object.fromEntries(
    payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => [a.key, a.value]),
  );

  assert.deepEqual(attrs["ruflo.route.tier"], { stringValue: "tier-fast" });
  assert.deepEqual(attrs["ruflo.route.escalated"], { boolValue: true });
  assert.deepEqual(attrs["ruflo.route.judge_score"], { doubleValue: 0.83 });
  assert.deepEqual(attrs["ruflo.route.budget_rung"], { stringValue: "0" });
});

test("buildSpanPayload drops undefined/null attributes instead of sending a typeless value", () => {
  const payload = buildSpanPayload({
    name: "gateway.route",
    startTimeMs: 0,
    endTimeMs: 1,
    attributes: { "ruflo.route.tier": "tier-private", "ruflo.route.floor": undefined, "ruflo.route.judge_score": null },
  });
  const keys = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => a.key);

  assert.deepEqual(keys, ["ruflo.route.tier"]);
});

test("otelSpanExporter POSTs the built payload as JSON to the configured OTLP endpoint", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  const emit = otelSpanExporter({ OTEL_ENDPOINT: "http://collector:4318/v1/traces" }, fakeFetch);

  await emit({ name: "gateway.route", startTimeMs: 0, endTimeMs: 5, attributes: { "ruflo.route.tier": "tier-heavy" } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://collector:4318/v1/traces");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans[0].name, "gateway.route");
});

test("otelSpanExporter never throws when the collector is unreachable — best-effort telemetry", async () => {
  const failingFetch = async () => { throw new Error("ECONNREFUSED"); };
  const emit = otelSpanExporter({}, failingFetch);

  await assert.doesNotReject(emit({ name: "gateway.route", startTimeMs: 0, endTimeMs: 1, attributes: {} }));
});
