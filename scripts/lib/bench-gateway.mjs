// =============================================================================
// bench-gateway.mjs — like-for-like gateway overhead benchmark (gateway variants)
//
// In-process Node port of bench-gateway.sh — SAME contract, no bash/jq/curl:
// fires N chat completions at whichever gateway is active on the :4000 seam
// (litellm | bifrost | helicone) and reports p50/p95 wall-clock latency, so you can
// compare the variants' added overhead on YOUR hardware. Run it once per variant:
//
//   COMPOSE_PROFILES=litellm docker compose up -d && ./scripts/bench-gateway.sh
//   COMPOSE_PROFILES=bifrost docker compose up -d && ./scripts/bench-gateway.sh
//
// Uses tier-fast (local, ~$0). GatewayClient#chatTimed's `seconds` is the port of
// curl's %{time_total} — END-TO-END latency incl. model inference — read the gateway
// overhead as the DELTA across variants on the same model and hardware, not the
// absolute number. Degrades gracefully (skips, exit 0) when the gateway is unreachable
// or no completion succeeds.
// =============================================================================

import { GatewayClient } from "./gateway-client.mjs";
import { benchConfig } from "./config.mjs";

/**
 * p50 / p95 / mean over a list of wall-clock second samples. Pure; 1-indexed
 * nearest-rank percentile (mirrors the bash awk `pct()` helper).
 * @param {number[]} samples
 * @returns {{p50:number, p95:number, mean:number}}
 */
export function percentiles(samples) {
  const a = [...samples].sort((x, y) => x - y);
  const n = a.length;
  const pct = (p) => {
    const idx = Math.trunc((p / 100) * n);
    return a[Math.min(Math.max(idx, 1), n) - 1];
  };
  const mean = a.reduce((s, x) => s + x, 0) / n;
  return {
    p50: Number(pct(50).toFixed(4)),
    p95: Number(pct(95).toFixed(4)),
    mean: Number(mean.toFixed(4)),
  };
}

/**
 * Run the benchmark and return the result object (no printing).
 * @param {{client?:GatewayClient, env?:object}} [opts]
 */
export async function benchGateway({ client, env } = {}) {
  const gw = client ?? new GatewayClient({ env });
  const { model, n } = benchConfig(env);

  // Which gateway answered? (model-agnostic reachability check)
  if (!(await gw.health())) {
    return {
      gateway: gw.gateway,
      samples: 0,
      status: "skipped",
      note: "gateway unreachable — start one variant first (COMPOSE_PROFILES=<gw> docker compose up -d)",
    };
  }

  const body = {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "reply with: OK" }],
  };

  const samples = [];
  for (let i = 0; i < n; i++) {
    const { content, seconds } = await gw.chatTimed(body);
    if (content) samples.push(seconds);
  }

  if (samples.length === 0) {
    return {
      gateway: gw.gateway,
      samples: 0,
      status: "skipped",
      note: "gateway reachable but no completions succeeded (no model loaded / no key?)",
    };
  }

  return {
    gateway: gw.gateway,
    model,
    samples: samples.length,
    status: "ok",
    seconds: percentiles(samples),
    note: "wall-clock incl. model inference; compare the SAME model across gateway variants for a fair overhead read",
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export async function main() {
  const result = await benchGateway();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// Run as a script (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0));
}
