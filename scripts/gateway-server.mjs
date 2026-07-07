// =============================================================================
// gateway-server.mjs — the always-on host-facing proxy seam (:4000).
//
// Phase 0 of the live-routing-cutover pipeline (docs/research/live-routing-gateway-
// rationale.md) stood this up as a pure, byte-for-byte passthrough reverse proxy in
// front of whichever internal gateway profile is active (litellm | bifrost | helicone —
// none of them bind a host port; GATEWAY_UPSTREAM_URL picks which one this forwards to).
// Phase 1 wired router.mjs's route() into the REQUEST side: a request
// carrying metadata.agentType gets its `model` rewritten to the router-resolved tier;
// an explicit tier alias (including tier-private — the privacy pin) bypasses route()
// entirely. Phase 2 wires reflex.mjs into the RESPONSE side: a scorable-tier
// (tier-fast/tier-heavy) answer gets judged and, on a low score, escalated to
// tier-frontier; every other tier (tier-private above all) never reaches the judge —
// checked BEFORE the response is even buffered, defense-in-depth alongside reflex.mjs's
// own fail-closed isScorable check. Phase 3 wires recorder.mjs into every served
// request: once the client-visible response is fully flushed, a real DRACO row (real
// embedding, tier, category, judge_score, cost, latency, escalated, REAL success/
// failure outcome) is recorded fire-and-forget — a recorder failure (missing real
// embedder, corrupt corpus, whatever) is swallowed exactly like a reflex/router
// failure, never affecting the response already sent. router.mjs, reflex.mjs, and
// recorder.mjs's own logic is never modified, only called, for the first time, from
// live code. Phase 5 emits one OTel span per served decision, carrying
// ruflo.route.{tier,floor,category,budget_rung,escalated,judge_score} attributes,
// exported to the SAME otel-collector :4318/v1/traces endpoint litellm's own gen_ai.*
// spans already flow through (otel-span.mjs) — best-effort, never affecting the
// response, exactly like the recorder.
//
// GATEWAY_UPSTREAM_URL follows the existing OLLAMA_API_BASE/VLLM_API_BASE env-override
// convention (config.mjs): default http://litellm:4000, override in .env when
// COMPOSE_PROFILES selects bifrost (http://bifrost:8080) or helicone (http://helicone:8080).
// =============================================================================

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayServerConfig, routerPolicyConfig, resolveGatewayEnv } from "./lib/config.mjs";
import { route as routeRequest, TIER_LADDER } from "./lib/router.mjs";
import { reflex as reflexAnswer, isScorable, canonicalTier, escalationTier } from "./lib/reflex.mjs";
import { RoutingRecorder, outcomeFromReflex } from "./lib/recorder.mjs";
import { DEFAULT_CANDIDATES } from "./lib/train-router.mjs";
import { GatewayClient } from "./lib/gateway-client.mjs";
import { otelSpanExporter } from "./lib/otel-span.mjs";
import { bufferStream } from "./lib/collect-body.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPLICIT_TIERS = new Set([...TIER_LADDER, "tier-private"]);
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB — generous for a chat-completions JSON payload
const ASCII_TIER_NAME = /^[a-z0-9-]+$/; // plain-ASCII shape a real tier name (or router-eligible alias) must have

// Helicone addresses tiers via URL path (/router/<name>/...), never the `model` field —
// it validates `model` against its own global catalog, so the body must carry the REAL
// resolved model id there instead of an alias (confirmed live against a real Helicone
// container). Without this, route-gateway would never recognize Helicone-routed local
// traffic as an explicit tier at all: bookkeeping (servedTier) would fall through to
// "unrouted", judging/escalation would never apply to it, and DRACO corpus rows would
// carry the wrong tier (or none). Router names drop the "tier-" prefix (12-char router
// ID cap on Helicone's side — see docs/guide/reference/gateway-variants.md), so this
// maps them back to the canonical tier-fast/tier-heavy/tier-frontier/tier-private form.
const HELICONE_ROUTER_PATH = /^\/router\/(fast|heavy|frontier|private)(?:\/|$)/;

/** The canonical tier for a Helicone /router/<name>/... path, or undefined if the
 *  path doesn't match that shape (e.g. every other gateway's addressing). */
