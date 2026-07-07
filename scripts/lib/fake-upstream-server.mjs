// =============================================================================
// fake-upstream-server.mjs — a controllable transparent proxy in front of a real
// OpenAI-compatible upstream (Ollama by default).
//
// WHY: smoke-test.sh's escalation and fall-through drills need a DETERMINISTIC bad
// answer / failure to prove reflex.mjs's judge-and-escalate and the active gateway's
// fallback chain fire for real. LiteLLM has native per-call test hooks (mock_response,
// mock_testing_fallbacks) for this; Bifrost and Helicone do not (confirmed against
// their real repos — Helicone's own crates/mock-server is a [dev-dependencies]-only
// crate, never shipped in helicone/ai-gateway's release image).
//
// DESIGN: rather than a from-scratch fake responder, this is a passthrough proxy that
// forwards every request byte-for-byte to the real upstream by default — so every
// OTHER smoke check (tier answers, privacy pin, metrics, DRACO corpus growth) sees
// fully real, unmodified behavior, zero signal loss. Only POST /control arms a
// deterministic intercept for the next N POST requests (bad-answer or fail), which
// then auto-reverts to passthrough. Used ONLY by the CI "ci" model variant
// (render-configs.mjs) — mlx/gguf (real hardware) never point at this.
//
// GET requests (health checks, /v1/models, etc.) are NEVER intercepted, only POST —
// so an incidental startup probe from the active gateway can't consume the armed
// counter before smoke-test.sh's own deliberate call does.
// =============================================================================

import http from "node:http";
import https from "node:https";
import { bufferStream } from "./collect-body.mjs";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const FORCED_BAD_ANSWER = "I cannot help with that request. Please try again later.";

function drainBody(req) {
  return bufferStream(req, {
    maxBytes: MAX_BODY_BYTES,
    tooLargeCode: "BODY_TOO_LARGE",
    tooLargeMsg: "request body too large",
    abortCode: "CLIENT_ABORTED",
    abortMsg: "client disconnected before body completed",
  });
}

function sendJson(res, statusCode, obj) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

/**
 * @param {{upstreamUrl?:string}} [opts] upstreamUrl defaults to env UPSTREAM_URL, then
 *   http://ollama:11434 — the real backend this proxies to in "normal" mode.
 * @returns {import("node:http").Server}
 */
export function createFakeUpstreamServer(opts = {}) {
  const upstream = new URL(opts.upstreamUrl ?? process.env.UPSTREAM_URL ?? "http://ollama:11434");
  const client = upstream.protocol === "https:" ? https : http;
  // mode "normal" ⇒ pure passthrough; "bad-answer"/"fail" ⇒ intercept the next
  // `remaining` POSTs, decrementing each time, auto-reverting to "normal" at 0.
  let state = { mode: "normal", remaining: 0 };

  return http.createServer((req, res) => {
    res.on("error", () => {});

    if (req.method === "POST" && req.url === "/control") {
      drainBody(req)
        .then((buf) => JSON.parse(buf.toString("utf8")))
        .then((body) => {
          if (body.mode !== "bad-answer" && body.mode !== "fail" && body.mode !== "normal") {
            throw new Error("bad_control_body: mode must be bad-answer, fail, or normal");
          }
          const times = Math.max(0, Math.trunc(Number(body.times)) || 0);
          state = body.mode === "normal" || times === 0 ? { mode: "normal", remaining: 0 } : { mode: body.mode, remaining: times };
          sendJson(res, 200, { ok: true, ...state });
        })
        .catch(() => sendJson(res, 400, { error: "bad_control_body" }));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok", ...state });
      return;
    }

    if (req.method === "POST" && state.mode !== "normal" && state.remaining > 0) {
      const { mode } = state;
      const remaining = state.remaining - 1;
      state = remaining > 0 ? { mode, remaining } : { mode: "normal", remaining: 0 };
      drainBody(req)
        .catch(() => {}) // body content is irrelevant to the forced response; just drain the socket cleanly
        .then(() => {
          if (mode === "fail") {
            sendJson(res, 500, { error: { message: "fake-upstream: forced failure (armed drill)", type: "forced_failure" } });
            return;
          }
          sendJson(res, 200, {
            model: "fake-upstream",
            choices: [{ index: 0, message: { role: "assistant", content: FORCED_BAD_ANSWER }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        });
      return;
    }

    // Normal mode: pure streaming passthrough, no buffering — this proxy never needs
    // to inspect content, unlike gateway-server.mjs's own reverse proxy.
    const headers = { ...req.headers, host: upstream.host };
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
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    res.on("error", () => proxyReq.destroy());
    res.on("close", () => proxyReq.destroy());
    proxyReq.on("error", () => sendJson(res, 502, { error: { message: "fake-upstream: real upstream unreachable", type: "bad_gateway" } }));
    req.pipe(proxyReq);
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT) || 9100;
  const upstreamUrl = process.env.UPSTREAM_URL ?? "http://ollama:11434";
  const server = createFakeUpstreamServer({ upstreamUrl });
  server.listen(port, () => {
    console.log(`fake-upstream-server listening on :${port} -> ${upstreamUrl}`);
  });
}
