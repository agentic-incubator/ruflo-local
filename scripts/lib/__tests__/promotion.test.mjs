// promotion.test.mjs — the per-question learned router as a shadow challenger under an
// evidence-gated promotion. Proves: SHADOW-only (never serves, never throws into serving);
// replay reports quality + q/$ vs oracle; the gate does NOT promote on thin data, on a
// zero-variance hair, OR on a cheaper-but-WORSE (free) router; a sustained quality+efficiency
// win promotes; a regression (fast OR slow) auto-rolls-back. KRR trains + predicts fail-safe.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trainRouter, predict, hashEmbed, solveLinear, difficultyForClass, embedderDecision, resolveEmbedder } from "../train-router.mjs";
import { ShadowChallenger } from "../challenger.mjs";
import { PromotionGate, qPerDollar, meanCI, replay, verifyFrozenSet, frozenHash, pairedSignificance, heldOutRegression } from "../promotion-gate.mjs";
import { replayPromotion } from "../replay-promotion.mjs";

// ── Phase 8 fixtures: the frozen held-out set + id-matched challenger outcomes. ──
const frozenPath = fileURLToPath(new URL("../../../tests/promotion-eval-frozen-v1.json", import.meta.url));
const loadFrozen = () => JSON.parse(readFileSync(frozenPath, "utf8"));
const FROZEN = loadFrozen();
const clip = (x) => Math.max(0, Math.min(1, x));
// A GENUINE win: quality +0.04 AND human relevance +0.03 across every case, cheaper.
const winChallenger = FROZEN.cases.map((c) => ({ id: c.id, quality: clip(c.champion.quality + 0.04), cost: 1.0, humanRelevance: clip(c.champion.humanRelevance + 0.03) }));
// OVERFIT: auto-quality +0.05 but human relevance FLAT — the self-metric-up/human-flat signature.
const overfitChallenger = FROZEN.cases.map((c) => ({ id: c.id, quality: clip(c.champion.quality + 0.05), cost: 1.0, humanRelevance: c.champion.humanRelevance }));
// REGRESSION: challenger clearly worse on the frozen set.
const regressChallenger = FROZEN.cases.map((c) => ({ id: c.id, quality: clip(c.champion.quality - 0.10), cost: 1.0, humanRelevance: clip(c.champion.humanRelevance - 0.10) }));
// A win too small to be significant (a hair above champion).
const noiseChallenger = FROZEN.cases.map((c) => ({ id: c.id, quality: clip(c.champion.quality + 0.002), cost: 1.0, humanRelevance: clip(c.champion.humanRelevance + 0.002) }));
// A rolling-window feed that makes the F1-F3 gate promote, so held-out behavior is isolated.
const feedWin = (g) => { for (let i = 0; i < 40; i++) g.record({ championQuality: 0.80, championCost: 2.0, challengerQuality: 0.85, challengerCost: 1.0 }); };

const seedRows = [
  { prompt: "fix this null bug in python", task_class: "bugfix" },
  { prompt: "explain what a mutex protects against", task_class: "explain" },
  { prompt: "refactor this duplicated branch logic", task_class: "refactor" },
  { prompt: "prove this cross-file refactor preserves the invariant", task_class: "prove" },
];
// Tests pin the deterministic hashEmbed explicitly (the library default is now the real embedder).
const model = () => trainRouter({ rows: seedRows, embed: hashEmbed });
/** Feed the gate `n` identical paired outcomes. */
const feed = (gate, n, o) => { for (let i = 0; i < n; i++) gate.record(o); };

describe("train-router (KRR)", () => {
  test("should_solveLinearSystem", () => {
    const x = solveLinear([[2, 1], [1, 3]], [5, 10]); // x=1, y=3
    assert.ok(Math.abs(x[0] - 1) < 1e-9 && Math.abs(x[1] - 3) < 1e-9);
  });
  test("should_produceCandidatesAndAlpha_ofTrainingSize", async () => {
    const m = await model();
    assert.equal(m.candidates.length, 3);
    assert.equal(m.alpha.length, seedRows.length);
  });
  test("should_mapHarderClassToHigherDifficulty", () => {
    assert.ok(difficultyForClass("prove") > difficultyForClass("explain"));
  });
  test("should_failSafeToCheapestTier_when_scoreIsNonFinite", async () => {
    // A corrupt model (NaN alpha) must NOT default to the most expensive off-box tier.
    const m = await model();
    m.alpha = m.alpha.map(() => NaN);
    assert.equal(predict(m, hashEmbed("anything", m.dim)).tier, "tier-fast");
  });
});

