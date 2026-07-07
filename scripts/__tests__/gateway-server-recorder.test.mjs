// =============================================================================
// gateway-server-recorder.test.mjs — phase 3: recorder.mjs wired live. Proves: a real
// (non-stub) embedding lands in the corpus for every served request, recording never
// blocks or delays the client-visible response (fire-and-forget), and a recorder
// failure — e.g. RUFLO_REQUIRE_REAL_EMBEDDINGS=1 with no real embedder available —
// degrades exactly like a router/reflex failure: swallowed, never surfacing to the
// live response. Uses RoutingRecorder.open() with an injected deterministic embedder
// (recorder.mjs's own unchanged code, same convention as scripts/lib/__tests__/
// recorder.test.mjs), never the real ruvllm model, so these tests stay fast and
// hermetic regardless of which environment they run in.
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer } from "../gateway-server.mjs";
import { RoutingRecorder, promptHash } from "../lib/recorder.mjs";
import { listen, closeAll, request, chatUpstream, startReflexFakeUpstream } from "./test-harness.mjs";

const DIM = 8;
/** Deterministic distinct DIM-dim vector per text — never the real ruvllm model in tests. */
function fakeEmbed(text) {
  const h = promptHash(text);
  return Array.from({ length: DIM }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255 + 0.001);
}

function tmpCorpusPath() {
  return join(mkdtempSync(join(tmpdir(), "gateway-recorder-")), "corpus.rvf");
}

async function poll(fn, { attempts = 40, intervalMs = 25 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test("records a real, non-stub embedding per request and grows the corpus by exactly N", async () => {
  const corpusPath = tmpCorpusPath();
  const recorder = await RoutingRecorder.open({ corpusPath, dimension: DIM, embed: fakeEmbed });
  const recordFn = (decision) => recorder.record(decision);
  const { server: upstream, port: upstreamPort } = await chatUpstream();
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, recordFn });
  const gatewayPort = await listen(gateway);

  const N = 3;
  for (let i = 0; i < N; i++) {
    const res = await request(gatewayPort, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: `distinct prompt #${i}` }] }),
    });
    assert.equal(res.status, 200);
  }

  const grew = await poll(async () => (await recorder.count()) === N);
  assert.ok(grew, `expected corpus to grow to exactly ${N} rows, got ${await recorder.count()}`);

  await closeAll(gateway, upstream);
  await recorder.close();
  rmSync(join(corpusPath, ".."), { recursive: true, force: true });
});

test("recording is fire-and-forget — the response never waits on the recorder", async () => {
  let recorded = 0;
  const recordFn = () => new Promise((resolve) => setTimeout(() => { recorded++; resolve(); }, 200));
  const { server: upstream, port: upstreamPort } = await chatUpstream();
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, recordFn });
  const gatewayPort = await listen(gateway);

  const start = performance.now();
  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: "hello there" }] }),
  });
  const responseElapsed = performance.now() - start;

  assert.equal(res.status, 200);
  assert.ok(responseElapsed < 150, `response should return well before the 200ms recorder delay, took ${responseElapsed}ms`);
  assert.equal(recorded, 0, "the recorder should not have finished yet when the response returned");

  const settled = await poll(() => recorded === 1);
  assert.ok(settled, "the recorder eventually ran, fire-and-forget");

  await closeAll(gateway, upstream);
});

test("a recorder failure (e.g. RUFLO_REQUIRE_REAL_EMBEDDINGS=1 with no real embedder) never affects the live response — fails open", async () => {
  const recordFn = async () => {
    throw new Error("recorder: no real embedder (RUFLO_REQUIRE_REAL_EMBEDDINGS=1 and none installed)");
  };
  const { server: upstream, port: upstreamPort } = await chatUpstream();
  const gateway = createGatewayServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    recordFn,
    env: { RUFLO_REQUIRE_REAL_EMBEDDINGS: "1" },
  });
  const gatewayPort = await listen(gateway);

  let rejection = null;
  const onRejection = (err) => { rejection = err; };
  process.once("unhandledRejection", onRejection);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: "hi" }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the rejected recordFn promise settle

  process.removeListener("unhandledRejection", onRejection);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).choices[0].message.content, "an answer");
  assert.equal(rejection, null, `recorder failure leaked as an unhandled rejection: ${rejection?.message}`);

  await closeAll(gateway, upstream);
});

test("records category (metadata.agentType), tier, judge_score, and the D11 escalation outcome for a scored request", async () => {
  const { server: upstream } = startReflexFakeUpstream({ judgeScore: 0.0 }); // below default threshold -> escalates
  const upstreamPort = await listen(upstream);
  let captured = null;
  const recordFn = async (decision) => { captured = decision; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, recordFn });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", metadata: { agentType: "coder" }, messages: [{ role: "user", content: "what is 2+2?" }] }),
  });

  assert.equal(res.status, 200);
  assert.ok(captured, "recordFn should have been called");
  assert.equal(captured.category, "coder");
  assert.equal(captured.tier, "tier-fast");
  assert.equal(captured.judge_score, 0.0);
  assert.equal(captured.escalated, true);
  assert.equal(captured.success, false, "an escalation means the local decision was a corpus NEGATIVE (D11)");
  assert.ok(captured.latency >= 0);

  await closeAll(gateway, upstream);
});