function tierFromRouterPath(reqPath) {
  const match = HELICONE_ROUTER_PATH.exec(reqPath ?? "");
  return match ? `tier-${match[1]}` : undefined;
}

/** Reads + parses the shipped reference policy once; undefined (safe default) on any failure. */
function loadPolicy(env) {
  const { policyFile } = routerPolicyConfig(env);
  try {
    return JSON.parse(fs.readFileSync(path.join(MODULE_DIR, "..", policyFile), "utf8"));
  } catch {
    return undefined; // router.mjs defaults every agent-type floor to tier-fast without one
  }
}

function hasBody(method) {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

/** The category (ruflo agent type) recorded alongside a decision — "unrouted" when the
 *  request carries no metadata.agentType (an explicit-tier or signal-less request still
 *  gets a real DRACO row, just under a fallback category). */
function categoryOf(parsed) {
  const agentType = parsed?.metadata?.agentType;
  return typeof agentType === "string" && agentType ? agentType : "unrouted";
}

/**
 * Buckets a judge score into 5 fixed, low-cardinality ranges — unlike the raw continuous
 * score (never a valid Prometheus label, per phase 5's own cardinality reasoning), a
 * handful of discrete buckets is. "unscored" covers every request that never reached
 * reflex.mjs's judge at all (tier-private, non-scorable tiers, an unjudged tier-frontier
 * serve) — verify-escalate.mjs's own scorer guarantees a real score is always in [0,1],
 * so any in-range value always lands in exactly one bucket.
 */
function judgeScoreBucket(judgeScore) {
  if (typeof judgeScore !== "number" || Number.isNaN(judgeScore)) return "unscored";
  const clamped = Math.min(Math.max(judgeScore, 0), 1);
  const lo = Math.min(Math.floor(clamped * 5) / 5, 0.8);
  return `${lo.toFixed(1)}-${(lo + 0.2).toFixed(1)}`;
}

/** tier -> $/1M-tokens, reusing train-router.mjs's own cost table (never re-invented). */
const TIER_COST_PER_M_TOK = Object.fromEntries(DEFAULT_CANDIDATES.map((c) => [c.tier, c.costPerMTok]));

/** Real (not guessed) USD cost from the upstream's own `usage.total_tokens`, when present;
 *  0 for a free local tier or when no usage was reported (e.g. a streamed/piped response
 *  we never buffered — buffering it just to count tokens would defeat streaming). */
function estimateCost(tier, usage) {
  const perMillion = TIER_COST_PER_M_TOK[tier];
  const tokens = usage?.total_tokens;
  return typeof perMillion === "number" && perMillion > 0 && typeof tokens === "number" && Number.isFinite(tokens)
    ? (tokens / 1_000_000) * perMillion
    : 0;
}

/**
 * Default fire-and-forget recorder: lazily opens ONE real RoutingRecorder per server
 * (the real in-process ruvllm embedder, honoring RUFLO_REQUIRE_REAL_EMBEDDINGS) and
 * reuses it for every request, rather than reopening the corpus per call.
 */
function createDefaultRecordFn(env) {
  let recorderPromise;
  return async function record(decision) {
    recorderPromise ??= RoutingRecorder.open({ env });
    const recorder = await recorderPromise;
    return recorder.record(decision);
  };
}

/**
 * Records one served decision, fire-and-forget, once `res` finishes flushing to the
 * client — "after responding to the client" per the phase-3 deliverable, never before.
 * A missing `tier` (no chat request was actually served, e.g. a bodyless GET) records
 * nothing: there is no real decision to log. Any recorder failure (no real embedder
 * under RUFLO_REQUIRE_REAL_EMBEDDINGS, a corrupt corpus, whatever) is swallowed here —
 * exactly like a reflex/router failure, it must never surface to an already-sent response.
 * The phase-5 OTel span fires from the SAME choke point, for the SAME reason: any
 * response-termination path that skips this call would silently drop that decision from
 * telemetry too, the identical blind spot phase 3 found for the DRACO recorder.
 *
 * `cost`, when passed explicitly, overrides the usage-derived estimate — needed for an
 * escalated decision, whose real cost is the SUM of the local tier's own usage plus the
 * separately-billed escalation call's usage (estimateCost(tier, usage) alone can only
 * ever see one tier's usage at a time).
 *
 * `floor`/`budgetRung` are only known when router.mjs actually ran (an agentType-routed
 * request) — undefined for an explicit-tier/bypass request, in which case the span
 * simply omits those two attributes rather than emitting a bogus value.
 *
 * A response that never reaches 'finish' (the client vanished before headers, or `res`
 * was destroyed/ended by an error handler before this call) still represents a REAL
 * decision outcome worth recording — D11's whole point is that a failure must not be
 * silently dropped — so an already-settled `res` fires immediately instead of waiting
 * on an event that will never arrive.
 */
function recordServed(res, recordFn, spanFn, { category, tier, prompt, requestStart, requestStartWall, judgeScore = null, escalated = false, success, usage, cost, floor, budgetRung }) {
  if (tier === undefined) return;
  const latency = performance.now() - requestStart;
  const decision = {
    prompt,
    category,
    tier,
    judge_score: judgeScore,
    cost: cost ?? estimateCost(tier, usage),
    latency,
    escalated,
    success,
  };
  const fire = () => {
    void recordFn(decision).catch(() => {});
    void spanFn({
      name: "gateway.route",
      startTimeMs: requestStartWall,
      endTimeMs: requestStartWall + latency,
      attributes: {
        "ruflo.route.tier": tier,
        "ruflo.route.floor": floor,
        "ruflo.route.category": category,
        "ruflo.route.budget_rung": budgetRung,
        "ruflo.route.escalated": escalated,
        "ruflo.route.judge_score": judgeScore,
        "ruflo.route.judge_score_bucket": judgeScoreBucket(judgeScore),
      },
    }).catch(() => {});
  };
  if (res.writableFinished || res.destroyed) {
    fire();
  } else {
    res.once("finish", fire);
  }
}

/** Writes the response, then records the decision — the one pairing every buffered
 *  response-handling branch needs, so a future field addition touches recordFields
 *  in one place per branch instead of the write/record sequencing itself. */
function respondAndRecord(res, { statusCode, statusMessage, headers, body }, recordFn, spanFn, recordFields) {
  res.writeHead(statusCode, statusMessage, headers);
  res.end(body);
  recordServed(res, recordFn, spanFn, recordFields);
}

/**
 * Buffers a request body (bounded by MAX_BODY_BYTES) so it can be inspected/rewritten
 * before forwarding. Rejects with `.code` "BODY_TOO_LARGE" or "CLIENT_ABORTED" so the
 * caller can respond (or, for an aborted client, simply stop) instead of hanging.
 * NOTE: on BODY_TOO_LARGE, the caller must NOT req.destroy() — req and res share one
 * socket, and destroying it now would take res down with it before the 413 can ever be
 * written, leaving the client hanging on a response that will never arrive. A client
 * that hangs up mid-upload may surface only as 'close' (no 'error') — the same gap
 * phase 0 found on the response side; without handling it, an abandoned upload would
 * hang this promise forever instead of unwinding cleanly.
 */
function collectBody(req) {
  return bufferStream(req, {
    maxBytes: MAX_BODY_BYTES,
    tooLargeCode: "BODY_TOO_LARGE",
    tooLargeMsg: "request body too large",
    abortCode: "CLIENT_ABORTED",
    abortMsg: "client disconnected before body completed",
  });
}

/** The last message's `content`, or "" — the plain-text "task" reflex.mjs's judge scores against. */
function lastMessageContent(parsed) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const content = messages.at(-1)?.content;
  return typeof content === "string" ? content : "";
}

