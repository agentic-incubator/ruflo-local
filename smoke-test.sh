#!/usr/bin/env bash
# Smoke tests for the tiered routing stack. Usage: ./smoke-test.sh
set -uo pipefail
GW="${GW:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:-sk-local-master}"
hr(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

ask(){ # $1=alias $2=prompt
  curl -sS "$GW/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$1\",\"max_tokens\":60,\"messages\":[{\"role\":\"user\",\"content\":\"$2\"}]}"
}

hr "Gateway health"
curl -sS "$GW/health/liveliness" && echo

hr "Tier 1 (local-fast) answers"
ask tier-fast "Reply with exactly: TIER1-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("model:",d.get("model"),"| reply:",d["choices"][0]["message"]["content"][:60])'

hr "Tier 2 (local-heavy) answers"
ask tier-heavy "Reply with exactly: TIER2-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("model:",d.get("model"),"| reply:",d["choices"][0]["message"]["content"][:60])'

hr "Tier 3 (frontier) answers (needs a provider key; consumes budget)"
ask tier-frontier "Reply with exactly: TIER3-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("model:",d.get("model"),"| reply:",str(d["choices"][0]["message"]["content"])[:60])' \
  || echo "(skipped/failed — no frontier key configured?)"

hr "Fall-through drill: force tier-fast to fail → should serve via fallback chain"
curl -sS "$GW/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"tier-fast","mock_testing_fallbacks":true,"max_tokens":40,
       "messages":[{"role":"user","content":"Reply with exactly: FALLBACK-OK"}]}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("served by:",d.get("model"))'

hr "Privacy pin: tier-private must resolve to a LOCAL model"
ask tier-private "Reply with exactly: PRIVATE-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);m=d.get("model","");print("model:",m);assert "gpt" not in m and "claude" not in m and "gemini" not in m, "LEAK: private tier reached a cloud model!";print("locality check: PASS")'

hr "Metrics endpoint (Prometheus scrape target)"
curl -sS "$GW/metrics" | grep -m4 -E 'litellm_(total|input|output)_tokens|litellm_requests' || echo "(no traffic counted yet — rerun after the calls above)"

hr "Spend so far (per-model, from the gateway DB)"
curl -sS "$GW/spend/tags" -H "Authorization: Bearer $KEY" 2>/dev/null | head -c 400; echo
echo; echo "Done. Dashboards: Grafana http://localhost:3000  ·  Prometheus http://localhost:9090"
