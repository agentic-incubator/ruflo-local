// =============================================================================
// promotion-gate.mjs — evidence-gated champion/challenger promotion with auto-rollback.
//
// The challenger only serves if it is BETTER, not just CHEAPER. A raw quality-per-dollar
// ratio is unsafe: with ~$0 local tiers, cost dominates and a garbage-quality free router
// would "win" purely for being free (and could never be rolled back). So promotion requires
// ALL of (DRACO "cheapest candidate that clears the quality bar" discipline, ruvnet
// ADR-072/073/076):
//   1. >= minSamples paired outcomes in the rolling window,
//   2. ABSOLUTE quality floor — mean challenger quality >= qualityBar,
//   3. NO quality regression vs champion — CI lower bound of (challenger − champion)
//      quality >= −qualityRegressionEps,
//   4. a real EFFICIENCY win — CI lower bound of the q/$ diff > margin.
// The CI is se-FLOORED so a zero-variance burst cannot manufacture false certainty (a
// constant +ε sample must still clear z·seFloor + margin, not just be > 0).
//
// AUTO-ROLLBACK is TREND-AWARE (a RECENT sub-window, not the whole history) and SCALE-FREE
// (fires on quality, which is [0,1]): a promoted router rolls back the moment its recent
// quality drops below the bar OR it recently regresses vs the retained champion. The champion
// is never discarded — it stays the fallback.
// =============================================================================

/** Quality per dollar (efficiency signal only — never the sole gate). Local tiers ≈ $0. */
export function qPerDollar(quality, costUsd, { freeCostFloor = 0.001 } = {}) {
  return quality / Math.max(costUsd ?? 0, freeCostFloor);
}

/** Mean + se-floored normal-approx CI (both bounds). seFloor stops zero-variance collapse. */
export function meanCI(xs, { z = 1.96, seFloor = 0 } = {}) {
  const n = xs.length;
  if (n === 0) return { mean: 0, lower: -Infinity, upper: Infinity, se: Infinity, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const varr = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.max(Math.sqrt(varr / n), seFloor);
  return { mean, lower: mean - z * se, upper: mean + z * se, se, n };
}

export class PromotionGate {
  /**
   * @param {object} [o]
   * @param {number} [o.minSamples=30]           min paired outcomes before promotion is considered
   * @param {number} [o.qualityBar=0.7]          absolute floor — mean challenger quality must clear it
   * @param {number} [o.qualityRegressionEps=0.02] max tolerated quality regression vs champion (CI lower)
   * @param {number} [o.margin=0.02]             q/$ diff the CI lower bound must clear (efficiency win)
   * @param {number} [o.seFloor=0.01]            floor on the standard error (anti zero-variance)
   * @param {number} [o.windowSize=200]          rolling window for the promotion decision
   * @param {number} [o.recentWindow=50]         RECENT sub-window used for trend-aware rollback
   */
  constructor({ minSamples = 30, qualityBar = 0.7, qualityRegressionEps = 0.02, margin = 0.02, seFloor = 0.01, windowSize = 200, recentWindow = 50 } = {}) {
    Object.assign(this, { minSamples, qualityBar, qualityRegressionEps, margin, seFloor, windowSize, recentWindow });
    this.samples = []; // {chalQ, champQ, qDiff, qpdDiff}
    this.promoted = false;
  }

  record({ championQuality, championCost, challengerQuality, challengerCost }) {
    const qpdDiff = qPerDollar(challengerQuality, challengerCost) - qPerDollar(championQuality, championCost);
    const s = { chalQ: challengerQuality, champQ: championQuality, qDiff: challengerQuality - championQuality, qpdDiff };
    this.samples.push(s);
    if (this.samples.length > this.windowSize) this.samples.shift();
    return s;
  }

  #stats(rows) {
    const meanChalQ = rows.length ? rows.reduce((a, r) => a + r.chalQ, 0) / rows.length : 0;
    const qDiffCI = meanCI(rows.map((r) => r.qDiff), { seFloor: this.seFloor });
    const qpdCI = meanCI(rows.map((r) => r.qpdDiff), { seFloor: this.seFloor });
    return { n: rows.length, meanChalQ, qDiffCI, qpdCI };
  }

  /** Promotion decision. Needs samples + absolute quality + no quality regression + efficiency win. */
  evaluate() {
    const st = this.#stats(this.samples);
    if (st.n < this.minSamples) return { promote: false, reason: `insufficient samples (${st.n}/${this.minSamples})`, ...st };
    if (st.meanChalQ < this.qualityBar) return { promote: false, reason: `below quality bar (${st.meanChalQ.toFixed(3)} < ${this.qualityBar})`, ...st };
    if (st.qDiffCI.lower < -this.qualityRegressionEps) return { promote: false, reason: `quality regression risk (qDiff CI lower ${st.qDiffCI.lower.toFixed(3)})`, ...st };
    if (st.qpdCI.lower <= this.margin) return { promote: false, reason: `efficiency win not proven (q/$ CI lower ${st.qpdCI.lower.toFixed(3)} <= margin ${this.margin})`, ...st };
    this.promoted = true;
    return { promote: true, reason: `quality ${st.meanChalQ.toFixed(3)}>=bar, no regression, q/$ CI lower ${st.qpdCI.lower.toFixed(3)}>margin`, ...st };
  }

  /** Trend-aware, scale-free rollback over the RECENT sub-window. */
  checkRollback() {
    if (!this.promoted) return { rollback: false, reason: "not promoted" };
    const recent = this.samples.slice(-this.recentWindow);
    const st = this.#stats(recent);
    if (st.meanChalQ < this.qualityBar) {
      this.promoted = false;
      return { rollback: true, restore: "champion", reason: `recent quality ${st.meanChalQ.toFixed(3)} < bar ${this.qualityBar}`, ...st };
    }
    if (st.qDiffCI.upper < -this.qualityRegressionEps) {
      this.promoted = false;
      return { rollback: true, restore: "champion", reason: `recent quality regression (qDiff CI upper ${st.qDiffCI.upper.toFixed(3)})`, ...st };
    }
    return { rollback: false, reason: `holding (recent quality ${st.meanChalQ.toFixed(3)})`, ...st };
  }
}

/**
 * Offline replay: challenger vs champion vs the per-question ORACLE (upper bound) on paired
 * outcomes. Reports mean quality AND mean q/$ for each — the honest "did it actually win?" read.
 */
export function replay(outcomes) {
  const m = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const champQpd = outcomes.map((o) => qPerDollar(o.championQuality, o.championCost));
  const chalQpd = outcomes.map((o) => qPerDollar(o.challengerQuality, o.challengerCost));
  return {
    n: outcomes.length,
    quality: { champion: m(outcomes.map((o) => o.championQuality)), challenger: m(outcomes.map((o) => o.challengerQuality)), oracle: m(outcomes.map((o) => Math.max(o.championQuality, o.challengerQuality))) },
    qPerDollar: { champion: m(champQpd), challenger: m(chalQpd), oracle: m(outcomes.map((_, i) => Math.max(champQpd[i], chalQpd[i]))) },
  };
}