test("records judge_score:null, escalated:false, and category 'unrouted' for a non-scorable (tier-private) request with no agentType", async () => {
  const { server: upstream, port: upstreamPort } = await chatUpstream("private answer");
  let captured = null;
  const recordFn = async (decision) => { captured = decision; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, recordFn });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: "my secret" }] }),
  });

  assert.equal(res.status, 200);
  assert.ok(captured, "recordFn should have been called for a served tier-private request");
  assert.equal(captured.category, "unrouted");
  assert.equal(captured.tier, "tier-private");
  assert.equal(captured.judge_score, null);
  assert.equal(captured.escalated, false);
  assert.equal(captured.success, true);

  await closeAll(gateway, upstream);
});

test("never calls the recorder for a bodyless request with no served tier", async () => {
  const { server: upstream, port: upstreamPort } = await chatUpstream();
  let called = false;
  const recordFn = async () => { called = true; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, recordFn });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/health/liveliness");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(res.status, 200);
  assert.equal(called, false, "a bodyless GET never resolves a served tier — nothing real to record");

  await closeAll(gateway, upstream);
});

// =============================================================================
// Regression tests — 4 real defects found by an independent code-review workflow
// and fixed in the same phase-3 diff:
//   [0] tier-frontier (bufferable but not judged) always recorded cost:0 — usage was
//       never captured on the non-judgeable path.
//   [3]/[5] an escalated request recorded cost:0 despite a real, billable frontier
//       call having been made — only the local tier's (free) usage was ever captured.
//   [1] an upstream connection error after a tier was resolved never recorded the
//       failure — silently dropped from the corpus instead of a D11 negative.
//   [2] an oversized/aborted response for a scorable tier never recorded the failure
//       either — same silent-drop bug on a different termination path.
// =============================================================================

/** A chat-completions echo that also reports token usage, for cost-accounting tests. */
function chatUpstreamWithUsage(answer, totalTokens) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: totalTokens } }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("captures real usage/cost for a direct tier-frontier serve (bufferable but never judged)", async () => {
  const { server: upstream, port: upstreamPort } = await chatUpstreamWithUsage("a frontier answer", 1000);
  let captured = null;
  const recordFn = async (decision) => { captured = decision; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, recordFn });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-frontier", messages: [{ role: "user", content: "expensive question" }] }),
  });

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).choices[0].message.content, "a frontier answer");
  assert.ok(captured, "recordFn should have been called for a direct tier-frontier serve");
  assert.equal(captured.tier, "tier-frontier");
  // 1000 tokens * $45/1M tokens (train-router.mjs's DEFAULT_CANDIDATES) = $0.045 — a
  // real, non-zero cost; before the fix this was always 0 (usage was never captured
  // on the non-judged buffering path).
  assert.equal(captured.cost, 0.045, "tier-frontier's real cost must be captured, not silently recorded as free");

  await closeAll(gateway, upstream);
});

test("records the REAL total cost (local + escalation) when a request escalates, not just the free local tier's cost", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* leave {} */ }
      requests.push(body);
      const isJudgeCall = Array.isArray(body.messages) && body.messages.some((m) => m.role === "system");
      res.writeHead(200, { "content-type": "application/json" });
      if (isJudgeCall) {
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 0.0 }) } }] })); // below threshold -> escalates
      } else if (body.model === "tier-frontier") {
        res.end(JSON.stringify({ choices: [{ message: { content: "frontier answer" } }], model: "tier-frontier", usage: { total_tokens: 2000 } }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: "local answer" } }], model: body.model, usage: { total_tokens: 500 } }));
      }
    });
  });
  const upstreamPort = await listen(server);
  let captured = null;
  const recordFn = async (decision) => { captured = decision; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, recordFn });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", messages: [{ role: "user", content: "hard question" }] }),
  });

  assert.equal(JSON.parse(res.body).choices[0].message.content, "frontier answer");
  assert.ok(captured, "recordFn should have been called");
  assert.equal(captured.tier, "tier-fast", "D11: the row still represents the LOCAL tier's (failed) decision");
  assert.equal(captured.escalated, true);
  assert.equal(captured.success, false);
  // tier-fast's own usage (500 tok * $0/M = $0) + the REAL escalation call's usage
  // (2000 tok * $45/M = $0.09) = $0.09 total — before the fix this was always 0,
  // since only the free local tier's usage was ever captured for an escalated row.
  assert.equal(captured.cost, 0.09, "an escalated row must capture the real, billable escalation cost, not just the free local tier's");

  await closeAll(gateway, server);
});

test("records a D11 negative outcome when the upstream is unreachable after a tier was resolved", async () => {
  let captured = null;
  const recordFn = async (decision) => { captured = decision; };
  const gateway = createGatewayServer({ upstream: "http://127.0.0.1:1", recordFn }); // nothing listens on port 1
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", messages: [{ role: "user", content: "hello" }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // recordServed fires immediately here, but give it a tick

  assert.equal(res.status, 502);
  assert.ok(captured, "an upstream-unreachable failure for a resolved tier must still be recorded (D11), not silently dropped");
  assert.equal(captured.tier, "tier-fast");
  assert.equal(captured.success, false);

  await closeAll(gateway);
});

test("records a D11 negative outcome when a scorable-tier response is too large to buffer", async () => {
  const oversized = "x".repeat(11 * 1024 * 1024); // over MAX_BODY_BYTES (10MB)
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: oversized } }] }));
  });
  const upstreamPort = await listen(server);
  let captured = null;
  const recordFn = async (decision) => { captured = decision; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, recordFn });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", messages: [{ role: "user", content: "hello" }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(res.status, 502);
  assert.ok(captured, "an oversized-response failure for a scorable tier must still be recorded (D11), not silently dropped");
  assert.equal(captured.tier, "tier-fast");
  assert.equal(captured.success, false);

  await closeAll(gateway, server);
});