/**
 * Rewrites `model` to the router-resolved tier when the body carries metadata.agentType
 * and no explicit tier alias; fails OPEN (body unchanged) on a non-JSON body, an
 * already-explicit tier — checked FIRST, unconditionally, before route() is ever
 * called, so the privacy pin's fail-closed short-circuit is never subject to routing
 * overhead or a routing bug — no agentType at all, or route() throwing.
 *
 * The explicit-tier check is CANONICALIZED (reflex.mjs's own canonicalTier: trim +
 * lowercase) before comparison, matching reflex.mjs's own "unknown/mis-cased ⇒ never
 * scorable" fail-closed philosophy. Without this, `model: "Tier-Private"` (or with
 * stray whitespace) misses the exact-string bypass, falls through to agentType-based
 * routing, and comes back out as a real ladder tier (e.g. tier-heavy) — which phase 2's
 * isScorable() then correctly, but wrongly, treats as judgeable: a client's privacy
 * intent silently defeated by a routing bug, not a judging one. A canonical match
 * rewrites `model` to its canonical form too, so litellm gets an alias it definitely
 * recognizes and reflex.mjs's own downstream check sees the same canonical value.
 *
 * Always returns the SERVED tier (whatever ends up in `model`, routed or not), the
 * prompt text, and the recordable category, so the response side can decide
 * reflex-eligibility and record a DRACO row without re-parsing.
 * @returns {Promise<{body:Buffer, servedTier:string|undefined, prompt:string, streaming:boolean, category:string, floor?:string, budgetRung?:string}>}
 * floor/budgetRung are only set when router.mjs actually ran — undefined for an
 * explicit-tier/bypass request or an unrouted (no agentType) forward.
 */
