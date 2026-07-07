// =============================================================================
// fake-upstream-server.test.mjs — the controllable proxy that stands in for a real
// backend under Bifrost/Helicone's CI legs (neither has LiteLLM's mock_response/
// mock_testing_fallbacks). Asserts: normal mode is a faithful passthrough (parity with
// gateway-server.mjs's own phase-0 proxy contract), /control arms a bounded intercept
// that auto-reverts, GET requests are never intercepted, and an unreachable real
// upstream degrades to a clean 502 in normal mode.
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createFakeUpstreamServer, FORCED_BAD_ANSWER } from "../fake-upstream-server.mjs";
import { listen, closeAll, request } from "../../__tests__/test-harness.mjs";

async function startRealUpstream(handler) {
  const server = http.createServer(handler);
  const port = await listen(server);
  return { server, port };
}

function control(port, body) {
  return request(port, "/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("normal mode forwards method, path, and body verbatim to the real upstream", async () => {
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);
  const requestBody = JSON.stringify({ model: "tier-fast", messages: [{ role: "user", content: "hi" }] });

  const res = await request(fakePort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  });

  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.url, "/v1/chat/completions");
  assert.equal(parsed.body, requestBody);

  await closeAll(fake, real);
});

test("normal mode forwards response status and body verbatim from the real upstream", async () => {
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-upstream-marker": "REAL-OK" });
    res.end(JSON.stringify({ ok: true }));
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);

  const res = await request(fakePort, "/v1/models");

  assert.equal(res.status, 200);
  assert.equal(res.headers["x-upstream-marker"], "REAL-OK");
  await closeAll(fake, real);
});

test("armed bad-answer mode returns the forced answer instead of hitting the real upstream", async () => {
  let realCalls = 0;
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    realCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "real answer" } }] }));
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);

  const controlRes = await control(fakePort, { mode: "bad-answer", times: 1 });
  assert.equal(controlRes.status, 200);
  assert.deepEqual(JSON.parse(controlRes.body), { ok: true, mode: "bad-answer", remaining: 1 });

  const res = await request(fakePort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, FORCED_BAD_ANSWER);
  assert.equal(realCalls, 0, "the real upstream must never be called while the intercept is armed");

  await closeAll(fake, real);
});

test("armed intercept auto-reverts to passthrough after `times` requests", async () => {
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "real answer" } }] }));
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);
  const post = () =>
    request(fakePort, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tier-fast", messages: [] }),
    });

  await control(fakePort, { mode: "fail", times: 2 });

  const first = await post();
  const second = await post();
  const third = await post();

  assert.equal(first.status, 500);
  assert.equal(second.status, 500);
  assert.equal(third.status, 200, "third call must fall back to real passthrough once `times` is exhausted");
  assert.equal(JSON.parse(third.body).choices[0].message.content, "real answer");

  await closeAll(fake, real);
});

test("armed fail mode returns 500 without calling the real upstream", async () => {
  let realCalls = 0;
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    realCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);

  await control(fakePort, { mode: "fail", times: 1 });
  const res = await request(fakePort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(res.status, 500);
  assert.equal(realCalls, 0);
  await closeAll(fake, real);
});

test("GET requests are never intercepted, even while armed", async () => {
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ real: true }));
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);

  await control(fakePort, { mode: "fail", times: 5 });
  const res = await request(fakePort, "/v1/models");

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { real: true });
  await closeAll(fake, real);
});

test("GET /health reports current mode without consuming the intercept", async () => {
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);

  await control(fakePort, { mode: "bad-answer", times: 3 });
  const health = await request(fakePort, "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "ok", mode: "bad-answer", remaining: 3 });

  await closeAll(fake, real);
});

test("POST /control with mode 'normal' clears any armed intercept", async () => {
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "real answer" } }] }));
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);

  await control(fakePort, { mode: "bad-answer", times: 5 });
  await control(fakePort, { mode: "normal" });
  const res = await request(fakePort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", messages: [] }),
  });

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).choices[0].message.content, "real answer");
  await closeAll(fake, real);
});

test("real upstream unreachable in normal mode degrades to a clean 502", async () => {
  const fake = createFakeUpstreamServer({ upstreamUrl: "http://127.0.0.1:1" }); // port 1: nothing listens, connection refused
  const fakePort = await listen(fake);

  const res = await request(fakePort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(res.status, 502);
  await closeAll(fake);
});

test("malformed /control body is rejected with 400 and leaves state unchanged", async () => {
  const { server: real, port: realPort } = await startRealUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "real answer" } }] }));
  });
  const fake = createFakeUpstreamServer({ upstreamUrl: `http://127.0.0.1:${realPort}` });
  const fakePort = await listen(fake);

  const res = await request(fakePort, "/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });

  assert.equal(res.status, 400);
  const health = await request(fakePort, "/health");
  assert.deepEqual(JSON.parse(health.body), { status: "ok", mode: "normal", remaining: 0 });
  await closeAll(fake, real);
});
