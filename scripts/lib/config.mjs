// =============================================================================
// config.mjs — the CLAUDE_FLOW_ROUTER_* / JUDGE_MODEL env surface, one place.
//
// The bash toolchain read env inline (`GW="${GW:-...}"`). The Node port centralizes
// that surface so every module resolves defaults identically and tests can inject a
// fake env object instead of mutating process.env. Pure + synchronous; no I/O.
//
// Every getter takes an optional `env` (defaults to process.env) so tests pass a
// plain object. Numeric getters fall back to the default on missing/blank/NaN — the
// same fail-safe the bash `is_num` guard gave.
// =============================================================================

/** String env with default; treats "" the same as unset (matches bash `${VAR:-def}`). */
export function str(name, def, env = process.env) {
  const v = env[name];
  return v === undefined || v === "" ? def : v;
}

/** Numeric env with default; blank/NaN → default (mirrors bash is_num fail-safe). */
export function num(name, def, env = process.env) {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Gateway seam + master key — shared by every module (GW / LITELLM_MASTER_KEY). */
export function gatewayConfig(env = process.env) {
  return {
    gateway: str("GW", "http://localhost:4000", env),
    apiKey: str("LITELLM_MASTER_KEY", "sk-local-master", env),
  };
}

/** verify-escalate judge surface (JUDGE_MODEL / VERIFY_THRESHOLD). */
export function judgeConfig(env = process.env) {
  return {
    judgeModel: str("JUDGE_MODEL", "tier-frontier", env),
    threshold: num("VERIFY_THRESHOLD", 0.6, env),
  };
}

/** budget-snapshot surface — frontier-scoped budgets + which Prometheus series to read. */
export function budgetConfig(env = process.env) {
  return {
    usdBudget: num("FRONTIER_USD_BUDGET", 7.0, env),
    tokenBudget: num("FRONTIER_TOKEN_BUDGET", 5000000, env),
    frontierModels: str("FRONTIER_MODELS", "claude-opus-4-8|gpt-4.1|gemini-2.5-pro", env),
    spendMetric: str("SPEND_METRIC", "litellm_spend_metric", env),
    tokenMetric: str("TOKEN_METRIC", "litellm_total_tokens", env),
  };
}

/** route-gateway surface — the host-facing seam (:4000) + which internal upstream it proxies to. */
export function gatewayServerConfig(env = process.env) {
  return {
    port: num("GATEWAY_PORT", 4000, env),
    upstream: str("GATEWAY_UPSTREAM_URL", "http://litellm:4000", env),
  };
}

/** route-gateway's router wiring — which reference policy file backs category floors. */
export function routerPolicyConfig(env = process.env) {
  return {
    policyFile: str("ROUTER_POLICY_FILE", "config/routing/router-policy.example.json", env),
  };
}

/** OTLP/HTTP trace endpoint — the SAME collector seam litellm-config.yaml's own
 *  OTEL_EXPORTER=otlp_http callback already posts gen_ai.* spans to. */
export function otelConfig(env = process.env) {
  return {
    endpoint: str("OTEL_ENDPOINT", "http://otel-collector:4318/v1/traces", env),
  };
}

/** bench-gateway surface (MODEL / N). */
export function benchConfig(env = process.env) {
  return {
    model: str("MODEL", "tier-fast", env),
    n: num("N", 20, env),
  };
}

/** quality-regression surface (fast/frontier aliases + margins). */
export function regressionConfig(env = process.env) {
  return {
    fastModel: str("FAST_MODEL", "tier-fast", env),
    frontierModel: str("FRONTIER_MODEL", "tier-frontier", env),
    margin: num("REGRESSION_MARGIN", 0.2, env),
    threshold: num("REGRESSION_THRESHOLD", 0.2, env),
  };
}

/**
 * route-gateway's env for an internal call to router.mjs/reflex.mjs — GW pinned to the
 * REAL upstream (never this gateway's own :4000, or a self-loop) plus every other real
 * env var. `env ?? process.env`, NOT `env`, matters here: in production `env` (an
 * optional override, usually `opts.env`) is undefined, and `{...undefined, GW: x}`
 * evaluates to the DEFINED object `{GW: x}` — which would defeat every downstream
 * `= process.env` default parameter in this file (default params only trigger on an
 * undefined argument, never a merely-sparse one), silently discarding every other real
 * env var (LITELLM_MASTER_KEY among them) for the call. A test's explicit env object is
 * untouched — this only changes what happens when no override was ever passed at all.
 */
export function resolveGatewayEnv(env, upstreamOrigin) {
  return { ...(env ?? process.env), GW: upstreamOrigin };
}
