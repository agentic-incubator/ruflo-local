// promotion.test.mjs — the per-question learned router as a shadow challenger under an
// evidence-gated promotion. Proves: SHADOW-only (never serves, never throws into serving);
// replay reports quality + q/$ vs oracle; the gate does NOT promote on thin data, on a
// zero-variance hair, OR on a cheaper-but-WORSE (free) router; a sustained quality+efficiency
// win promotes; a regression (fast OR slow) auto-rolls-back. KRR trains + predicts fail-safe.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { trainRouter, predict, hashEmbed, solveLinear, difficultyForClass } from "../train-router.mjs";
import { ShadowChallenger } from "../challenger.mjs";
import { PromotionGate, qPerDollar, meanCI, replay } from "../promotion-gate.mjs";

const seedRows = [
  { prompt: "fix this null bug in python", task_class: "bugfix" },
  { prompt: "explain what a mutex protects against", task_class: "explain" },
  { prompt: "refactor this duplicated branch logic", task_class: "refactor" },
  { prompt: "prove this cross-file refactor preserves the invariant", task_class: "prove" },
];
const model = () => trainRouter({ rows: seedRows });
/** Feed the gate `n` identical paired outcomes. */
const feed = (gate, n, o) => { for (let i = 0; i < n; i++) gate.record(o); };

describe("train-router (KRR)", () => {
  test("should_solveLinearSystem", () => {
    const x = solveLinear([[2, 1], [1, 3]], [5, 10]); // x=1, y=3
    assert.ok(Math.abs(x[0] - 1) < 1e-9 && Math.abs(x[1] - 3) < 1e-9);
  });
  test("should_produceCandidatesAndAlpha_ofTrainingSize", () => {
    const m = model();
    assert.equal(m.candidates.length, 3);
    assert.equal(m.alpha.length, seedRows.length);
  });
  test("should_mapHarderClassToHigherDifficulty", () => {
    assert.ok(difficultyForClass("prove") > difficultyForClass("explain"));
  });
  test("should_failSafeToCheapestTier_when_scoreIsNonFinite", () => {
    // A corrupt model (NaN alpha) must NOT default to the most expensive off-box tier.
    const m = model();
    m.alpha = m.alpha.map(() => NaN);
    assert.equal(predict(m, hashEmbed("anything", m.dim)).tier, "tier-fast");
  });
});

describe("ShadowChallenger — shadow only, never serves, never throws", () => {
  test("should_returnChampionTier_regardlessOfShadowPick", () => {
    const c = new ShadowChallenger(model(), hashEmbed);
    assert.equal(c.observe({ prompt: "prove this hard thing", championTier: "tier-fast" }), "tier-fast");
    assert.equal(c.records[0].served, "tier-fast");
  });
  test("should_notThrowIntoServing_when_predictFails", () => {
    // A broken embedder makes predict throw; observe must still return the champion tier.
    const c = new ShadowChallenger(model(), () => undefined);
    assert.equal(c.observe({ prompt: "x", championTier: "tier-heavy" }), "tier-heavy");
  });
  test("should_neverScorePrivateOffBox_when_pinnedPrivate", () => {
    let embedCalled = false;
    const c = new ShadowChallenger(model(), (t, d) => { embedCalled = true; return hashEmbed(t, d); });
    const served = c.observe({ prompt: "secret", championTier: "tier-private", pinnedPrivate: true });
    assert.equal(served, "tier-private");
    assert.equal(c.records[0].challengerTier, "tier-private");
    assert.equal(embedCalled, false); // private prompt never reaches the model
  });
});

describe("gate metrics", () => {
  test("should_floorStandardError_so_zeroVarianceDoesNotCollapseCI", () => {
    const s = meanCI([0.001, 0.001, 0.001], { seFloor: 0.01 });
    assert.ok(s.lower < s.mean); // se-floored → lower strictly below mean even at zero variance
  });
  test("should_computeQPerDollar_cheaperIsHigher", () => {
    assert.ok(qPerDollar(1, 1) < qPerDollar(1, 0.5));
  });
});

