// =============================================================================
// gateway-server.mjs — the always-on host-facing proxy seam (:4000).
//
// Phase 0 of the live-routing-cutover pipeline (docs/research/live-routing-gateway-
// rationale.md): a pure, byte-for-byte passthrough reverse proxy in front of whichever
// :4000-serving gateway profile is active (litellm | bifrost | helicone). ZERO
// routing/judge/recording logic yet — isolates "does the new seam work" from "does the
// new logic work." Later phases in this pipeline wire router.mjs/reflex.mjs/recorder.mjs
// in here; this file is the seam they'll be called from.
//
// GATEWAY_UPSTREAM_URL follows the existing OLLAMA_API_BASE/VLLM_API_BASE env-override
// convention (config.mjs): default http://litellm:4000, override in .env when
// COMPOSE_PROFILES selects bifrost (http://bifrost:8080) or helicone (http://helicone:8080).
// =============================================================================

import http from "node:http";
import https from "node:https";
import { gatewayServerConfig } from "./lib/config.mjs";

/**
 * Byte-for-byte reverse proxy: forwards method/path/headers/body verbatim to the
 * upstream and streams the response back unchanged (no buffering either direction).
 * @param {{upstream?:string, env?:object}} [opts]
 */
export function createGatewayServer(opts = {}) {
  const cfg = gatewayServerConfig(opts.env);
  const upstream = new URL(opts.upstream ?? cfg.upstream);
  const client = upstream.protocol === "https:" ? https : http;

  return http.createServer((req, res) => {
    const proxyReq = client.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
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

    // A client that aborts before finishing its request body must not crash the
    // process either — abandon the upstream call cleanly.
    req.on("error", () => proxyReq.destroy());

    req.pipe(proxyReq);
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
