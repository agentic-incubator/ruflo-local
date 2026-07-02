#!/usr/bin/env bash
# =============================================================================
# budget-snapshot.sh — machine-readable remaining-budget snapshot (limitations §4)
#
# Emits JSON a router (e.g. ruflo route()) consumes to make budget STEER, not just
# alert: DEMOTE frontier candidates as budget fills (50/75/90 rungs) and MASK them
# at 100% — except pinned / escalation-forced turns. LiteLLM's per-deployment
# max_budget + HTTP 429 skip remains the fail-closed backstop underneath.
#
# FRONTIER-SCOPED: only frontier deployments' spend/tokens count. Local tiers and
# tier-private are NEVER budget-steered (locality/privacy invariant) — their $0,
# high-volume traffic must not perturb the frontier signal.
#
# CAVEAT (budget window): $GW/metrics counters may be CUMULATIVE, while the
# gateway's max_budget resets every budget_duration (1d). Set FRONTIER_USD_BUDGET /
# FRONTIER_TOKEN_BUDGET to reflect the SAME window as the metric you read, or point
# SPEND_METRIC/TOKEN_METRIC at a period-aware remaining-budget gauge (LiteLLM emits
# these when prometheus_initialize_budget_metrics is on — enabled in this kit).
#
# Usage:   ./scripts/budget-snapshot.sh
# Env:     GW, LITELLM_MASTER_KEY, FRONTIER_USD_BUDGET, FRONTIER_TOKEN_BUDGET,
#          FRONTIER_MODELS (regex), SPEND_METRIC, TOKEN_METRIC — override style
#          matches smoke-test.sh.
# =============================================================================
set -euo pipefail

GW="${GW:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:-sk-local-master}"

FRONTIER_USD_BUDGET="${FRONTIER_USD_BUDGET:-7.00}"          # sum of frontier daily USD caps
FRONTIER_TOKEN_BUDGET="${FRONTIER_TOKEN_BUDGET:-5000000}"   # router-side cumulative token budget
FRONTIER_MODELS="${FRONTIER_MODELS:-claude-opus-4-8|gpt-4.1|gemini-2.5-pro}"
SPEND_METRIC="${SPEND_METRIC:-litellm_spend_metric}"
TOKEN_METRIC="${TOKEN_METRIC:-litellm_total_tokens}"

command -v jq >/dev/null 2>&1 || { echo "budget-snapshot: jq is required" >&2; exit 1; }

is_num() { case "$1" in ''|*[!0-9.]*) return 1 ;; *) return 0 ;; esac; }
for v in FRONTIER_USD_BUDGET FRONTIER_TOKEN_BUDGET; do
  is_num "${!v}" || { echo "budget-snapshot: $v must be numeric (got '${!v}')" >&2; exit 1; }
done

# Scrape the gateway. `-f` makes HTTP 4xx/5xx a non-zero exit (curl otherwise exits 0
# on error bodies), so we can distinguish "reachable" from "erroring" and flag it —
# a router should FAIL-CLOSED (demote/mask) when metrics_available is false, because
# the serving path may still be spending, bounded only by the 429 cap.
if metrics="$(curl -fsS -H "Authorization: Bearer $KEY" "$GW/metrics" 2>/dev/null)"; then
  metrics_available=true
else
  metrics="" ; metrics_available=false
fi

sum_frontier() { # $1 = base metric → sum sample values for FRONTIER deployments only (0 if none)
  # `^name(_total)?{` anchors to the SAMPLE line (excludes companion series like
  # name_created / name_bucket that would otherwise be summed); FRONTIER_MODELS
  # restricts to frontier deployments so local/private traffic never counts.
  printf '%s\n' "$metrics" \
    | { grep -E "^$1(_total)?\{[^}]*($FRONTIER_MODELS)" || true; } \
    | awk '{ s += $NF } END { printf "%.6f", s + 0 }'
}

util() { # $1 = spent, $2 = budget → utilization in [0, ∞), 0 when budget<=0
  awk -v s="$1" -v b="$2" 'BEGIN { if (b > 0) printf "%.4f", s / b; else printf "0" }'
}

rung() { # $1 = utilization → demotion penalty (RFC §8.2: 0 <0.5, ramp 0.5→0.9, MASK at 1.0)
  awk -v u="$1" 'BEGIN {
    if      (u >= 1.0)  print "mask";
    else if (u >= 0.9)  print "0.75";
    else if (u >= 0.75) print "0.5";
    else if (u >= 0.5)  print "0.25";
    else                print "0";
  }'
}

usd_spent="$(sum_frontier "$SPEND_METRIC")"
tok_spent="$(sum_frontier "$TOKEN_METRIC")"
usd_util="$(util "$usd_spent" "$FRONTIER_USD_BUDGET")"
tok_util="$(util "$tok_spent" "$FRONTIER_TOKEN_BUDGET")"

# The tighter of the two budgets governs demotion (fail-closed on the worse pressure).
gov_util="$(awk -v a="$usd_util" -v b="$tok_util" 'BEGIN { print (a > b) ? a : b }')"
frontier_rung="$(rung "$gov_util")"
if [ "$frontier_rung" = "mask" ]; then frontier_masked=true; else frontier_masked=false; fi

jq -n \
  --argjson usd_spent "$usd_spent" \
  --argjson usd_budget "$FRONTIER_USD_BUDGET" \
  --argjson usd_util "$usd_util" \
  --argjson tok_spent "$tok_spent" \
  --argjson tok_budget "$FRONTIER_TOKEN_BUDGET" \
  --argjson tok_util "$tok_util" \
  --argjson gov_util "$gov_util" \
  --arg rung "$frontier_rung" \
  --argjson masked "$frontier_masked" \
  --argjson available "$metrics_available" \
  '{
     schema_version: 1,
     scope: "frontier",
     note: "Frontier-only demotion; local tiers and tier-private are never steered.",
     metrics_available: $available,
     metrics_available_hint: "when false, the router should fail-closed (demote/mask frontier) — the gateway may still be spending",
     usd:    { spent: $usd_spent, budget: $usd_budget, utilization: $usd_util },
     tokens: { spent: $tok_spent, budget: $tok_budget, utilization: $tok_util },
     governing_utilization: $gov_util,
     demotion_rung: $rung,
     frontier_masked: $masked,
     mask_exceptions: ["pinned", "escalation-forced"]
   }'