async function prepareRequest(bodyBuffer, { routeFn, policy, env, upstream, reqPath }) {
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return { body: bodyBuffer, servedTier: undefined, prompt: "", streaming: false, category: "unrouted" };
  }

  // Boolean(), not `=== true`: err toward NOT buffering on an ambiguous value (e.g. a
  // malformed `stream: "true"` string) — treating a genuine stream as non-streaming
  // would break it by buffering SSE chunks whole; the reverse (skipping reflex for an
  // odd but truly non-streaming request) only costs a judge pass, never correctness.
  const streaming = Boolean(parsed?.stream);
  const prompt = lastMessageContent(parsed);
  const category = categoryOf(parsed);
  const originalModel = typeof parsed?.model === "string" ? parsed.model : undefined;

  // Checked FIRST, unconditionally, same priority as the body-based explicit-tier check
  // below — Helicone's addressing IS the tier signal; the body's `model` is a real
  // resolved id, never an alias, so it must never be rewritten for this gateway. This
  // still routes tier-private through the exact same downstream buffering/judging
  // logic as every other explicit tier (TIER_LADDER excludes it => never bufferable =>
  // never judged), so the privacy pin's fail-closed guarantee is unchanged.
  const pathTier = tierFromRouterPath(reqPath);
  if (pathTier !== undefined) {
    return { body: bodyBuffer, servedTier: pathTier, prompt, streaming, category };
  }

  const canonicalModel = originalModel !== undefined ? canonicalTier(originalModel) : undefined;

  if (canonicalModel !== undefined && EXPLICIT_TIERS.has(canonicalModel)) {
    if (canonicalModel === originalModel) {
      return { body: bodyBuffer, servedTier: originalModel, prompt, streaming, category };
    }
    parsed.model = canonicalModel;
    return { body: Buffer.from(JSON.stringify(parsed), "utf8"), servedTier: canonicalModel, prompt, streaming, category };
  }

  // A model string with anything outside plain ASCII letters/digits/hyphens is
  // suspicious: it could be a Unicode homoglyph/confusable spoofing an explicit tier
  // name (e.g. Cyrillic 'і' U+0456 in place of Latin 'i' in "tier-private") to slip
  // past the canonical match above while still LOOKING like it. NFKC normalization
  // does not fix this — a confusable is a distinct code point, not a compatibility
  // decomposition. Rather than chase an open-ended set of lookalikes, refuse to let
  // ANY non-ASCII-tier-shaped model be promoted to a real (possibly scorable) tier by
  // routing at all — forward it unchanged instead. litellm's own alias lookup will
  // then loudly fail to resolve it rather than us silently serving/judging it wrong.
  if (canonicalModel !== undefined && canonicalModel !== "" && !ASCII_TIER_NAME.test(canonicalModel)) {
    return { body: bodyBuffer, servedTier: originalModel, prompt, streaming, category };
  }

  const agentType = parsed?.metadata?.agentType;
  if (!agentType) {
    return { body: bodyBuffer, servedTier: originalModel, prompt, streaming, category }; // no routing signal — forward unchanged
  }

  try {
    // GW points straight at the real upstream, never at this gateway's own :4000 —
    // otherwise the budget snapshot's /metrics scrape would loop back through this
    // same proxy instead of reaching the real gateway it needs to read. See
    // resolveGatewayEnv's own doc comment (config.mjs) for why this isn't `{...env, GW}`.
    const decision = await routeFn({ agentType, policy, env: resolveGatewayEnv(env, upstream) });
    parsed.model = decision.tier;
    return {
      body: Buffer.from(JSON.stringify(parsed), "utf8"),
      servedTier: decision.tier,
      prompt, streaming, category,
      floor: decision.floor,
      budgetRung: decision.budget_rung,
    };
  } catch {
    return { body: bodyBuffer, servedTier: originalModel, prompt, streaming, category }; // router.mjs threw — fail OPEN
  }
}

