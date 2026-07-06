// =============================================================================
// gateway-server.test.mjs — phase 0: pure passthrough proxy parity.
//
// Spins up a fake upstream (echoes method/path/headers/body back as JSON, or a canned
// response) and the real gateway server pointed at it, then asserts the proxy forwards
// every request byte-for-byte and streams the response back unchanged — the parity the
// phase-0 DoD requires before any routing/judge/recording logic is added in later phases.
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createGatewayServer } from "../gateway-server.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closeAll(...servers) {
  return Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
}

async function startFakeUpstream(handler) {
  const server = http.createServer(handler);
  const port = await listen(server);
  return { server, port };
}

function request(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test("forwards method, path, and body verbatim to the upstream", async () => {
  const { server: upstream, port: upstreamPort } = await startFakeUpstream((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);
  const requestBody = JSON.stringify({ model: "tier-fast", messages: [] });

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  });

  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.url, "/v1/chat/completions");
  assert.equal(parsed.body, requestBody);

  await closeAll(gateway, upstream);
});

test("forwards response status, headers, and body verbatim from the upstream", async () => {
  const { server: upstream, port: upstreamPort } = await startFakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-upstream-marker": "TIER1-OK" });
    res.end(JSON.stringify({ ok: true }));
  });
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/health/liveliness");

  assert.equal(res.status, 200);
  assert.equal(res.headers["x-upstream-marker"], "TIER1-OK");
  assert.equal(res.body, JSON.stringify({ ok: true }));

  await closeAll(gateway, upstream);
});

test("streams a large response back without buffering it whole", async () => {
  const payload = "x".repeat(5_000_000); // large enough that a naive buffer-then-send would be slow/lossy
  const { server: upstream, port: upstreamPort } = await startFakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(payload);
  });
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/big");

  assert.equal(res.body.length, payload.length);
  assert.equal(res.body, payload);

  await closeAll(gateway, upstream);
});

test("returns a clean 502 (never crashes) when the upstream is unreachable", async () => {
  const gateway = createGatewayServer({ upstream: "http://127.0.0.1:1" }); // nothing listens on port 1
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/health/liveliness");

  assert.equal(res.status, 502);

  await closeAll(gateway);
});

