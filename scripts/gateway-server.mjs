// =============================================================================
// gateway-server.mjs — the always-on host-facing proxy seam (:4000).
//
// Phase 0 of the live-routing-cutover pipeline (docs/research/live-routing-gateway-
// rationale.md) stood this up as a pure, byte-for-byte passthrough reverse proxy in
// front of whichever :4000-serving gateway profile is active (litellm | bifrost |
// helicone). Phase 1 wired router.mjs's route() into the REQUEST side: a request
// carrying metadata.agentType gets its `model` rewritten to the router-resolved tier;
// an explicit tier alias (including tier-private — the privacy pin) bypasses route()
// entirely. Phase 2 wires reflex.mjs into the RESPONSE side: a scorable-tier
// (tier-fast/tier-heavy) answer gets judged and, on a low score, escalated to
// tier-frontier; every other tier (tier-private above all) never reaches the judge —
// checked BEFORE the response is even buffered, defense-in-depth alongside reflex.mjs's
// own fail-closed isScorable check. Neither router.mjs nor reflex.mjs's own logic is
// modified, only called, for the first time, from live code. Later phases wire
// recorder.mjs in here too.
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
import { gatewayServerConfig, routerPolicyConfig } from "./lib/config.mjs";
import { route as routeRequest, TIER_LADDER } from "./lib/router.mjs";
import { reflex as reflexAnswer, isScorable, canonicalTier } from "./lib/reflex.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPLICIT_TIERS = new Set([...TIER_LADDER, "tier-private"]);
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB — generous for a chat-completions JSON payload
const ASCII_TIER_NAME = /^[a-z0-9-]+$/; // plain-ASCII shape a real tier name (or router-eligible alias) must have

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

/**
 * Buffers a request body (bounded by MAX_BODY_BYTES) so it can be inspected/rewritten
 * before forwarding. Rejects with `.code` "BODY_TOO_LARGE" or "CLIENT_ABORTED" so the
 * caller can respond (or, for an aborted client, simply stop) instead of hanging.
 */
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Stop accumulating, but do NOT req.destroy() here — req and res share one
        // socket, and destroying it now would take res down with it before the 413
        // below can ever be written, leaving the client hanging on a response that
        // will never arrive instead of getting a clean rejection.
        settle(reject, Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(resolve, Buffer.concat(chunks)));
    req.on("error", (err) => settle(reject, err));
    // A client that hangs up mid-upload may surface only as 'close' (no 'error') —
    // the same gap phase 0 found on the response side. Without this, an abandoned
    // upload would hang collectBody's promise forever instead of unwinding cleanly.
    req.on("close", () => settle(reject, Object.assign(new Error("client disconnected before body completed"), { code: "CLIENT_ABORTED" })));
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
 * Always returns the SERVED tier (whatever ends up in `model`, routed or not) and the
 * prompt text, so the response side can decide reflex-eligibility without re-parsing.
 * @returns {Promise<{body:Buffer, servedTier:string|undefined, prompt:string, streaming:boolean}>}
 */
async function prepareRequest(bodyBuffer, { routeFn, policy, env, upstream }) {
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return { body: bodyBuffer, servedTier: undefined, prompt: "", streaming: false };
  }

  // Boolean(), not `=== true`: err toward NOT buffering on an ambiguous value (e.g. a
  // malformed `stream: "true"` string) — treating a genuine stream as non-streaming
  // would break it by buffering SSE chunks whole; the reverse (skipping reflex for an
  // odd but truly non-streaming request) only costs a judge pass, never correctness.
  const streaming = Boolean(parsed?.stream);
  const prompt = lastMessageContent(parsed);
  const originalModel = typeof parsed?.model === "string" ? parsed.model : undefined;
  const canonicalModel = originalModel !== undefined ? canonicalTier(originalModel) : undefined;

  if (canonicalModel !== undefined && EXPLICIT_TIERS.has(canonicalModel)) {
    if (canonicalModel === originalModel) {
      return { body: bodyBuffer, servedTier: originalModel, prompt, streaming };
    }
    parsed.model = canonicalModel;
    return { body: Buffer.from(JSON.stringify(parsed), "utf8"), servedTier: canonicalModel, prompt, streaming };
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
    return { body: bodyBuffer, servedTier: originalModel, prompt, streaming };
  }

  const agentType = parsed?.metadata?.agentType;
  if (!agentType) {
    return { body: bodyBuffer, servedTier: originalModel, prompt, streaming }; // no routing signal — forward unchanged
  }

  try {
    // GW points straight at the real upstream, never at this gateway's own :4000 —
    // otherwise the budget snapshot's /metrics scrape would loop back through this
    // same proxy instead of reaching the real gateway it needs to read.
    const decision = await routeFn({ agentType, policy, env: { ...env, GW: upstream } });
    parsed.model = decision.tier;
    return { body: Buffer.from(JSON.stringify(parsed), "utf8"), servedTier: decision.tier, prompt, streaming };
  } catch {
    return { body: bodyBuffer, servedTier: originalModel, prompt, streaming }; // router.mjs threw — fail OPEN
  }
}

/**
 * Buffers the upstream's response (bounded by MAX_BODY_BYTES) so `choices[0].message.
 * content` can be judged/escalated via reflex.mjs before forwarding. Mirrors
 * collectBody's shape for the response side; kept separate (not shared) so a change to
 * request-body handling can never accidentally alter response handling or vice versa.
 */