describe("replay — quality + q/$ vs oracle", () => {
  test("should_reportOracleAtLeastAsGoodAsEither", () => {
    const r = replay([
      { championQuality: 0.8, championCost: 1, challengerQuality: 0.9, challengerCost: 0.5 },
      { championQuality: 0.9, championCost: 0.5, challengerQuality: 0.7, challengerCost: 1 },
    ]);
    assert.ok(r.quality.oracle >= Math.max(r.quality.champion, r.quality.challenger));
    assert.ok(r.qPerDollar.oracle >= Math.max(r.qPerDollar.champion, r.qPerDollar.challenger));
  });
});

describe("promotion gate — the F1 fix and the discipline", () => {
  test("should_NOT_promote_onThinData", () => {
    const g = new PromotionGate({ minSamples: 30 });
    feed(g, 5, { championQuality: 0.8, championCost: 2, challengerQuality: 0.85, challengerCost: 1 });
    assert.equal(g.evaluate().promote, false);
  });

  test("should_NOT_promote_aCheaperButWorseFreeRouter_F1", () => {
    // THE critical case: free 0.10-quality challenger vs 0.95 frontier champion.
    const g = new PromotionGate({ minSamples: 20 });
    feed(g, 40, { championQuality: 0.95, championCost: 45, challengerQuality: 0.10, challengerCost: 0 });
    const d = g.evaluate();
    assert.equal(d.promote, false); // quality bar + no-regression block it, despite huge q/$
    assert.match(d.reason, /quality/);
  });

  test("should_NOT_promote_onZeroVarianceHair_seFloor_F2", () => {
    const g = new PromotionGate({ minSamples: 1, qualityBar: 0.7, margin: 0.02, seFloor: 0.01 });
    // meets quality + no regression, but the q/$ edge is a hair (+0.001) → se-floor blocks it.
    g.record({ championQuality: 0.75, championCost: 1.0, challengerQuality: 0.75, challengerCost: 0.999 });
    assert.equal(g.evaluate().promote, false);
  });

  test("should_promote_onSustainedQualityAndEfficiencyWin", () => {
    const g = new PromotionGate({ minSamples: 20 });
    // challenger: >= bar quality, no regression, and genuinely cheaper (real q/$ win).
    feed(g, 40, { championQuality: 0.80, championCost: 2.0, challengerQuality: 0.85, challengerCost: 1.0 });
    const d = g.evaluate();
    assert.equal(d.promote, true);
  });

  test("should_rollback_onCatastrophicRegression", () => {
    const g = new PromotionGate({ minSamples: 10, recentWindow: 20 });
    feed(g, 15, { championQuality: 0.80, championCost: 2, challengerQuality: 0.85, challengerCost: 1 });
    assert.equal(g.evaluate().promote, true);
    feed(g, 20, { championQuality: 0.90, championCost: 1, challengerQuality: 0.30, challengerCost: 2 });
    const rb = g.checkRollback();
    assert.equal(rb.rollback, true);
    assert.equal(g.promoted, false);
  });

  test("should_rollback_onSlowRecentRegression_F3", () => {
    // The evasion band the reviewer flagged: challenger still >= bar but recently worse than champion.
    const g = new PromotionGate({ minSamples: 10, recentWindow: 20, qualityRegressionEps: 0.02, seFloor: 0.01 });
    feed(g, 15, { championQuality: 0.80, championCost: 2, challengerQuality: 0.85, challengerCost: 1 });
    assert.equal(g.evaluate().promote, true);
    // recent: challenger 0.72 vs champion 0.79 → −0.07 regression (still above the 0.7 bar).
    feed(g, 20, { championQuality: 0.79, championCost: 1, challengerQuality: 0.72, challengerCost: 1 });
    assert.equal(g.checkRollback().rollback, true);
  });

  test("should_NOT_rollback_when_stillWinning", () => {
    const g = new PromotionGate({ minSamples: 10, recentWindow: 20 });
    feed(g, 25, { championQuality: 0.80, championCost: 2, challengerQuality: 0.85, challengerCost: 1 });
    g.evaluate();
    assert.equal(g.checkRollback().rollback, false);
  });
});
