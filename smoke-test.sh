#!/usr/bin/env bash
# Smoke tests for the tiered routing stack. Usage: ./smoke-test.sh
set -uo pipefail
# Load .env (LITELLM_MASTER_KEY, etc.) so this host-side test uses the same master
# key the gateway was started with — without this, authed calls 401 whenever the
# user set a custom LITELLM_MASTER_KEY in .env. Override the path with ENV_FILE=…
# Runtime-resolved path; nothing static for shellcheck to follow:
# shellcheck source=/dev/null
if [ -f "${ENV_FILE:-.env}" ]; then set -a; . "${ENV_FILE:-.env}"; set +a; fi
GW="${GW:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:-sk-local-master}"
# Which gateway profile is behind route-gateway — drives addressing (Helicone routes by
# path, not `model=`) and which escalation/fall-through mechanism is available (only
# LiteLLM has native mock_response/mock_testing_fallbacks test hooks). Set by the CI
# matrix (GATEWAY_KIND=${{ matrix.profile }}); defaults to litellm so existing local
# users see zero behavior change.
GATEWAY_KIND="${GATEWAY_KIND:-litellm}"
if [ -z "${GATEWAY_ADDRESSING:-}" ]; then
  GATEWAY_ADDRESSING="model"
  [ "$GATEWAY_KIND" = "helicone" ] && GATEWAY_ADDRESSING="path"
