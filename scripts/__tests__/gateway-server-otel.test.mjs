// =============================================================================
// gateway-server-otel.test.mjs — phase 5: an OTel span per gateway decision, carrying
// ruflo.route.{tier,floor,category,budget_rung,escalated,judge_score} attributes.
// Uses an injected spanFn (createGatewayServer's opts.spanFn), never a real collector —
// mirrors gateway-server-recorder.test.mjs's injected-recordFn convention so these tests
// stay fast and hermetic.
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createGatewayServer } from "../gateway-server.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closeAll(...servers) {
  return Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
}

function request(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function chatUpstream(answer = "an answer") {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Same three-role fake upstream as phase 2/3's tests (serving / judge / escalation calls). */
function startReflexFakeUpstream({ servedAnswer = "local answer", judgeScore = 1.0, escalatedAnswer = "frontier answer" } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* leave {} */ }
      const isJudgeCall = Array.isArray(body.messages) && body.messages.some((m) => m.role === "system");
      res.writeHead(200, { "content-type": "application/json" });
      if (isJudgeCall) {
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: judgeScore }) } }] }));
      } else if (body.model === "tier-frontier") {
        res.end(JSON.stringify({ choices: [{ message: { content: escalatedAnswer } }], model: "tier-frontier" }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: servedAnswer } }], model: body.model }));
      }
    });
  });
  return { server };
}

async function poll(fn, { attempts = 40, intervalMs = 25 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test("emits a span with ruflo.route.{tier,category,escalated,judge_score} for an agentType-routed, escalated request", async () => {
  const { server: upstream } = startReflexFakeUpstream({ judgeScore: 0.0 }); // below default threshold -> escalates
  const upstreamPort = await listen(upstream);
  let captured = null;
  const spanFn = async (span) => { captured = span; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, spanFn, recordFn: async () => {} });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // "auto" (not an explicit tier alias) is required to actually invoke router.mjs's
    // route() — an explicit "tier-fast" would hit the bypass branch first (phase 1) and
    // never produce a floor/budget_rung at all, same convention as gateway-server.test.mjs.
    body: JSON.stringify({ model: "auto", metadata: { agentType: "coder" }, messages: [{ role: "user", content: "what is 2+2?" }] }),
  });

  assert.equal(res.status, 200);
  const settled = await poll(() => captured !== null);
  assert.ok(settled, "spanFn should have been called");

  assert.equal(captured.name, "gateway.route");
  assert.equal(captured.attributes["ruflo.route.tier"], "tier-fast");
  assert.equal(captured.attributes["ruflo.route.category"], "coder");
  assert.equal(captured.attributes["ruflo.route.escalated"], true);
  assert.equal(captured.attributes["ruflo.route.judge_score"], 0.0);
  assert.equal(captured.attributes["ruflo.route.judge_score_bucket"], "0.0-0.2");
  assert.equal(captured.attributes["ruflo.route.floor"], "tier-fast", "the router-resolved floor for this agent type/category");
  assert.equal(typeof captured.attributes["ruflo.route.budget_rung"], "string", "budget_rung is only known when router.mjs actually ran");
  assert.ok(captured.endTimeMs >= captured.startTimeMs);

  await closeAll(gateway, upstream);
});

test("judge_score_bucket is 'unscored' (never null/undefined) for a request that never reaches the judge", async () => {
  const { server: upstream, port: upstreamPort } = await chatUpstream("private answer");
  let captured = null;
  const spanFn = async (span) => { captured = span; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, spanFn, recordFn: async () => {} });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: "my secret" }] }),
  });

  assert.equal(res.status, 200);
  const settled = await poll(() => captured !== null);
  assert.ok(settled, "spanFn should have been called");
  assert.equal(captured.attributes["ruflo.route.judge_score"], null);
  assert.equal(captured.attributes["ruflo.route.judge_score_bucket"], "unscored");

  await closeAll(gateway, upstream);
});

test("judge_score_bucket covers the top boundary (1.0) in the last bucket, not a 6th one", async () => {
  const { server: upstream } = startReflexFakeUpstream({ judgeScore: 1.0 }); // at/above threshold -> not escalated
  const upstreamPort = await listen(upstream);
  let captured = null;
  const spanFn = async (span) => { captured = span; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, spanFn, recordFn: async () => {} });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", metadata: { agentType: "coder" }, messages: [{ role: "user", content: "what is 2+2?" }] }),
  });

  assert.equal(res.status, 200);
  const settled = await poll(() => captured !== null);
  assert.ok(settled, "spanFn should have been called");
  assert.equal(captured.attributes["ruflo.route.judge_score"], 1.0);
  assert.equal(captured.attributes["ruflo.route.judge_score_bucket"], "0.8-1.0");

  await closeAll(gateway, upstream);
});

