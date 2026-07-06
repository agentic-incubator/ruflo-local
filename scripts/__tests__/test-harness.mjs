// =============================================================================
// test-harness.mjs — shared helpers for scripts/__tests__/gateway-server*.test.mjs.
//
// Phase 8: listen()/closeAll()/request()/chatUpstream()/startReflexFakeUpstream()/gw()
// were each copy-pasted near-identically across all 4 gateway-server test files as
// phases 0-7 added their own — this is the one shared source. request() always
// includes `headers` in the resolved result (the superset of every prior variant) and
// startReflexFakeUpstream() always tracks every request it receives (also a superset —
// callers that don't need `requests` simply don't destructure it).
// =============================================================================
import http from "node:http";
import { createGatewayServer } from "../gateway-server.mjs";

/** createGatewayServer() with the real (unstubbed) recorder swapped for a no-op — phase 3
 *  wires a REAL recorder by default (writing to .ruvector/routing-corpus.rvf via a real
 *  embedder), which is irrelevant to most of these tests and, left unstubbed, would
 *  pollute the repo's real corpus file with test traffic on every run. Tests that DO
 *  care about recording (gateway-server-recorder.test.mjs) inject their own recordFn. */
const NOOP_RECORD = async () => {};
export function gw(opts) {
  return createGatewayServer({ recordFn: NOOP_RECORD, ...opts });
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

export function closeAll(...servers) {
  return Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
}

export function request(port, path, opts = {}) {
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

/** A plain (non-scorable) chat-completions echo — no judge/escalation role needed. */
export function chatUpstream(answer = "an answer") {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** A three-role fake upstream (serving / judge / escalation calls), tracking every
 *  request it receives — some tests assert on `requests`, most don't need it. */
export function startReflexFakeUpstream({ servedAnswer = "local answer", judgeScore = 1.0, escalatedAnswer = "frontier answer" } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // non-JSON body (shouldn't happen in these tests) — leave body as {}
      }
      requests.push({ path: req.url, body });

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
  return { server, requests };
}