/**
 * Buffers the upstream's response (bounded by MAX_BODY_BYTES) so `choices[0].message.
 * content` can be judged/escalated via reflex.mjs before forwarding. Shares
 * collectBody's bufferStream() helper (lib/collect-body.mjs) — same settle-once
 * guard, distinct error codes/messages for the response side.
 */
function collectResponseBody(proxyRes) {
  return bufferStream(proxyRes, {
    maxBytes: MAX_BODY_BYTES,
    tooLargeCode: "BODY_TOO_LARGE",
    tooLargeMsg: "response body too large",
    abortCode: "UPSTREAM_ABORTED",
    abortMsg: "upstream closed before response completed",
  });
}

/**
 * Reverse proxy: forwards method/path/headers/body to the upstream. Bodied requests
 * (POST/PUT/PATCH/…) are buffered so `model` can be inspected/rewritten via
 * router.mjs's route(); bodyless requests (GET/HEAD) stay pure streaming passthrough.
 * A scorable-tier (tier-fast/tier-heavy), non-streaming response is ALSO buffered so
 * its answer can be judged/escalated via reflex.mjs; every other response — above all
 * tier-private — stays pure streaming passthrough too, never read into memory.
 * @param {{upstream?:string, env?:object, policy?:object, routeFn?:Function, reflexFn?:Function, recordFn?:Function}} [opts]
 */