test("survives a client hard-resetting mid-response instead of crashing the process", async () => {
  // A closed browser tab or killed curl sends a TCP RST, not a clean FIN — reproduce that
  // with a raw socket.destroy() (no HTTP-level close handshake) rather than the higher-level
  // client API, whose own keep-alive/retry behavior would make the race non-deterministic.
  const { server: upstream, port: upstreamPort } = await startFakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first-chunk-");
    req.on("close", () => res.destroy()); // unwind once the gateway drops this leg, don't hang open
  });
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  let uncaught = null;
  const onUncaught = (err) => {
    uncaught = err;
  };
  process.once("uncaughtException", onUncaught);

  await new Promise((resolve, reject) => {
    const socket = net.connect(gatewayPort, "127.0.0.1", () => {
      socket.write("GET /streaming HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
    });
    socket.once("data", () => socket.destroy()); // hard reset the instant bytes arrive
    socket.on("close", resolve);
    socket.on("error", () => {}); // an ECONNRESET on our own destroy() is expected, not a failure
    setTimeout(reject, 2000, new Error("timed out waiting for the socket to close"));
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the gateway's error handlers settle

  process.removeListener("uncaughtException", onUncaught);
  assert.equal(uncaught, null, `gateway crashed: ${uncaught?.stack}`);

  await closeAll(gateway, upstream);
});

test("survives a client disconnecting before the upstream ever responds (502 race)", async () => {
  // The client drops, THEN the upstream call errors — res is already destroyed with no
  // per-response listener yet at that point, so the 502 write path itself must guard.
  const gateway = createGatewayServer({ upstream: "http://127.0.0.1:1" }); // nothing listens on port 1

  let uncaught = null;
  const onUncaught = (err) => {
    uncaught = err;
  };
  process.once("uncaughtException", onUncaught);

  const gatewayPort = await listen(gateway);
  await new Promise((resolve) => {
    const socket = net.connect(gatewayPort, "127.0.0.1", () => {
      socket.write("GET /health/liveliness HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      socket.destroy(); // disconnect immediately, before the (unreachable) upstream can ever answer
    });
    socket.on("close", resolve);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the upstream connect() attempt fail

  process.removeListener("uncaughtException", onUncaught);
  assert.equal(uncaught, null, `gateway crashed: ${uncaught?.stack}`);

  await closeAll(gateway);
});

test("GATEWAY_UPSTREAM_URL env override selects the upstream when no explicit upstream is passed", async () => {
  const { server: upstream, port: upstreamPort } = await startFakeUpstream((req, res) => {
    res.writeHead(200, {});
    res.end("via-env-override");
  });
  const gateway = createGatewayServer({ env: { GATEWAY_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}` } });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/anything");

  assert.equal(res.body, "via-env-override");

  await closeAll(gateway, upstream);
});

// =============================================================================
// Phase 1 — router.mjs wiring: metadata.agentType routing, explicit-tier bypass
// (the privacy pin included), and fail-open when route() throws or is absent a signal.
// =============================================================================

function echoUpstream() {
  return startFakeUpstream((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ receivedBody: Buffer.concat(chunks).toString() }));
    });
  });
}

async function receivedModel(res) {
  return JSON.parse(JSON.parse(res.body).receivedBody).model;
}

test("rewrites `model` to the router-resolved tier when metadata.agentType is present", async () => {
  const { server: upstream, port: upstreamPort } = await echoUpstream();
  let callArgs = null;
  const routeFn = async (args) => {
    callArgs = args;
    return { tier: "tier-heavy" };
  };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, routeFn });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", metadata: { agentType: "reviewer" }, messages: [] }),
  });

  assert.equal(await receivedModel(res), "tier-heavy");
  assert.equal(callArgs.agentType, "reviewer");

  await closeAll(gateway, upstream);
});

test("leaves an explicit tier alias in `model` untouched and never calls route()", async () => {
  for (const tier of ["tier-fast", "tier-heavy", "tier-frontier", "tier-private"]) {
    const { server: upstream, port: upstreamPort } = await echoUpstream();
    let called = false;
    const routeFn = async () => {
      called = true;
      return { tier: "tier-frontier" };
    };
    const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, routeFn });
    const gatewayPort = await listen(gateway);
    const requestBody = JSON.stringify({ model: tier, metadata: { agentType: "reviewer" }, messages: [] });

    const res = await request(gatewayPort, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });

    assert.equal(await receivedModel(res), tier, `explicit tier ${tier} must pass through unchanged`);
    assert.equal(called, false, `route() must never be called for explicit tier ${tier}`);

    await closeAll(gateway, upstream);
  }
});

test("recognizes a mis-cased/whitespace-varied explicit tier and never calls route() (privacy-pin canonicalization)", async () => {
  // Confirmed exploit from Tier-3 review: an exact-string-only bypass check let
  // "Tier-Private" (or " tier-private") fall through to agentType-based routing,
  // silently reassigning the served tier to something router.mjs picked instead of
  // staying pinned — the mechanism phase 2 turns into an actual off-box leak. Canonical
  // matching (reflex.mjs's own canonicalTier) must catch every case/whitespace variant.
  for (const [raw, canonical] of [
    ["Tier-Private", "tier-private"],
    [" tier-private", "tier-private"],
    ["TIER-FAST", "tier-fast"],
    ["tier-heavy ", "tier-heavy"],
  ]) {
    const { server: upstream, port: upstreamPort } = await echoUpstream();
    let called = false;
    const routeFn = async () => {
      called = true;
      return { tier: "tier-frontier" };
    };
    const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, routeFn });
    const gatewayPort = await listen(gateway);
    const requestBody = JSON.stringify({ model: raw, metadata: { agentType: "researcher" }, messages: [] });

    const res = await request(gatewayPort, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });

    assert.equal(await receivedModel(res), canonical, `"${raw}" must be recognized as ${canonical} and forwarded canonicalized`);
    assert.equal(called, false, `route() must never be called for "${raw}" (an explicit tier in disguise)`);

    await closeAll(gateway, upstream);
  }
});

test("fails open (forwards the original model) when route() throws", async () => {
  const { server: upstream, port: upstreamPort } = await echoUpstream();
  const routeFn = async () => {
    throw new Error("router.mjs blew up");
  };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, routeFn });
  const gatewayPort = await listen(gateway);
  const requestBody = JSON.stringify({ model: "auto", metadata: { agentType: "coder" }, messages: [] });

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  });

  assert.equal(res.status, 200);
  assert.equal(await receivedModel(res), "auto"); // unchanged — fail open, never crash

  await closeAll(gateway, upstream);
});

test("forwards unchanged when there is no explicit tier and no metadata.agentType", async () => {
  const { server: upstream, port: upstreamPort } = await echoUpstream();
  let called = false;
  const routeFn = async () => {
    called = true;
    return { tier: "tier-frontier" };
  };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, routeFn });
  const gatewayPort = await listen(gateway);
  const requestBody = JSON.stringify({ model: "gpt-4-ish", messages: [] });

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  });

  assert.equal(await receivedModel(res), "gpt-4-ish");
  assert.equal(called, false);

  await closeAll(gateway, upstream);
});

test("treats an empty-string metadata.agentType the same as no agentType at all", async () => {
  const { server: upstream, port: upstreamPort } = await echoUpstream();
  let called = false;
  const routeFn = async () => {
    called = true;
    return { tier: "tier-frontier" };
  };
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}`, routeFn });
  const gatewayPort = await listen(gateway);
  const requestBody = JSON.stringify({ model: "auto", metadata: { agentType: "" }, messages: [] });

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  });

  assert.equal(await receivedModel(res), "auto");
  assert.equal(called, false);

  await closeAll(gateway, upstream);
});

test("wires the real router.mjs route() by default and honors the shipped policy floor", async () => {
  // No routeFn override — exercises actual production wiring: real router.mjs + the
  // shipped config/routing/router-policy.example.json, which floors "reviewer" at
  // tier-heavy. The real budgetSnapshot() hits this same fake upstream's /metrics
  // (echoed back, not real Prometheus text) and reads 0 utilization — harmless here
  // since a tier-heavy target is never budget-steered.
  const { server: upstream, port: upstreamPort } = await echoUpstream();
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);
  const requestBody = JSON.stringify({ model: "auto", metadata: { agentType: "reviewer" }, messages: [] });

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  });

  assert.equal(await receivedModel(res), "tier-heavy");

  await closeAll(gateway, upstream);
});

test("a body exactly at the cap succeeds (off-by-one boundary check)", async () => {
  const { server: upstream, port: upstreamPort } = await echoUpstream();
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);
  const exactCap = "x".repeat(10 * 1024 * 1024); // exactly MAX_BODY_BYTES — must NOT be rejected

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: exactCap,
  });

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).receivedBody.length, exactCap.length);

  await closeAll(gateway, upstream);
});

test("a body larger than the cap is rejected with 413 instead of hanging or crashing", async () => {
  const { server: upstream, port: upstreamPort } = await echoUpstream();
  const gateway = createGatewayServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);
  const oversized = "x".repeat(11 * 1024 * 1024); // over the 10MB cap

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversized,
  });

  assert.equal(res.status, 413);

  await closeAll(gateway, upstream);
});
