// =============================================================================
// gateway-server-reflex.test.mjs — phase 2: reflex.mjs wired live, supertest-style
// against the REAL createGatewayServer() (not reflex.mjs in isolation — that's already
// covered by scripts/lib/__tests__/reflex.test.mjs). The centerpiece: proving a
// tier-private request produces ZERO judge/escalation egress calls through the actual
// live server, by counting every request a fake upstream actually received.
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gw, listen, closeAll, request, startReflexFakeUpstream } from "./test-harness.mjs";

test("escalates to the frontier answer when the judge scores the local answer low", async () => {
  const { server: upstream, requests } = startReflexFakeUpstream({ judgeScore: 0.0 }); // well below default threshold 0.6
  const upstreamPort = await listen(upstream);
  const gateway = gw({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", messages: [{ role: "user", content: "what is 2+2?" }] }),
  });

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, "frontier answer");
  // 1 serving call + 2 judge passes (position-swap) + 1 escalation call = 4 total.
  assert.equal(requests.length, 4);
  assert.ok(requests.some((r) => r.body.model === "tier-frontier" && !r.body.messages.some((m) => m.role === "system")), "an escalation call reached the fake upstream");

  await closeAll(gateway, upstream);
});

// Regression (phase 7): `const reflexEnv = { ...opts.env, GW: upstream.origin };` — when
// no `env` option is passed to createGatewayServer at all (the real production shape,
// isMain()'s bare createGatewayServer()), `opts.env` is undefined, and `{...undefined}`
// evaluates to `{}` — a DEFINED (if empty) object, which defeats every downstream
// `= process.env` default parameter (gatewayConfig's LITELLM_MASTER_KEY among them),
// since default params only trigger on an undefined argument, never a merely-empty one.
// This silently sent every real judge/escalation call out with config.mjs's hardcoded
// "sk-local-master" fallback instead of the real key since phase 2 shipped — invisible
// until a live escalation drill against real litellm actually needed the real key.
test("propagates real process.env vars into reflex.mjs's env when no `env` option is passed at all", async () => {
  process.env.RUFLO_TEST_ENV_PROPAGATION_MARKER = "present";
  try {
    const { server: upstream, port: upstreamPort } = await (async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "an answer" } }] }));
      });
      return { server, port: await listen(server) };
    })();
    let capturedEnv = null;
    const reflexFn = async ({ answer, env }) => {
      capturedEnv = env;
      return { answer, escalated: false, verdict: null };
    };
    // No `env` option passed — createGatewayServer's opts.env is genuinely undefined,
    // exactly the real production shape.
    const gateway = gw({ reflexFn, upstream: `http://127.0.0.1:${upstreamPort}` });
    const gatewayPort = await listen(gateway);

    await request(gatewayPort, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tier-fast", messages: [{ role: "user", content: "hello" }] }),
    });

    assert.ok(capturedEnv, "reflexFn should have been called");
    assert.equal(capturedEnv.RUFLO_TEST_ENV_PROPAGATION_MARKER, "present");

    await closeAll(gateway, upstream);
  } finally {
    delete process.env.RUFLO_TEST_ENV_PROPAGATION_MARKER;
  }
});

test("keeps the local answer when the judge scores it high", async () => {
  const { server: upstream, requests } = startReflexFakeUpstream({ judgeScore: 1.0 }); // well above default threshold 0.6
  const upstreamPort = await listen(upstream);
  const gateway = gw({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-heavy", messages: [{ role: "user", content: "what is 2+2?" }] }),
  });

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, "local answer");
  // 1 serving call + 2 judge passes — NO escalation call.
  assert.equal(requests.length, 3);
  assert.ok(!requests.some((r) => r.body.model === "tier-frontier" && !r.body.messages.some((m) => m.role === "system")), "no escalation call ever reached the fake upstream");

  await closeAll(gateway, upstream);
});

test("tier-private produces ZERO judge/escalation egress calls — the privacy pin, proven live", async () => {
  // judgeScore is deliberately 0.0 (would escalate a scorable tier) to prove tier-private's
  // fail-closed short-circuit holds even when everything ELSE about the setup would escalate.
  const { server: upstream, requests } = startReflexFakeUpstream({ judgeScore: 0.0, servedAnswer: "private answer" });
  const upstreamPort = await listen(upstream);
  const gateway = gw({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-private", messages: [{ role: "user", content: "my secret" }] }),
  });

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, "private answer"); // unchanged — never judged, never escalated
  // THE CENTERPIECE ASSERTION: exactly ONE call ever reached the fake upstream — the
  // original serving call. Zero judge calls, zero escalation calls, end to end through
  // the real live gateway process — not asserted on reflex.mjs in isolation.
  assert.equal(requests.length, 1, `expected exactly 1 egress call (the serving call), got ${requests.length}: ${JSON.stringify(requests.map((r) => r.body.model))}`);

  await closeAll(gateway, upstream);
});

