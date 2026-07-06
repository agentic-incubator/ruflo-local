// =============================================================================
// gateway-server.mjs — the always-on host-facing proxy seam (:4000).
//
// Phase 0 of the live-routing-cutover pipeline (docs/research/live-routing-gateway-
// rationale.md) stood this up as a pure, byte-for-byte passthrough reverse proxy in
// front of whichever :4000-serving gateway profile is active (litellm | bifrost |
// helicone). Phase 1 wires router.mjs's route() in: a request carrying
// metadata.agentType gets its `model` rewritten to the router-resolved tier; a request
// that already names an explicit tier alias (including tier-private — the privacy
// pin) bypasses route() entirely and is forwarded untouched. router.mjs's own logic
// is NOT modified, only called, for the first time, from live code. Later phases wire
// reflex.mjs/recorder.mjs in here too.
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

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPLICIT_TIERS = new Set([...TIER_LADDER, "tier-private"]);
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB — generous for a chat-completions JSON payload

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

/**
 * Rewrites `model` to the router-resolved tier when the body carries metadata.agentType
 * and no explicit tier alias. Fails OPEN (returns the buffer unchanged) on anything
 * else: non-JSON body, an already-explicit tier — checked FIRST, unconditionally,
 * before route() is ever called, so the privacy pin's fail-closed short-circuit is
 * never subject to routing overhead or a routing bug — no agentType at all, or
 * route() throwing.
 */
async function maybeRouteModel(bodyBuffer, { routeFn, policy, env, upstream }) {
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return bodyBuffer;
  }

  if (typeof parsed?.model === "string" && EXPLICIT_TIERS.has(parsed.model)) {
    return bodyBuffer;
  }

  const agentType = parsed?.metadata?.agentType;
  if (!agentType) {
    return bodyBuffer; // no routing signal in this phase's scope — forward unchanged
  }

  try {
    // GW points straight at the real upstream, never at this gateway's own :4000 —
    // otherwise the budget snapshot's /metrics scrape would loop back through this
    // same proxy instead of reaching the real gateway it needs to read.
    const decision = await routeFn({ agentType, policy, env: { ...env, GW: upstream } });
    parsed.model = decision.tier;
    return Buffer.from(JSON.stringify(parsed), "utf8");
  } catch {
    return bodyBuffer; // router.mjs threw — fail OPEN, forward the client's original model
  }
}

/**
 * Reverse proxy: forwards method/path/headers/body to the upstream and streams the
 * response back unchanged. Bodied requests (POST/PUT/PATCH/…) are buffered so `model`
 * can be inspected/rewritten via router.mjs's route(); bodyless requests (GET/HEAD)
 * stay pure streaming passthrough, unaffected.
 * @param {{upstream?:string, env?:object, policy?:object, routeFn?:Function}} [opts]
 */
export function createGatewayServer(opts = {}) {
  const cfg = gatewayServerConfig(opts.env);
  const upstream = new URL(opts.upstream ?? cfg.upstream);
  const client = upstream.protocol === "https:" ? https : http;
  const policy = opts.policy ?? loadPolicy(opts.env);
  const routeFn = opts.routeFn ?? routeRequest;

  return http.createServer(async (req, res) => {
    // Guards res's WHOLE lifecycle from the first line — a client can disconnect during
    // body buffering (before any proxyReq exists) just as easily as mid-response, and
    // either way an unhandled 'error' would crash the whole always-on process.
    res.on("error", () => {});

    let outBody = null;
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
      outBody = await maybeRouteModel(bodyBuffer, { routeFn, policy, env: opts.env, upstream: upstream.origin });
    }

    const headers = { ...req.headers, host: upstream.host };
    if (outBody !== null) {
      // Buffered in full, so a chunked request becomes a complete one — length is now
      // known and transfer-encoding no longer applies (both together would be invalid).
      delete headers["transfer-encoding"];
      headers["content-length"] = String(Buffer.byteLength(outBody));
    }

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
        res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers);
        proxyRes.pipe(res);
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
