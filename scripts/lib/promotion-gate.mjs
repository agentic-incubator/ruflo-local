// =============================================================================
// promotion-gate.mjs — evidence-gated champion/challenger promotion with auto-rollback.
//
// STATUS: reference/overlay code — runs in unit tests + offline/shadow tooling, NOT in the
// live request path (live traffic is served by the gateway / LiteLLM config). See
// docs/guide/reference/architecture-rfc.md (Path 2).
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
//
// PHASE 8 — anti-overfitting hardening (ruflo 3.25.0 methodology), ADDED on top of F1-F3,
// weakening none of them:
//   * FROZEN held-out set — a hash-pinned, tamper-evident benchmark (tests/promotion-eval-
//     frozen-v1.json). verifyFrozenSet() recomputes the sha256 and refuses a tampered set, so
//     the gate cannot be gamed by editing the yardstick. Promotion additionally requires the
//     challenger to NOT regress on this frozen set.
//   * SIGNIFICANCE — the held-out win must be statistically real (a paired, se-floored,
//     one-sided normal test), not a lucky burst. Pure-JS normal CDF; no deps, no shell-out.
//   * OVERFITTING guard — the classic self-metric-up / human-flat signature: if the automated
//     quality on held-out rises but the human-relevance label stays flat, that is overfitting to
//     the judge, and promotion is BLOCKED with the flag surfaced in the decision.
// replay-promotion.mjs replays a promotion from its RECEIPT alone (offline, identical hashes),
// recomputing the decision instead of trusting our logs.
// =============================================================================