fi
# fake-upstream (scripts/lib/fake-upstream-server.mjs, docker-compose.ci.yml) — a
# controllable transparent proxy in front of Ollama. When reachable, it gives the
# escalation/fall-through drills below real, deterministic signal on ANY gateway
# (litellm/bifrost/helicone alike), not just LiteLLM's native mock hooks.
FAKE_UPSTREAM="${FAKE_UPSTREAM:-http://localhost:9100}"
# How many consecutive forced failures the fall-through drill needs to arm before
# tier-fast's OWN deployment gives up and the gateway actually engages its fallback
# chain. LiteLLM retries the SAME deployment litellm-config.yaml's num_retries (2)
# times before falling over — 1 initial attempt + 2 retries = 3 — so arming for just 1
# gets silently absorbed by litellm's own retry and never reaches the real fallback
# chain at all (confirmed live: a single forced failure still returned a normal
# tier-fast-labeled success). Bifrost/Helicone's templates show no equivalent retry
# count (EXPERIMENTAL/unverified against their pinned images, same caveat as the rest
# of this repo's bifrost/helicone integration) — default to 1, i.e. assume immediate
# failover; arming for litellm's higher count on them risks also intercepting the
# fallback TARGET's first attempt, breaking the drill the other way.
FALLBACK_FORCE_TIMES=1
[ "$GATEWAY_KIND" = "litellm" ] && FALLBACK_FORCE_TIMES=3
hr(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# The escalation-drill and DRACO-corpus-growth checks below exercise reflex.mjs's
# judge/escalate logic and recorder.mjs's corpus — both exist ONLY in route-gateway,
# never in bare litellm. CI's local-smoke/escalation jobs start litellm directly on
# :4000 (no route-gateway container) to stay hardware-neutral, so those two checks
# gracefully skip there rather than failing on an environment that was never meant
# to have them. A full local `docker compose up` (which does run route-gateway)
# exercises both for real.
have_route_gateway(){
  command -v docker >/dev/null 2>&1 || return 1
  [ -n "$(docker ps --filter 'name=^route-gateway$' --filter status=running -q 2>/dev/null)" ]
}

have_fake_upstream(){
  curl -sS -f -o /dev/null --max-time 2 "$FAKE_UPSTREAM/health" 2>/dev/null
}

control_fake_upstream(){ # $1=JSON body, e.g. '{"mode":"bad-answer","times":1}'
  curl -sS -X POST "$FAKE_UPSTREAM/control" -H "Content-Type: application/json" -d "$1" >/dev/null
}

ask(){ # $1=alias $2=prompt
  if [ "$GATEWAY_ADDRESSING" = "path" ]; then
    # Helicone's router IDs are regex-capped at 12 chars (ROUTER_ID_REGEX in its own
    # source) — "tier-frontier" (13) can't exist as a router name at all, so Helicone's
    # routers drop the "tier-" prefix uniformly (fast/heavy/frontier/private) rather
    # than special-casing just the one tier that overflows. See helicone-config.yaml.tmpl.
    curl -sS "$GW/router/${1#tier-}/chat/completions" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "{\"max_tokens\":60,\"messages\":[{\"role\":\"user\",\"content\":\"$2\"}]}"
  else
    curl -sS "$GW/v1/chat/completions" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "{\"model\":\"$1\",\"max_tokens\":60,\"messages\":[{\"role\":\"user\",\"content\":\"$2\"}]}"
  fi
}

# Shared verdict for both the fake-upstream and litellm-native escalation mechanisms
# below — $1 is the reply text actually returned by the drill's forced-bad-answer call.
assess_escalation(){
  if [ -n "$1" ] && [ "$1" != "$BAD_ANSWER" ]; then
    echo "escalated away from the forced-bad local answer -> real frontier reply: $1"
  elif [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
    echo "SKIPPED (no frontier provider key configured — tier-frontier has nothing to judge/escalate to)"
  else
    echo "WARNING: a frontier key IS configured but escalation did NOT happen — this is a real regression, not a benign skip"
  fi
}

hr "Gateway health"
curl -sS "$GW/health/liveliness" && echo

hr "Tier 1 (local-fast) answers"
ask tier-fast "Reply with exactly: TIER1-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("model:",d.get("model"),"| reply:",d["choices"][0]["message"]["content"][:60])'

hr "Tier 2 (local-heavy) answers"
ask tier-heavy "Reply with exactly: TIER2-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("model:",d.get("model"),"| reply:",d["choices"][0]["message"]["content"][:60])'

# SMOKE_LOCAL_ONLY=1 skips every cloud/escalation check (frontier tier). Used by the
# GitHub Actions local-smoke job, which runs against a tiny local Ollama model with no
# provider keys — it proves the local-tier + privacy-pin + fallback wiring, no secrets.
if [ -z "${SMOKE_LOCAL_ONLY:-}" ]; then
  hr "Tier 3 (frontier) answers (needs a provider key; consumes budget)"
  ask tier-frontier "Reply with exactly: TIER3-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("model:",d.get("model"),"| reply:",str(d["choices"][0]["message"]["content"])[:60])' \
    || echo "(skipped/failed — no frontier key configured?)"
else
  hr "Tier 3 (frontier) — SKIPPED (SMOKE_LOCAL_ONLY set: local-only run, no escalation)"
fi

hr "Escalation drill: a forced known-bad local answer must escalate to tier-frontier"
# This exact string is what a forced-bad local answer looks like, whichever mechanism
# below produces it — the REAL judge (a real frontier-model call) reliably scores it
# low. If reflex.mjs escalates, the client-visible content is replaced by a real
# frontier answer that is NOT this string; if it's unchanged, either no frontier key is
# configured or the escalation didn't happen.
BAD_ANSWER="I cannot help with that request. Please try again later."
if [ -n "${SMOKE_LOCAL_ONLY:-}" ]; then
  echo "SKIPPED (SMOKE_LOCAL_ONLY set: no escalation)"
elif ! have_route_gateway; then
  echo "SKIPPED (no route-gateway container running — reflex.mjs's judge/escalate only runs there, never in bare litellm)"
elif have_fake_upstream; then
  # Uniform path — identical for litellm/bifrost/helicone. fake-upstream sits in front
  # of Ollama (docker-compose.ci.yml, CI "ci" model variant only) and is armed to
  # deterministically return BAD_ANSWER for exactly the next tier-fast call — no
  # gateway-specific mock hook needed.
  control_fake_upstream '{"mode":"bad-answer","times":1}'
  reply=$(ask tier-fast "What is the capital of France? Reply with just the city name." \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["choices"][0]["message"]["content"])' 2>/dev/null)
  assess_escalation "$reply"
elif [ "$GATEWAY_KIND" = "litellm" ]; then
  # LiteLLM's own mock_response test hook — zero extra infra, works today without the
  # CI overlay (docker-compose.ci.yml).
  reply=$(curl -sS "$GW/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"tier-fast\",\"mock_response\":\"$BAD_ANSWER\",\"max_tokens\":40,
         \"messages\":[{\"role\":\"user\",\"content\":\"What is the capital of France? Reply with just the city name.\"}]}" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["choices"][0]["message"]["content"])' 2>/dev/null)
  assess_escalation "$reply"
else
  echo "SKIPPED (no fake-upstream reachable and $GATEWAY_KIND has no native mock-response hook — bring up docker-compose.ci.yml for full coverage)"
fi

hr "Fall-through drill: force tier-fast to fail → should serve via fallback chain"
if have_fake_upstream; then
  # Uniform path — identical for litellm/bifrost/helicone (see the escalation drill above).
  control_fake_upstream "{\"mode\":\"fail\",\"times\":$FALLBACK_FORCE_TIMES}"
  ask tier-fast "Reply with exactly: FALLBACK-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("served by:",d.get("model"))'
elif [ "$GATEWAY_KIND" = "litellm" ]; then
  curl -sS "$GW/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d '{"model":"tier-fast","mock_testing_fallbacks":true,"max_tokens":40,
         "messages":[{"role":"user","content":"Reply with exactly: FALLBACK-OK"}]}' \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print("served by:",d.get("model"))'
else
  echo "SKIPPED (no fake-upstream reachable and $GATEWAY_KIND has no native fallback-forcing hook — bring up docker-compose.ci.yml for full coverage)"
fi

hr "DRACO corpus growth: a real call must add exactly one new row, with a real (non-stub) embedding"
if ! have_route_gateway; then
  echo "SKIPPED (no route-gateway container running — recorder.mjs's corpus only exists there)"
else
  # idmap.json's nextLabel is the next free row id, so (nextLabel - 1) is the current row
  # count — reading it avoids the "another writer holds the lock" error that opening the
  # .rvf directly would hit while route-gateway's own recorder still has it open.
  corpus_count(){
    docker exec route-gateway node -e '
      const fs = require("fs");
      try {
        const m = JSON.parse(fs.readFileSync("/app/.ruvector/routing-corpus.rvf.idmap.json", "utf8"));
        console.log(m.nextLabel - 1);
      } catch { console.log(0); }
    ' 2>/dev/null
  }
  corpus_size(){ docker exec route-gateway sh -c 'stat -c%s /app/.ruvector/routing-corpus.rvf 2>/dev/null || echo 0'; }

  # Recorder writes are fire-and-forget AFTER the response is sent, so an EARLIER drill's
  # (e.g. the fall-through/escalation checks above) row can still be landing when this
  # section starts — capturing before_count too early would make it stale, and this run's
  # own +1 would then look like +2 (or the poll below would time out waiting for a count
  # that will never appear). Settle on a stable reading (same value twice in a row) first.
  before_count=$(corpus_count)
  for _ in $(seq 1 20); do
    sleep 0.25
    now_count=$(corpus_count)
    [ "$now_count" = "$before_count" ] && break
    before_count=$now_count
  done
  before_size=$(corpus_size)
  # A prompt unique to THIS run — the corpus is deduped by prompt_hash, so re-running this
  # script against an existing corpus with a fixed literal prompt would upsert the same row
  # forever instead of ever growing it.
  nonce="smoke-$(date +%s)-$$"
  ask tier-fast "Distinct smoke-test nonce prompt: $nonce" > /dev/null

  # recorder.mjs records fire-and-forget AFTER the response is already sent — poll briefly.
  after_count=$before_count
  for _ in $(seq 1 20); do
    sleep 0.5
    after_count=$(corpus_count)
    [ "$after_count" = "$((before_count + 1))" ] && break
  done
  after_size=$(corpus_size)

  if [ "$after_count" = "$((before_count + 1))" ]; then
    echo "corpus grew by exactly 1 row ($before_count -> $after_count)"
  else
    echo "WARNING: expected corpus to grow by exactly 1 ($before_count -> $((before_count + 1))), got $after_count"
  fi
  # recorder.mjs's own RoutingRecorder.record() hard-validates embedding.length against the
  # store's configured dimension and throws (never writes) on any shape mismatch — it has no
  # code path that writes a stub/zero embedding at all, so a row existing at all is already
  # proof the embedding was real. The byte-size growth is a second, independent signal: a
  # real 768-dim float32 vector is ~3KB; a near-zero size delta would mean nothing real landed.
  size_growth=$((after_size - before_size))
  if [ "$size_growth" -gt 500 ]; then
    echo "corpus file grew by $size_growth bytes — consistent with one real embedded vector, not a stub"
  else
    echo "WARNING: corpus file only grew by $size_growth bytes — too small for a real embedded vector"
  fi
fi

hr "Privacy pin: tier-private must resolve to a LOCAL model, THROUGH route-gateway (phase 0-2's seam), not litellm directly"
ask tier-private "Reply with exactly: PRIVATE-OK" | python3 -c 'import sys,json;d=json.load(sys.stdin);m=d.get("model","");print("model:",m);assert "gpt" not in m and "claude" not in m and "gemini" not in m, "LEAK: private tier reached a cloud model!";print("locality check: PASS")'

hr "Metrics endpoint (Prometheus scrape target)"
curl -sS "$GW/metrics" | grep -m4 -E 'litellm_(total|input|output)_tokens|litellm_requests' || echo "(no traffic counted yet — rerun after the calls above)"

hr "Spend so far (per-model, from the gateway DB)"
curl -sS "$GW/spend/tags" -H "Authorization: Bearer $KEY" 2>/dev/null | head -c 400; echo
echo; echo "Done. Dashboards: Grafana http://localhost:3000  ·  Prometheus http://localhost:9090"
