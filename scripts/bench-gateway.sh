#!/usr/bin/env bash
# =============================================================================
# bench-gateway.sh — like-for-like gateway overhead benchmark (gateway variants)
#
# Fires N chat completions at whichever gateway is active on the :4000 seam
# (litellm | bifrost | helicone) and reports p50/p95 wall-clock latency, so you can
# compare the variants' added overhead on YOUR hardware. Run it once per variant:
#
#   COMPOSE_PROFILES=litellm docker compose up -d && ./scripts/bench-gateway.sh
#   COMPOSE_PROFILES=bifrost docker compose up -d && ./scripts/bench-gateway.sh
#
# Uses tier-fast (local, ~$0). %{time_total} is END-TO-END latency incl. model
# inference — read the gateway overhead as the DELTA across variants on the same model
# and hardware, not the absolute number. Degrades gracefully (skips, exit 0) when the
# gateway is unreachable.
#
# Env: GW, LITELLM_MASTER_KEY, MODEL (default tier-fast), N (default 20)
# =============================================================================
set -euo pipefail

GW="${GW:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:-sk-local-master}"
MODEL="${MODEL:-tier-fast}"
N="${N:-20}"

command -v jq >/dev/null 2>&1 || { echo "bench-gateway: jq is required" >&2; exit 1; }

# Which gateway answered? (model-agnostic reachability check)
if ! curl -fsS "$GW/health/liveliness" >/dev/null 2>&1 && ! curl -fsS "$GW/metrics" >/dev/null 2>&1; then
  jq -n --arg gw "$GW" '{gateway: $gw, samples: 0, status: "skipped",
    note: "gateway unreachable — start one variant first (COMPOSE_PROFILES=<gw> docker compose up -d)"}'
  exit 0
fi

body="$(jq -n --arg m "$MODEL" \
  '{model: $m, max_tokens: 16, messages: [{role: "user", content: "reply with: OK"}]}')"

times_file="$(mktemp)"
trap 'rm -f "$times_file"' EXIT

i=0
while [ "$i" -lt "$N" ]; do
  i=$((i + 1))
  # curl's own timing — total request wall-clock in seconds (portable across gateways).
  t="$(curl -fsS -o /dev/null -w '%{time_total}' "$GW/v1/chat/completions" \
        -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
        -d "$body" 2>/dev/null || true)"
  [ -n "$t" ] && printf '%s\n' "$t" >> "$times_file"
done

count="$(wc -l < "$times_file" | tr -d ' ')"
if [ "$count" -eq 0 ]; then
  jq -n --arg gw "$GW" '{gateway: $gw, samples: 0, status: "skipped",
    note: "gateway reachable but no completions succeeded (no model loaded / no key?)"}'
  exit 0
fi

# p50 / p95 over the collected wall-clock samples.
read -r p50 p95 mean < <(sort -n "$times_file" | awk '
  { a[NR] = $1; s += $1 }
  END {
    function pct(p,   idx) { idx = int((p/100.0) * NR); if (idx < 1) idx = 1; if (idx > NR) idx = NR; return a[idx] }
    printf "%.4f %.4f %.4f", pct(50), pct(95), s / NR
  }')

jq -n --arg gw "$GW" --arg model "$MODEL" \
  --argjson samples "$count" \
  --argjson p50 "$p50" --argjson p95 "$p95" --argjson mean "$mean" \
  '{gateway: $gw, model: $model, samples: $samples, status: "ok",
    seconds: {p50: $p50, p95: $p95, mean: $mean},
    note: "wall-clock incl. model inference; compare the SAME model across gateway variants for a fair overhead read"}'