export function createGatewayServer(opts = {}) {
  const cfg = gatewayServerConfig(opts.env);
  const upstream = new URL(opts.upstream ?? cfg.upstream);
  const client = upstream.protocol === "https:" ? https : http;
  const policy = opts.policy ?? loadPolicy(opts.env);
  const routeFn = opts.routeFn ?? routeRequest;
  const reflexFn = opts.reflexFn ?? reflexAnswer;
  const recordFn = opts.recordFn ?? createDefaultRecordFn(opts.env);
  const spanFn = opts.spanFn ?? otelSpanExporter(opts.env);

  return http.createServer(async (req, res) => {
    // Guards res's WHOLE lifecycle from the first line — a client can disconnect during
    // body buffering (before any proxyReq exists) just as easily as mid-response, and
    // either way an unhandled 'error' would crash the whole always-on process.
    res.on("error", () => {});
    const requestStart = performance.now();
    const requestStartWall = Date.now(); // wall-clock anchor for the OTel span's timestamps; requestStart (above) is monotonic and only ever used for the latency delta

    let outBody = null;
    let servedTier;
    let prompt = "";
    let streaming = false;
    let category = "unrouted";
    let floor;
    let budgetRung;
    if (hasBody(req.method)) {
      let bodyBuffer;
      try {
        bodyBuffer = await collectBody(req);
      } catch (err) {
        if (err.code === "BODY_TOO_LARGE" && !res.writableEnded && !res.destroyed) {
          // `Connection: close` tells the client (and Node) to tear the socket down once
          // this response flushes, since the rest of the oversized body is still inbound
          // and unread — reusing the connection for another request on it isn't safe.
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
        }
        // CLIENT_ABORTED (or any other collection error): the client is already gone.
        return;
      }
      const prepared = await prepareRequest(bodyBuffer, { routeFn, policy, env: opts.env, upstream: upstream.origin, reqPath: req.url });
      outBody = prepared.body;
      servedTier = prepared.servedTier;
      prompt = prepared.prompt;
      streaming = prepared.streaming;
      category = prepared.category;
      floor = prepared.floor;
      budgetRung = prepared.budgetRung;
    }

    const headers = { ...req.headers, host: upstream.host };
    if (outBody !== null) {
      // Buffered in full, so a chunked request becomes a complete one — length is now
      // known and transfer-encoding no longer applies (both together would be invalid).
      delete headers["transfer-encoding"];
      headers["content-length"] = String(Buffer.byteLength(outBody));
    }

    // bufferable: safe to read the response into memory at all — TIER_LADDER excludes
    // tier-private and any unrecognized/unrouted string by construction (reflex.mjs's
    // own "unknown ⇒ private" fail-closed philosophy), so this never risks buffering a
    // private response; checked here, BEFORE the response is ever buffered, matching
    // phase 1's "privacy checked first, unconditionally" convention. judgeable narrows
    // that further to the scorable subset reflex.mjs actually judges (tier-fast/
    // tier-heavy by default) — tier-frontier is bufferable (so its real usage/cost can
    // be captured, the only tier that actually costs money) but not judgeable: it's
    // already the top of the ladder, there is nothing to escalate it TO.
    const bufferable = servedTier !== undefined && !streaming && TIER_LADDER.includes(servedTier);
    const judgeable = bufferable && isScorable(servedTier, opts.env);

    const proxyReq = client.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        if (!bufferable) {
          res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers);
          proxyRes.pipe(res);
          recordServed(res, recordFn, spanFn, {
            category, tier: servedTier, prompt, requestStart, requestStartWall, floor, budgetRung,
            success: proxyRes.statusCode < 400,
          });
          return;
        }

        collectResponseBody(proxyRes)
          .then(async (responseBuffer) => {
            // Forwards the response BYTES exactly as received (never re-serialized, so
            // headers/content-length always match the body on the wire) and records
            // whatever usage was actually parseable — 0 fields lost relative to before,
            // just one place instead of four separately hand-repeated write/end/record
            // sequences.
            const asIs = (usage) => respondAndRecord(
              res,
              { statusCode: proxyRes.statusCode, statusMessage: proxyRes.statusMessage, headers: proxyRes.headers, body: responseBuffer },
              recordFn,
              spanFn,
              { category, tier: servedTier, prompt, requestStart, requestStartWall, floor, budgetRung, success: proxyRes.statusCode < 400, usage },
            );

            let parsed;
            try {
              parsed = JSON.parse(responseBuffer.toString("utf8"));
            } catch {
              asIs(); // not JSON (error body, etc.) — forward unchanged, nothing to capture
              return;
            }

            const answer = parsed?.choices?.[0]?.message?.content;
            if (!judgeable || typeof answer !== "string") {
              // Either a bufferable-but-not-judged tier (tier-frontier: real usage/cost
              // captured now that we've parsed the body, but nothing to escalate it to)
              // or a judgeable tier whose response has no recognizable answer shape.
              asIs(parsed?.usage);
              return;
            }

            // GW points at the REAL upstream — the same self-loop fix as phase 1's
            // budget snapshot: the judge/escalation call must never loop back through
            // this same gateway's own :4000. Also backs our own escalate() below. See
            // resolveGatewayEnv's own doc comment (config.mjs) for why this isn't
            // `{...opts.env, GW}` — that shape silently broke every real judge/
            // escalation call from phase 2 until phase 7's live escalation drill caught it.
            const reflexEnv = resolveGatewayEnv(opts.env, upstream.origin);
            let escalationUsage;
            // A behavioral clone of reflex.mjs's OWN default escalate (same
            // GatewayClient, same model/messages shape, same degrade-to-"" on any
            // failure) — reflex.mjs's decision logic is completely unaffected. The only
            // difference: gw.chat() returns the full parsed body (so `usage` can be
            // captured as a side effect) instead of gw.chatContent(), which discards
            // everything but the answer string — the real cost of an escalation is
            // otherwise unobservable, since chatContent() never exposes it.
            const escalate = async (p) => {
              try {
                const data = await new GatewayClient({ env: reflexEnv }).chat({
                  model: escalationTier(reflexEnv),
                  messages: [{ role: "user", content: p }],
                });
                escalationUsage = data?.usage;
                return data?.choices?.[0]?.message?.content ?? "";
              } catch {
                return "";
              }
            };

            let verdictResult;
            try {
              verdictResult = await reflexFn({ tier: servedTier, prompt, answer, escalate, env: reflexEnv });
            } catch {
              asIs(parsed?.usage); // reflex.mjs is defensive and shouldn't throw, but fail open regardless
              return;
            }

            parsed.choices[0].message.content = verdictResult.answer; // == the original answer when not escalated
            const finalBody = Buffer.from(JSON.stringify(parsed), "utf8");
            const finalHeaders = { ...proxyRes.headers };
            delete finalHeaders["transfer-encoding"];
            delete finalHeaders["content-encoding"]; // finalBody is always freshly-serialized, uncompressed JSON
            finalHeaders["content-length"] = String(Buffer.byteLength(finalBody));
            // outcomeFromReflex (recorder.mjs, unchanged): an escalation means the LOCAL
            // tier's answer was judged inadequate — a NEGATIVE for that decision, D11.
            // The recorded `tier`/`success` stay about THAT local decision either way;
            // `cost` is the REAL total spend for this prompt — the local tier's own
            // usage plus, when escalated, the separately-billed escalation call's usage
            // (estimateCost(tier, usage) alone can only ever see one tier at a time).
            const { escalated, success } = outcomeFromReflex(verdictResult);
            const cost = estimateCost(servedTier, parsed?.usage) + (escalated ? estimateCost(escalationTier(reflexEnv), escalationUsage) : 0);
            respondAndRecord(
              res,
              { statusCode: proxyRes.statusCode, statusMessage: proxyRes.statusMessage, headers: finalHeaders, body: finalBody },
              recordFn,
              spanFn,
              { category, tier: servedTier, prompt, requestStart, requestStartWall, floor, budgetRung, judgeScore: verdictResult.verdict?.score ?? null, escalated, success, cost },
            );
          })
          .catch(() => {
            // Buffering the response itself failed (too large / upstream aborted) — bytes
            // already consumed can't be replayed as a faithful passthrough, so a clean 502
            // is the honest answer rather than a corrupted partial response. Still a REAL
            // decision outcome (D11: the tier was resolved and the request failed) — must
            // not be silently absent from the corpus.
            if (!res.writableEnded && !res.destroyed) {
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "bad_gateway", message: "response buffering failed" }));
            }
            recordServed(res, recordFn, spanFn, { category, tier: servedTier, prompt, requestStart, requestStartWall, floor, budgetRung, success: false });
          });
      },
    );

    // A client that disconnects — closed tab, killed curl, network blip; routine, not
    // exceptional, for an always-on gateway — must tear down the upstream call and must
    // never crash the process. Registered for `res`'s WHOLE lifecycle (not only once
    // proxyRes arrives), because the disconnect can happen either before or after
    // headers come back from upstream, and either way it may surface as 'error' (a
    // write mid-stream hits the closed socket) or only as 'close' (no write was in
    // flight when it happened) — destroying proxyReq covers both the pre- and
    // post-headers cases, since it owns the one socket shared with proxyRes.
    res.on("error", () => proxyReq.destroy());
    res.on("close", () => proxyReq.destroy());

    // Upstream unreachable (not yet up, wrong profile, etc.) — fail as a clean 502
    // rather than letting the client hang. Guard against the client having already
    // disconnected (res destroyed above) before the upstream error arrives. Still
    // records the decision (D11: a resolved tier that then failed is a REAL negative
    // outcome) even when the client already vanished — recordServed fires immediately
    // when `res` is already destroyed/ended instead of waiting on a 'finish' that will
    // never come.
    proxyReq.on("error", (err) => {
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "bad_gateway", message: err.message }));
      }
      recordServed(res, recordFn, spanFn, { category, tier: servedTier, prompt, requestStart, requestStartWall, floor, budgetRung, success: false });
    });

    if (outBody !== null) {
      proxyReq.end(outBody);
    } else {
      // A client that aborts before finishing its request body must not crash the
      // process either — abandon the upstream call cleanly.
      req.on("error", () => proxyReq.destroy());
      req.pipe(proxyReq);
    }
  });
}

/** True when this module is executed directly (`node gateway-server.mjs`), not imported. */
function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const cfg = gatewayServerConfig();
  const server = createGatewayServer();
  server.listen(cfg.port, () => {
    console.log(`route-gateway listening on :${cfg.port} -> ${cfg.upstream}`);
  });
}
