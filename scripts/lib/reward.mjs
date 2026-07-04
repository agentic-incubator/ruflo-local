// =============================================================================
// reward.mjs — scalarize (quality, cost, latency) into one number for routing.
//
// The tiered gateway picks among local-fast / local-heavy / frontier deployments
// per request. A learned router (later phases) needs a single scalar signal to
// optimize: quality is a benefit, USD cost and wall-clock latency are penalties.
// This module is that scalarization, kept as a pure function so it can be
// unit-tested in isolation and later reused as the reward term in an RL-style
// promotion/demotion policy — no I/O, no env, no randomness, no clock reads.
//
// Why local-first traffic scores high: a local-fast/local-heavy answer that is
// nearly as good as frontier but costs ~$0 and returns in a fraction of a
// second dominates on the cost and latency terms while barely giving up
// quality — so the reward function naturally prefers "good enough, cheap, and
// fast" over "excellent, expensive, and slow" unless the weights say otherwise.
//
// Scalarization: reward = wQuality*quality - wCost*costNorm - wLatency*latencyNorm
//   - quality is used as-is (already normalized to [0,1] by the caller/judge).
//   - costNorm = costUsd / costRef, latencyNorm = latencySeconds / latencyRef —
//     dividing by a reference scale turns raw USD/seconds into "how many units
//     of the reference this cost/latency represents", so wCost/wLatency stay
//     interpretable (weight 0.3 means "0.3 reward lost per costRef spent").
//
// All numeric inputs are clamped defensively (see clamp01 / clampNonNegative)
// so a bad upstream measurement (negative cost, NaN latency, quality > 1)
// degrades gracefully instead of poisoning the signal. The output itself is
// NOT clamped — it's a relative signal for comparing candidates, and later
// phases (bandit/RL promotion) want the full range, including negative scores
// for slow/expensive/low-quality outcomes.
//
// Every knob is overridable via `weights` so this can be tuned per deployment
// without touching call sites; DEFAULT_WEIGHTS documents today's defaults.
// =============================================================================

/** Default weights + reference scales; see module header for the formula. */
export const DEFAULT_WEIGHTS = {
  wQuality: 1.0,
  wCost: 0.3,
  wLatency: 0.2,
  costRef: 0.01,
  latencyRef: 10,
};

/** Clamp to [0, 1]; treats non-finite (missing/NaN) as 0. */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Clamp to >= 0; treats non-finite (missing/NaN) as 0. */
function clampNonNegative(v) {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/** Reference scale guard: falls back to `fallback` when `v` isn't a positive finite number. */
function positiveOrDefault(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Scalarize (quality, cost, latency) into a single reward number.
 *
 * @param {object} args
 * @param {number} args.quality - Quality score, clamped to [0, 1].
 * @param {number} args.costUsd - Request cost in USD, clamped to >= 0.
 * @param {number} args.latencySeconds - Request latency in seconds, clamped to >= 0.
 * @param {object} [args.weights] - Overrides merged over DEFAULT_WEIGHTS.
 * @returns {number} Unclamped scalar reward; higher is better.
 */
export function reward({ quality, costUsd, latencySeconds, weights } = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const costRef = positiveOrDefault(w.costRef, DEFAULT_WEIGHTS.costRef);
  const latencyRef = positiveOrDefault(w.latencyRef, DEFAULT_WEIGHTS.latencyRef);

  const q = clamp01(quality);
  const cost = clampNonNegative(costUsd);
  const latency = clampNonNegative(latencySeconds);

  const costNorm = cost / costRef;
  const latencyNorm = latency / latencyRef;

  return w.wQuality * q - w.wCost * costNorm - w.wLatency * latencyNorm;
}