describe("embedderDecision — no-stub norm (ruflo 3.25.1)", () => {
  test("should_preferRealEmbedder_when_available", () => {
    assert.equal(embedderDecision({ ruvllmAvailable: true, requireReal: true }), "ruvllm");
  });
  test("should_degradeToHash_when_realAbsent_andNotRequired", () => {
    assert.equal(embedderDecision({ ruvllmAvailable: false, requireReal: false }), "hash");
  });
  test("should_throw_when_realRequired_butAbsent", () => {
    assert.throws(() => embedderDecision({ ruvllmAvailable: false, requireReal: true }), /REQUIRE_REAL_EMBEDDINGS/);
  });
  test("should_returnAWorkingEmbedder_from_resolveEmbedder", async () => {
    // ruvllm is installed here → resolveEmbedder yields a real async embedder (non-empty vector).
    const embed = resolveEmbedder({});
    const v = await embed("hello");
    assert.ok(Array.isArray(v) && v.length > 0);
  });
});

describe("trainRouter — async embedder path + data guard", () => {
  test("should_trainOverAnAsyncEmbedder", async () => {
    const m = await trainRouter({ rows: seedRows, embed: async (t, d) => hashEmbed(t, d) });
    assert.equal(m.alpha.length, seedRows.length);
    assert.ok(m.dim > 0);
  });
  test("should_throw_when_embeddingIsEmpty_ratherThanWriteNaNModel", async () => {
    await assert.rejects(() => trainRouter({ rows: seedRows, embed: () => [] }), /non-empty|equal-length|finite/);
  });
  test("should_throw_when_embeddingsAreMixedLength", async () => {
    let i = 0;
    await assert.rejects(() => trainRouter({ rows: seedRows, embed: () => (i++ % 2 ? [1, 2] : [1, 2, 3]) }), /equal-length|finite|non-empty/);
  });
});