function collectResponseBody(proxyRes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    proxyRes.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settle(reject, Object.assign(new Error("response body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    proxyRes.on("end", () => settle(resolve, Buffer.concat(chunks)));
    proxyRes.on("error", (err) => settle(reject, err));
    proxyRes.on("close", () => settle(reject, Object.assign(new Error("upstream closed before response completed"), { code: "UPSTREAM_ABORTED" })));
  });
}

/**
 * Reverse proxy: forwards method/path/headers/body to the upstream. Bodied requests
 * (POST/PUT/PATCH/…) are buffered so `model` can be inspected/rewritten via
 * router.mjs's route(); bodyless requests (GET/HEAD) stay pure streaming passthrough.
 * A scorable-tier (tier-fast/tier-heavy), non-streaming response is ALSO buffered so
 * its answer can be judged/escalated via reflex.mjs; every other response — above all
 * tier-private — stays pure streaming passthrough too, never read into memory.
 * @param {{upstream?:string, env?:object, policy?:object, routeFn?:Function, reflexFn?:Function}} [opts]
 */
export function createGatewayServer(opts = {}) {
  const cfg = gatewayServerConfig(opts.env);
  const upstream = new URL(opts.upstream ?? cfg.upstream);
  const client = upstream.protocol === "https:" ? https : http;
  const policy = opts.policy ?? loadPolicy(opts.env);
  const routeFn = opts.routeFn ?? routeRequest;
  const reflexFn = opts.reflexFn ?? reflexAnswer;

  return http.createServer(async (req, res) => {
    // Guards res's WHOLE lifecycle from the first line — a client can disconnect during
    // body buffering (before any proxyReq exists) just as easily as mid-response, and
    // either way an unhandled 'error' would crash the whole always-on process.
    res.on("error", () => {});

    let outBody = null;
    let servedTier;
    let prompt = "";
    let streaming = false;
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
      const prepared = await prepareRequest(bodyBuffer, { routeFn, policy, env: opts.env, upstream: upstream.origin });
      outBody = prepared.body;
      servedTier = prepared.servedTier;
      prompt = prepared.prompt;
      streaming = prepared.streaming;
    }

    const headers = { ...req.headers, host: upstream.host };
    if (outBody !== null) {
      // Buffered in full, so a chunked request becomes a complete one — length is now
      // known and transfer-encoding no longer applies (both together would be invalid).
      delete headers["transfer-encoding"];
      headers["content-length"] = String(Buffer.byteLength(outBody));
    }

    // reflex() only applies to a scorable, NON-STREAMING response: an SSE-streamed chat
    // completion isn't a single JSON blob at all, so buffering one whole would both
    // defeat the point of streaming and is out of this phase's scope. Checked here,
    // BEFORE the response is ever buffered — defense-in-depth alongside reflex.mjs's own
    // fail-closed isScorable check, so a non-scorable tier (tier-private above all) is
    // never even read into memory, matching phase 1's "privacy checked first,
    // unconditionally, before any potentially wasteful work" convention.
    const eligibleForReflex = servedTier !== undefined && !streaming && isScorable(servedTier, opts.env);

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
        if (!eligibleForReflex) {
          res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers);
          proxyRes.pipe(res);
          return;
        }

        collectResponseBody(proxyRes)
          .then(async (responseBuffer) => {
            let parsed;
            try {
              parsed = JSON.parse(responseBuffer.toString("utf8"));
            } catch {
              res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers);
              res.end(responseBuffer); // not JSON (error body, etc.) — forward unchanged
              return;
            }

            const answer = parsed?.choices?.[0]?.message?.content;
            if (typeof answer !== "string") {
              res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers);
              res.end(responseBuffer); // no recognizable answer to judge — forward unchanged
              return;
            }

            let verdictResult;
            try {
              // GW points at the REAL upstream — the same self-loop fix as phase 1's
              // budget snapshot: the judge/escalation call must never loop back through
              // this same gateway's own :4000.
              verdictResult = await reflexFn({ tier: servedTier, prompt, answer, env: { ...opts.env, GW: upstream.origin } });
            } catch {
              res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers);
              res.end(responseBuffer); // reflex.mjs is defensive and shouldn't throw, but fail open regardless
              return;
            }

            parsed.choices[0].message.content = verdictResult.answer; // == the original answer when not escalated
            const finalBody = Buffer.from(JSON.stringify(parsed), "utf8");
            const finalHeaders = { ...proxyRes.headers };
            delete finalHeaders["transfer-encoding"];
            finalHeaders["content-length"] = String(Buffer.byteLength(finalBody));
            res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, finalHeaders);
            res.end(finalBody);
          })
          .catch(() => {
            // Buffering the response itself failed (too large / upstream aborted) — bytes
            // already consumed can't be replayed as a faithful passthrough, so a clean 502
            // is the honest answer rather than a corrupted partial response.
            if (!res.writableEnded && !res.destroyed) {
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "bad_gateway", message: "response buffering failed" }));
            }
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
    // disconnected (res destroyed above) before the upstream error arrives.
    proxyReq.on("error", (err) => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "bad_gateway", message: err.message }));
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