import { createHash } from "node:crypto";

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
   * @param {number} [o.alpha=0.05]              significance level for the frozen held-out win (one-sided)
   * @param {number} [o.overfitQualityDelta=0.03] held-out auto-quality rise that, with flat human relevance, reads as overfitting
   * @param {number} [o.overfitHumanFloor=0.01]  min human-relevance gain required to NOT flag overfitting
   */
  constructor({ minSamples = 30, qualityBar = 0.7, qualityRegressionEps = 0.02, margin = 0.02, seFloor = 0.01, windowSize = 200, recentWindow = 50, alpha = 0.05, overfitQualityDelta = 0.03, overfitHumanFloor = 0.01 } = {}) {
    Object.assign(this, { minSamples, qualityBar, qualityRegressionEps, margin, seFloor, windowSize, recentWindow, alpha, overfitQualityDelta, overfitHumanFloor });
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

  /**
   * PHASE 8 — promotion decision HARDENED by the frozen held-out set. ADDITIVE: it first runs
   * the F1-F3 rolling-window gate (evaluate()), then requires the challenger to ALSO clear the
   * tamper-evident held-out benchmark — no regression, a SIGNIFICANT win, and no OVERFITTING
   * signature. Any single failure blocks promotion; the reasons are surfaced, not swallowed.
   * @param {object} o
   * @param {object} o.frozen               the parsed frozen held-out set ({ _meta.sha256, cases })
   * @param {Array}  o.challengerHeldOut    the challenger's outcomes on the held-out cases: [{ id, quality, cost, humanRelevance }]
   */
  evaluateWithHeldOut({ frozen, challengerHeldOut }) {
    // FAIL-CLOSED: verify the yardstick BEFORE evaluate()'s promoted=true side effect. A tampered
    // or malformed frozen set throws HERE, and the catch guarantees the gate is never left promoted.
    try {
      verifyFrozenSet(frozen);
    } catch (e) {
      this.promoted = false;
      throw e;
    }
    const base = this.evaluate(); // F1-F3 rolling-window discipline — UNCHANGED
    const held = heldOutRegression({
      frozen,
      challenger: challengerHeldOut,
      seFloor: this.seFloor,
      alpha: this.alpha,
      qualityRegressionEps: this.qualityRegressionEps,
      overfitQualityDelta: this.overfitQualityDelta,
      overfitHumanFloor: this.overfitHumanFloor,
    });
    const blockers = [];
    if (!base.promote) blockers.push(`rolling gate: ${base.reason}`);
    // The challenger must be scored on the ENTIRE frozen set — reporting only a winning SUBSET is
    // not evidence. Any unscored case blocks (otherwise the held-out benchmark is trivially gamed).
    if (held.missing > 0) blockers.push(`incomplete held-out coverage (${held.missing}/${frozen.cases.length} cases unscored)`);
    if (held.regressed) blockers.push(`frozen held-out regression (qDiff CI lower ${held.qDiffCI.lower.toFixed(3)})`);
    if (!held.significant) blockers.push(`held-out win not significant (p=${held.pValue.toFixed(3)} >= alpha ${this.alpha})`);
    if (held.overfit) blockers.push(`OVERFIT: held-out auto-quality up +${held.meanQDiff.toFixed(3)} but human relevance flat +${held.meanHumanDiff.toFixed(3)}`);
    const promote = blockers.length === 0;
    // The rolling evaluate() may have set promoted=true; any held-out block must veto that side effect.
    this.promoted = promote;
    return { promote, reason: promote ? "rolling + full frozen held-out + significance + no-overfit all pass" : blockers.join("; "), base, heldOut: held, blockers };
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

// =============================================================================
// PHASE 8 — frozen held-out set, significance test, overfitting guard.
// =============================================================================

/** Deterministic, key-sorted serialization so the frozen-set hash is stable across machines. */
export function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** The pin: sha256 over the canonical `cases` array only (never over the mutable `_meta`). */
export function frozenHash(cases) {
  return sha256Hex(canonicalize(cases));
}

/**
 * OUT-OF-BAND pin for the v1 frozen held-out set. Lives in CODE, separate from the JSON file, so
 * tampering requires editing BOTH (each git-tracked + reviewed). The file's self-referential
 * `_meta.sha256` alone is not trustworthy against an attacker who edits `cases` AND recomputes it.
 */
export const FROZEN_V1_SHA256 = "53babb49cfaab88f0c1b9dd5ec78d0e119f5ff94be8f71ebc90a375ae618a197";

/**
 * Tamper check for the frozen held-out set. Recomputes the hash over `cases` and refuses if the
 * pinned `_meta.sha256` does not match — so the yardstick cannot be silently edited to force a pass.
 * Pass { expected } to ALSO pin against an out-of-band known-good hash (defeats the recompute-and-
 * rewrite attack where `_meta.sha256` is edited to match doctored `cases`).
 */
export function verifyFrozenSet(set, { expected } = {}) {
  if (!set || !Array.isArray(set.cases)) throw new Error("frozen held-out set malformed: missing `cases` array");
  const claimed = set._meta && set._meta.sha256;
  const actual = frozenHash(set.cases);
  if (!claimed || claimed !== actual) {
    throw new Error(`frozen held-out set tamper check FAILED (claimed ${claimed || "<none>"} != actual ${actual})`);
  }
  if (expected && actual !== expected) {
    throw new Error(`frozen held-out set does not match the out-of-band pin (actual ${actual} != expected ${expected})`);
  }
  return true;
}

/** Abramowitz-Stegun erf approximation (max err ~1.5e-7) — pure JS, no deps, portable. */
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}

/** Standard-normal CDF Φ(z). */
export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * One-sided paired significance test that the mean diff is > 0 (challenger BETTER). se-floored so a
 * zero-variance burst cannot manufacture significance. Returns the p-value + a boolean at `alpha`.
 */
export function pairedSignificance(diffs, { alpha = 0.05, seFloor = 0.01 } = {}) {
  const ci = meanCI(diffs, { z: 1.96, seFloor });
  const z = isFinite(ci.se) && ci.se > 0 ? ci.mean / ci.se : 0;
  const pValue = 1 - normalCdf(z); // P(observe this good a win | true mean 0)
  return { mean: ci.mean, se: ci.se, z, pValue, significant: pValue < alpha && ci.mean > 0, n: ci.n };
}

/**
 * Score the challenger against the FROZEN champion baselines, id-matched. Surfaces:
 *   - regressed: held-out quality dropped (CI lower < −eps),
 *   - significant: the win is statistically real (paired, se-floored),
 *   - overfit: auto-quality rose but human relevance stayed flat (gaming the judge).
 * @param {object} o
 * @param {object} o.frozen       parsed frozen set (verified here)
 * @param {Array}  o.challenger   [{ id, quality, cost, humanRelevance }]
 */
export function heldOutRegression({ frozen, challenger, seFloor = 0.01, alpha = 0.05, qualityRegressionEps = 0.02, overfitQualityDelta = 0.03, overfitHumanFloor = 0.01 }) {
  verifyFrozenSet(frozen);
  const byId = new Map((challenger || []).map((c) => [c.id, c]));
  const qDiffs = [], hDiffs = [];
  let missing = 0;
  for (const cse of frozen.cases) {
    const ch = byId.get(cse.id);
    if (!ch) { missing++; continue; }
    qDiffs.push(ch.quality - cse.champion.quality);
    hDiffs.push((ch.humanRelevance ?? 0) - (cse.champion.humanRelevance ?? 0));
  }
  const qCI = meanCI(qDiffs, { seFloor });
  const meanHumanDiff = hDiffs.length ? hDiffs.reduce((a, b) => a + b, 0) / hDiffs.length : 0;
  const sig = pairedSignificance(qDiffs, { alpha, seFloor });
  const regressed = qCI.lower < -qualityRegressionEps;
  // OVERFIT = a MEANINGFUL auto-quality rise (a SIGNIFICANT win, OR a large raw delta) while human
  // relevance stays flat. Coupling to significance closes the band between the significance floor
  // (~z·seFloor) and overfitQualityDelta that a flat-human challenger could otherwise slip through.
  const autoQualityUp = sig.significant || qCI.mean > overfitQualityDelta;
  const overfit = autoQualityUp && qCI.mean > 0 && meanHumanDiff < overfitHumanFloor;
  return { n: qDiffs.length, missing, meanQDiff: qCI.mean, qDiffCI: qCI, meanHumanDiff, significant: sig.significant, pValue: sig.pValue, z: sig.z, regressed, overfit };
}