test("omits floor/budget_rung for an explicit-tier (bypass) request — router.mjs never ran", async () => {
  const { server: upstream, port: upstreamPort } = await chatUpstream("private answer");
  let captured = null;
  const spanFn = async (span) => { captured = span; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, spanFn, recordFn: async () => {} });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: "my secret" }] }),
  });

  assert.equal(res.status, 200);
  const settled = await poll(() => captured !== null);
  assert.ok(settled, "spanFn should have been called");
  assert.equal(captured.attributes["ruflo.route.tier"], "tier-private");
  assert.equal(captured.attributes["ruflo.route.floor"], undefined);
  assert.equal(captured.attributes["ruflo.route.budget_rung"], undefined);
  assert.equal(captured.attributes["ruflo.route.judge_score"], null, "tier-private is never scored");

  await closeAll(gateway, upstream);
});

test("omits floor/budget_rung and reports the ORIGINAL model when router.mjs throws — fail-open, same convention as recording", async () => {
  const { server: upstream, port: upstreamPort } = await chatUpstream();
  let captured = null;
  const spanFn = async (span) => { captured = span; };
  const routeFn = async () => { throw new Error("router.mjs blew up"); };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, spanFn, routeFn, recordFn: async () => {} });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", metadata: { agentType: "coder" }, messages: [{ role: "user", content: "hello" }] }),
  });

  assert.equal(res.status, 200);
  const settled = await poll(() => captured !== null);
  assert.ok(settled, "spanFn should still fire even when router.mjs throws — a resolved (fail-open) decision is still a real decision");
  assert.equal(captured.attributes["ruflo.route.tier"], "auto", "fail-open forwards the client's original model unchanged");
  assert.equal(captured.attributes["ruflo.route.floor"], undefined);
  assert.equal(captured.attributes["ruflo.route.budget_rung"], undefined);

  await closeAll(gateway, upstream);
});

test("span emission is fire-and-forget — the response never waits on it", async () => {
  let emitted = 0;
  const spanFn = () => new Promise((resolve) => setTimeout(() => { emitted++; resolve(); }, 200));
  const { server: upstream, port: upstreamPort } = await chatUpstream();
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, spanFn, recordFn: async () => {} });
  const gatewayPort = await listen(gateway);

  const start = performance.now();
  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: "hello there" }] }),
  });
  const responseElapsed = performance.now() - start;

  assert.equal(res.status, 200);
  assert.ok(responseElapsed < 150, `response should return well before the 200ms span-emission delay, took ${responseElapsed}ms`);
  assert.equal(emitted, 0, "the span should not have been emitted yet when the response returned");

  const settled = await poll(() => emitted === 1);
  assert.ok(settled, "the span eventually emitted, fire-and-forget");

  await closeAll(gateway, upstream);
});

test("a spanFn failure never affects the live response — fails open, same as a recorder failure", async () => {
  const spanFn = async () => { throw new Error("collector unreachable"); };
  const { server: upstream, port: upstreamPort } = await chatUpstream();
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, spanFn, recordFn: async () => {} });
  const gatewayPort = await listen(gateway);

  let rejection = null;
  const onRejection = (err) => { rejection = err; };
  process.once("unhandledRejection", onRejection);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: "hi" }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the rejected spanFn promise settle

  process.removeListener("unhandledRejection", onRejection);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).choices[0].message.content, "an answer");
  assert.equal(rejection, null, `spanFn failure leaked as an unhandled rejection: ${rejection?.message}`);

  await closeAll(gateway, upstream);
});

test("never calls spanFn for a bodyless request with no served tier", async () => {
  const { server: upstream, port: upstreamPort } = await chatUpstream();
  let called = false;
  const spanFn = async () => { called = true; };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, spanFn, recordFn: async () => {} });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/health/liveliness");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(res.status, 200);
  assert.equal(called, false, "a bodyless GET never resolves a served tier — nothing real to record");

  await closeAll(gateway, upstream);
});

test("records a D11-parallel span (success:false attributes aside — tier/category still present) when the upstream is unreachable after a tier was resolved", async () => {
  let captured = null;
  const spanFn = async (span) => { captured = span; };
  const gateway = createGatewayServer({ upstream: "http://127.0.0.1:1", spanFn, recordFn: async () => {} }); // nothing listens on port 1

  const gatewayPort = await listen(gateway);
  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", messages: [{ role: "user", content: "hello" }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(res.status, 502);
  assert.ok(captured, "an upstream-unreachable failure for a resolved tier must still emit a span, not silently drop telemetry");
  assert.equal(captured.attributes["ruflo.route.tier"], "tier-fast");

  await closeAll(gateway);
});
