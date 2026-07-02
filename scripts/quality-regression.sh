#!/usr/bin/env bash
# =============================================================================
# quality-regression.sh — gate model swaps on a fixed prompt corpus (limitations §3)
#
# Runs tests/quality-prompts.jsonl through tier-fast and tier-frontier, scores each
# answer with the (noisy, rubric-anchored, swap-averaged) judge via verify-escalate.sh,
# and flags a REGRESSION when tier-fast scores materially below tier-frontier. Exits
# non-zero when the regression fraction exceeds the threshold — run it in CI after any
# model swap (see docs/guide/reference/observability.md → Quality-regression harness).
#
# Degrades gracefully: if the judge/frontier is unreachable every row is "skipped" and
# the harness exits 0 (nothing to certify), mirroring smoke-test.sh's tier-frontier path.
#
# SECURITY: model answers are UNTRUSTED and are only ever handed to verify-escalate.sh,
# which encodes them as data (jq --arg) — never interpolated as instructions here.
#
# Usage:   ./scripts/quality-regression.sh [--corpus FILE] [--threshold F] [--limit N]
# Env:     GW, LITELLM_MASTER_KEY, FAST_MODEL (tier-fast), FRONTIER_MODEL (tier-frontier),
#          REGRESSION_MARGIN (default 0.2), REGRESSION_THRESHOLD (default 0.2)
# =============================================================================
set -euo pipefail

GW="${GW:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:-sk-local-master}"
FAST_MODEL="${FAST_MODEL:-tier-fast}"
FRONTIER_MODEL="${FRONTIER_MODEL:-tier-frontier}"
REGRESSION_MARGIN="${REGRESSION_MARGIN:-0.2}"        # frontier−fast gap that counts as a regression
REGRESSION_THRESHOLD="${REGRESSION_THRESHOLD:-0.2}"  # max fraction of regressed prompts before FAIL

CORPUS="tests/quality-prompts.jsonl"
LIMIT=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat <<'EOF'
quality-regression.sh — gate model swaps on a fixed prompt corpus (§3)

  --corpus FILE    JSONL corpus, one {id,prompt,...} per line (default tests/quality-prompts.jsonl)
  --threshold F    max regressed fraction before non-zero exit (default 0.2)
  --limit N        only run the first N prompts (0 = all)
  --help           show this help

Exit: 0 if regression fraction <= threshold (or nothing could be scored); 1 otherwise.
EOF
}

command -v jq >/dev/null 2>&1 || { echo "quality-regression: jq is required" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --corpus) CORPUS="${2:?}"; shift 2 ;;
    --threshold) REGRESSION_THRESHOLD="${2:?}"; shift 2 ;;
    --limit) LIMIT="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "quality-regression: unknown arg '$1'" >&2; usage >&2; exit 2 ;;
  esac
done
[ -f "$CORPUS" ] || { echo "quality-regression: corpus not found: $CORPUS" >&2; exit 2; }

# Ask a model (trusted prompt, jq-encoded anyway) → assistant text ("" on failure).
ask() {
  local model="$1" prompt="$2" body
  body="$(jq -n --arg model "$model" --arg p "$prompt" \
    '{model: $model, max_tokens: 512, messages: [{role: "user", content: $p}]}')"
  curl -fsS "$GW/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null | jq -r '.choices[0].message.content // empty' 2>/dev/null || true
}

# Score an answer to a prompt via the injection-safe, swap-averaged judge (null if skipped).
score() {
  "$SCRIPT_DIR/verify-escalate.sh" --prompt "$1" --answer "$2" 2>/dev/null \
    | jq -r '.score // "null"' 2>/dev/null || echo "null"
}

total=0 ; scored=0 ; skipped=0 ; regressions=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  total=$((total + 1))
  if [ "$LIMIT" -gt 0 ] && [ "$total" -gt "$LIMIT" ]; then total=$((total - 1)); break; fi

  prompt="$(printf '%s' "$line" | jq -r '.prompt')"
  id="$(printf '%s' "$line" | jq -r '.id // "?"')"

  fast_ans="$(ask "$FAST_MODEL" "$prompt")"
  front_ans="$(ask "$FRONTIER_MODEL" "$prompt")"
  fast_score="$(score "$prompt" "$fast_ans")"
  front_score="$(score "$prompt" "$front_ans")"

  if [ "$fast_score" = "null" ] || [ "$front_score" = "null" ] || [ -z "$fast_ans" ] || [ -z "$front_ans" ]; then
    skipped=$((skipped + 1))
    printf 'SKIP  %-20s (unscored — judge/model unavailable)\n' "$id" >&2
    continue
  fi
  scored=$((scored + 1))
  regressed="$(awk -v f="$fast_score" -v F="$front_score" -v m="$REGRESSION_MARGIN" \
    'BEGIN { print ((F - f) > m) ? 1 : 0 }')"
  if [ "$regressed" = "1" ]; then
    regressions=$((regressions + 1))
    printf 'REGR  %-20s fast=%s frontier=%s\n' "$id" "$fast_score" "$front_score" >&2
  else
    printf 'ok    %-20s fast=%s frontier=%s\n' "$id" "$fast_score" "$front_score" >&2
  fi
done < "$CORPUS"

frac="$(awk -v r="$regressions" -v s="$scored" 'BEGIN { printf "%.4f", (s > 0) ? r / s : 0 }')"
pass="$(awk -v x="$frac" -v t="$REGRESSION_THRESHOLD" 'BEGIN { print (x <= t) ? "true" : "false" }')"

jq -n \
  --argjson total "$total" --argjson scored "$scored" --argjson skipped "$skipped" \
  --argjson regressions "$regressions" --argjson frac "$frac" \
  --argjson threshold "$REGRESSION_THRESHOLD" --argjson pass "$pass" \
  '{total: $total, scored: $scored, skipped: $skipped, regressions: $regressions,
    regression_fraction: $frac, threshold: $threshold, pass: $pass}'

# Nothing scored (judge/frontier absent) → skip, don't fail CI. Otherwise fail on regression.
if [ "$scored" -eq 0 ]; then exit 0; fi
[ "$pass" = "true" ]
