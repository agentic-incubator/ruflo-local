// =============================================================================
// gateway-client.mjs — OpenAI-compatible gateway client (replaces curl).
//
// The bash scripts shelled out to `curl -fsS ... || true`, so a failed request
// became an empty string and the caller degraded gracefully. This client preserves
// those exact semantics as two layers:
//
//   • chat()        — raw POST; THROWS on network error or non-2xx (so budget-snapshot
//                     can tell "reachable" from "erroring", like curl -f's non-zero exit).
//   • chatContent() — returns choices[0].message.content, or "" on ANY failure
//                     (mirrors `curl ... | jq -r '... // empty' || true`).
//   • chatTimed()   — chatContent plus wall-clock seconds (bench's %{time_total}).
//   • metrics()     — GET /metrics with auth; THROWS on failure (budget fail-closed).
//   • health()      — boolean reachability, never throws.
//
// `fetchImpl` is injectable so unit tests mock the gateway with a plain function —
// no network, no process.env mutation. Nothing here is model- or provider-specific.
// =============================================================================

import { gatewayConfig } from "./config.mjs";

export class GatewayClient {
  /** @param {{gateway?:string, apiKey?:string, fetchImpl?:Function, env?:object}} [opts] */
  constructor(opts = {}) {
    const cfg = gatewayConfig(opts.env);
    this.gateway = opts.gateway ?? cfg.gateway;
    this.apiKey = opts.apiKey ?? cfg.apiKey;
    // Default to global fetch (Node >=18); injectable for tests.
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  get #authHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Raw chat completion. Resolves to the parsed JSON body; THROWS on network error
   * or non-2xx status (the `curl -f` contract callers rely on to fail-closed).
   */
  async chat(body) {
    const res = await this.fetchImpl(`${this.gateway}/v1/chat/completions`, {
      method: "POST",
      headers: this.#authHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`gateway ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Assistant text for a chat completion, or "" on ANY failure (network, non-2xx,
   * missing content). Mirrors the bash `... | jq -r '.choices[0].message.content
   * // empty' || true` degrade-to-empty behavior.
   */
  async chatContent(body) {
    try {
      const data = await this.chat(body);
      return data?.choices?.[0]?.message?.content ?? "";
    } catch {
      return "";
    }
  }

  /**
   * chatContent plus end-to-end wall-clock seconds — the port of curl's
   * `%{time_total}`. Always returns { content, seconds }; content "" on failure.
   */
  async chatTimed(body) {
    const start = performance.now();
    const content = await this.chatContent(body);
    const seconds = (performance.now() - start) / 1000;
    return { content, seconds };
  }

  /**
   * Prometheus scrape text from /metrics (authenticated). THROWS on failure so the
   * caller can set metrics_available=false and fail-closed (a router must not assume
   * $0 spend just because the scrape errored — the serving path may still be spending).
   */
  async metrics() {
    const res = await this.fetchImpl(`${this.gateway}/metrics`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`metrics ${res.status} ${res.statusText}`);
    return res.text();
  }

  /** Reachability probe — true if /health/liveliness OR /metrics answers 2xx. Never throws. */
  async health() {
    for (const path of ["/health/liveliness", "/metrics"]) {
      try {
        const res = await this.fetchImpl(`${this.gateway}${path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.apiKey}` },
        });
        if (res.ok) return true;
      } catch {
        /* try next path */
      }
    }
    return false;
  }
}