describe("ShadowChallenger — shadow only, never serves, never throws", () => {
  test("should_returnChampionTier_regardlessOfShadowPick", async () => {
    const c = new ShadowChallenger(await model(), hashEmbed);
    assert.equal(c.observe({ prompt: "prove this hard thing", championTier: "tier-fast" }), "tier-fast");
    assert.equal(c.records[0].served, "tier-fast");
  });
  test("should_notThrowIntoServing_when_predictFails", async () => {
    // A broken embedder makes predict throw; observe must still return the champion tier.
    const c = new ShadowChallenger(await model(), () => undefined);
    assert.equal(c.observe({ prompt: "x", championTier: "tier-heavy" }), "tier-heavy");
  });
  test("should_neverScorePrivateOffBox_when_pinnedPrivate", async () => {
    let embedCalled = false;
    const c = new ShadowChallenger(await model(), (t, d) => { embedCalled = true; return hashEmbed(t, d); });
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

describe("Phase 8 — frozen held-out set (tamper-evident)", () => {
  test("should_verifyTheCommittedFrozenSet", () => {
    assert.equal(verifyFrozenSet(loadFrozen()), true);
  });
  test("should_haveAStableCanonicalHash_independentOfKeyOrder", () => {
    const a = frozenHash(FROZEN.cases);
    const reordered = FROZEN.cases.map((c) => ({ champion: c.champion, task_class: c.task_class, prompt_hash: c.prompt_hash, id: c.id }));
    assert.equal(frozenHash(reordered), a); // key order must not change the pin
  });
  test("should_throw_when_aFrozenCaseIsTampered", () => {
    const s = loadFrozen();
    s.cases[0].champion.quality = 0.01; // edit the yardstick to fake a challenger "win"
    assert.throws(() => verifyFrozenSet(s), /tamper check FAILED/);
  });
  test("should_throw_when_frozenSetMalformed", () => {
    assert.throws(() => verifyFrozenSet({ _meta: { sha256: "x" } }), /malformed/);
  });
});

describe("Phase 8 — significance test", () => {
  test("should_flagAClearPairedWinAsSignificant", () => {
    assert.equal(pairedSignificance(Array(12).fill(0.04), { seFloor: 0.01 }).significant, true);
  });
  test("should_notFlagAHairAboveZeroAsSignificant", () => {
    assert.equal(pairedSignificance(Array(12).fill(0.002), { seFloor: 0.01 }).significant, false);
  });
  test("should_notFlagANegativeMeanAsSignificant", () => {
    assert.equal(pairedSignificance(Array(12).fill(-0.05), { seFloor: 0.01 }).significant, false);
  });
});

describe("Phase 8 — held-out regression + overfitting guard", () => {
  test("should_reportAGenuineWin_asSignificant_notRegressed_notOverfit", () => {
    const h = heldOutRegression({ frozen: loadFrozen(), challenger: winChallenger });
    assert.equal(h.significant, true);
    assert.equal(h.regressed, false);
    assert.equal(h.overfit, false);
  });
  test("should_flagOverfit_when_autoQualityUpButHumanRelevanceFlat", () => {
    const h = heldOutRegression({ frozen: loadFrozen(), challenger: overfitChallenger });
    assert.equal(h.overfit, true);
    assert.ok(h.meanQDiff > 0 && h.meanHumanDiff < 0.01);
  });
  test("should_flagRegression_when_challengerWorseOnFrozenSet", () => {
    const h = heldOutRegression({ frozen: loadFrozen(), challenger: regressChallenger });
    assert.equal(h.regressed, true);
  });
});

describe("Phase 8 — evaluateWithHeldOut composes F1-F3 with the frozen gate", () => {
  test("should_promote_when_rollingAndFrozenBothPass", () => {
    const g = new PromotionGate({ minSamples: 20 });
    feedWin(g);
    const d = g.evaluateWithHeldOut({ frozen: loadFrozen(), challengerHeldOut: winChallenger });
    assert.equal(d.promote, true);
    assert.equal(g.promoted, true);
  });
  test("should_BLOCK_andVetoPromotedFlag_onOverfit", () => {
    const g = new PromotionGate({ minSamples: 20 });
    feedWin(g); // rolling gate WOULD promote; the overfit guard must veto it
    const d = g.evaluateWithHeldOut({ frozen: loadFrozen(), challengerHeldOut: overfitChallenger });
    assert.equal(d.promote, false);
    assert.equal(d.heldOut.overfit, true);
    assert.match(d.reason, /OVERFIT/);
    assert.equal(g.promoted, false); // the held-out block undoes evaluate()'s side effect
  });
  test("should_BLOCK_onFrozenHeldOutRegression", () => {
    const g = new PromotionGate({ minSamples: 20 });
    feedWin(g);
    const d = g.evaluateWithHeldOut({ frozen: loadFrozen(), challengerHeldOut: regressChallenger });
    assert.equal(d.promote, false);
    assert.match(d.reason, /regression/);
  });
  test("should_BLOCK_when_heldOutWinNotSignificant", () => {
    const g = new PromotionGate({ minSamples: 20 });
    feedWin(g);
    const d = g.evaluateWithHeldOut({ frozen: loadFrozen(), challengerHeldOut: noiseChallenger });
    assert.equal(d.promote, false);
    assert.match(d.reason, /significant/);
  });
});

describe("Phase 8 — clean-room receipt replay (offline, no trusting our logs)", () => {
  const genuineReceipt = () => ({
    gate_config: { minSamples: 20 },
    rolling_samples: Array.from({ length: 40 }, () => ({ championQuality: 0.80, championCost: 2.0, challengerQuality: 0.85, challengerCost: 1.0 })),
    held_out: winChallenger,
    frozen_sha256: FROZEN._meta.sha256,
    result: { promote: true },
  });

  test("should_replayAGenuinePromotion_offline_withFetchTrapped", () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("network access during replay is forbidden"); };
    try {
      const out = replayPromotion({ receipt: genuineReceipt(), frozen: loadFrozen() });
      assert.equal(out.accepted, true);
      assert.equal(out.recomputed.promote, true);
      assert.deepEqual(out.mismatches, []);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("should_rejectAReceipt_whose_frozenHash_isWrong", () => {
    const r = genuineReceipt();
    r.frozen_sha256 = "deadbeef";
    const out = replayPromotion({ receipt: r, frozen: loadFrozen() });
    assert.equal(out.accepted, false);
    assert.match(out.mismatches.join(";"), /frozen hash mismatch/);
  });

  test("should_rejectADoctoredReceipt_thatClaimsPromoteButRecomputesNo", () => {
    const r = genuineReceipt();
    r.held_out = regressChallenger; // the REAL decision on these inputs is NO...
    // ...but result still lies "promote: true". Replay recomputes and catches the mismatch.
    const out = replayPromotion({ receipt: r, frozen: loadFrozen() });
    assert.equal(out.accepted, false);
    assert.match(out.mismatches.join(";"), /decision mismatch/);
  });
});

describe("Phase 8 — hardening from adversarial review", () => {
  // Finding 1 (HIGH): reporting only a winning SUBSET of the frozen set must not promote.
  test("should_BLOCK_when_challengerCoversOnlyASubsetOfTheFrozenSet", () => {
    const g = new PromotionGate({ minSamples: 20 });
    feedWin(g);
    const d = g.evaluateWithHeldOut({ frozen: loadFrozen(), challengerHeldOut: winChallenger.slice(0, 1) });
    assert.equal(d.promote, false);
    assert.match(d.reason, /coverage/);
    assert.equal(g.promoted, false);
  });

  // Finding 2 (HIGH): a tampered yardstick must THROW and fail closed — never leave promoted=true.
  test("should_failClosed_flippingPromotedBackToFalse_when_frozenSetTamperedThrows", () => {
    const g = new PromotionGate({ minSamples: 20 });
    feedWin(g);
    assert.equal(g.evaluateWithHeldOut({ frozen: loadFrozen(), challengerHeldOut: winChallenger }).promote, true);
    assert.equal(g.promoted, true); // legitimately promoted
    const tampered = loadFrozen();
    tampered.cases[0].champion.quality = 0.01; // hash no longer matches
    assert.throws(() => g.evaluateWithHeldOut({ frozen: tampered, challengerHeldOut: winChallenger }), /tamper check FAILED/);
    assert.equal(g.promoted, false); // the throw vetoed the prior promotion
  });

  // Finding 3 (MEDIUM): the old blind band — a small SIGNIFICANT auto-gain with flat human relevance.
  test("should_flagOverfit_inTheOldBlindBand_smallSignificantGain_flatHuman", () => {
    const g = new PromotionGate({ minSamples: 20 });
    feedWin(g);
    const band = FROZEN.cases.map((c) => ({ id: c.id, quality: clip(c.champion.quality + 0.02), cost: 1.0, humanRelevance: c.champion.humanRelevance }));
    const d = g.evaluateWithHeldOut({ frozen: loadFrozen(), challengerHeldOut: band });
    assert.equal(d.heldOut.overfit, true);
    assert.equal(d.promote, false);
  });

  // Finding 4 (MEDIUM): a self-consistent frozen set that is off the OUT-OF-BAND pin is rejected.
  test("should_rejectFrozenSet_selfConsistentButOffTheOutOfBandPin", () => {
    const forged = loadFrozen();
    forged.cases[0].champion.quality = 0.01;
    forged._meta.sha256 = frozenHash(forged.cases); // attacker recomputes → internally consistent
    const receipt = { gate_config: { minSamples: 20 }, rolling_samples: [], held_out: [], frozen_sha256: forged._meta.sha256, result: { promote: true } };
    assert.throws(() => replayPromotion({ receipt, frozen: forged }), /out-of-band pin/);
  });

  // Finding 5 (LOW): a receipt with no claimed result is not "accepted".
  test("should_notAccept_aReceiptWithNoClaimedResult", () => {
    const receipt = { gate_config: { minSamples: 20 }, rolling_samples: [], held_out: winChallenger, frozen_sha256: FROZEN._meta.sha256 };
    const out = replayPromotion({ receipt, frozen: loadFrozen() });
    assert.equal(out.accepted, false);
    assert.match(out.mismatches.join(";"), /no claimed result/);
  });
});