test("escalates via Helicone's /router/fast/ path addressing, same as the model=tier-fast bypass", async () => {
  // Real parity fix: Helicone requires the REAL resolved model id in the body (never
  // an alias), so route-gateway must recognize the tier from the URL path instead —
  // without that, this request would never be judged/escalated at all.
  const { server: upstream, requests } = startReflexFakeUpstream({ judgeScore: 0.0 });
  const upstreamPort = await listen(upstream);
  const gateway = gw({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/router/fast/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "ollama/qwen2.5:0.5b", messages: [{ role: "user", content: "what is 2+2?" }] }),
  });

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, "frontier answer");
  assert.equal(requests.length, 4); // 1 serving + 2 judge passes + 1 escalation call

  await closeAll(gateway, upstream);
});

test("/router/private/ path addressing produces ZERO judge/escalation egress calls — the privacy pin holds under Helicone too", async () => {
  const { server: upstream, requests } = startReflexFakeUpstream({ judgeScore: 0.0, servedAnswer: "private answer" });
  const upstreamPort = await listen(upstream);
  const gateway = gw({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/router/private/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "ollama/qwen2.5:0.5b", messages: [{ role: "user", content: "my secret" }] }),
  });

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, "private answer");
  assert.equal(requests.length, 1, `expected exactly 1 egress call (the serving call), got ${requests.length}`);

  await closeAll(gateway, upstream);
});

test("a mis-cased tier-private + agentType still produces ZERO egress calls (confirmed exploit, now fixed)", async () => {
  // Tier-3 pentest reproduction: {model:"Tier-Private", metadata:{agentType:"researcher"}}
  // used to fall through the exact-string bypass check, get routed to a real serving
  // tier by router.mjs, and leak the prompt to 2 judge calls + an escalation call —
  // 4 total egress calls carrying private content off-box. Canonicalizing the bypass
  // check (gateway-server.mjs's prepareRequest) closes this; pin it here so it can
  // never silently reopen.
  const { server: upstream, requests } = startReflexFakeUpstream({ judgeScore: 0.0, servedAnswer: "private answer" });
  const upstreamPort = await listen(upstream);
  const gateway = gw({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "Tier-Private",
      metadata: { agentType: "researcher" },
      messages: [{ role: "user", content: "my SECRET_TOKEN_XYZ prompt" }],
    }),
  });

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, "private answer");
  assert.equal(
    requests.length,
    1,
    `expected exactly 1 egress call, got ${requests.length}: ${JSON.stringify(requests.map((r) => r.body.model))} — the mis-cased tier-private exploit is back`,
  );

  await closeAll(gateway, upstream);
});

test("a Unicode homoglyph in tier-private + agentType still produces ZERO egress calls (confirmed exploit, now fixed)", async () => {
  // Second-round pentest finding: "tiеr-private" with U+0456 CYRILLIC SMALL LETTER
  // BYELORUSSIAN-UKRAINIAN I in place of Latin 'i' is trim+lowercase-invariant (it's
  // already lowercase, and canonicalTier only trims/lowercases — no Unicode
  // normalization). It slipped past the canonical-match fix, got routed to a real
  // serving tier by router.mjs, and leaked the prompt to judge + escalation calls.
  // NFKC normalization would NOT have caught this (the Cyrillic letter has no
  // compatibility decomposition to Latin 'i' — it's a genuinely distinct code point,
  // not a formatting variant). Fixed by refusing to let ANY non-ASCII-tier-shaped
  // model string be promoted to a real tier via routing at all.
  // Built entirely from codepoints via String.fromCodePoint — never a typed/pasted
  // character — because a raw confusable in source is exactly the kind of thing
  // that's unreviewable by eye, the whole point of this exploit. Replaces index 1
  // ('i', U+0069) of "tier-private" with U+0456 (Cyrillic small letter і).
  const homoglyphModel = "tier-private".slice(0, 1) + String.fromCodePoint(0x0456) + "tier-private".slice(2);
  assert.equal(homoglyphModel.length, "tier-private".length, "sanity: substitution, not insertion");
  assert.equal(homoglyphModel.codePointAt(1), 0x0456, "sanity: the substituted char really is U+0456");
  const { server: upstream, requests } = startReflexFakeUpstream({ judgeScore: 0.0, servedAnswer: "private answer" });
  const upstreamPort = await listen(upstream);
  const gateway = gw({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: homoglyphModel,
      metadata: { agentType: "researcher" },
      messages: [{ role: "user", content: "my SECRET_MARKER_V1C prompt" }],
    }),
  });

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, "private answer");
  assert.equal(
    requests.length,
    1,
    `expected exactly 1 egress call, got ${requests.length}: ${JSON.stringify(requests.map((r) => r.body.model))} — the homoglyph tier-private exploit is back`,
  );

  await closeAll(gateway, upstream);
});

test("a streaming request bypasses reflex entirely (SSE isn't a single JSON blob to buffer)", async () => {
  const { server: upstream, requests } = startReflexFakeUpstream({ judgeScore: 0.0 });
  const upstreamPort = await listen(upstream);
  const gateway = gw({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  const res = await request(gatewayPort, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-fast", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, "local answer"); // the fake upstream's raw (unjudged) reply, forwarded as-is
  assert.equal(requests.length, 1); // no judge/escalation calls — reflex never engaged

  await closeAll(gateway, upstream);
});
