// metaharness-eval.test.mjs — OFFLINE head-to-head harness. Proves: synthetic ground truth is
// principled (capable tier ~1, over-ceiling drops); the split is deterministic + disjoint; the
// oracle is a true upper bound; and — the load-bearing honesty guard — a point-estimate win for
// metaharness NEVER adopts on synthetic/thin evidence (only on sufficient REAL telemetry).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hashEmbed } from "../train-router.mjs";
import {
  groundTruthQuality,
  rowScores,
  splitTrainHeldout,
  buildDataset,
  scorePicker,
  scoreOracle,
  recommend,
  buildMetaharnessPicker,
  runEval,
  TIERS,
  EVAL_PRICES,
} from "../metaharness-eval.mjs";

const mkScore = (qpds, quality = 1) => ({ mean_quality: quality, mean_cost: 0, mean_qpd: qpds.reduce((a, b) => a + b, 0) / qpds.length, per: qpds.map((q) => ({ qpd: q })) });

describe("ground truth (synthetic-but-principled)", () => {
  test("should_scoreCapableTierHigh_andOverCeilingLow", () => {
    assert.equal(groundTruthQuality("tier-fast", 0.2), 1);       // within ceiling
    assert.ok(groundTruthQuality("tier-fast", 0.9) < 0.2);       // way over ceiling → fails
    assert.equal(groundTruthQuality("tier-frontier", 0.95), 1);  // frontier covers everything
  });
  test("should_giveHarderClassLowerLocalQuality", () => {
    const easy = rowScores("explain").scores["tier-fast"];
    const hard = rowScores("prove").scores["tier-fast"];
    assert.ok(hard < easy);
  });
});

describe("split (deterministic + disjoint + total)", () => {
  test("should_partitionEveryRowExactlyOnce", () => {
    const ds = Array.from({ length: 15 }, (_, i) => ({ id: i }));
    const { train, heldout } = splitTrainHeldout(ds);
    assert.equal(train.length + heldout.length, 15);
    const ids = new Set([...train, ...heldout].map((r) => r.id));
    assert.equal(ids.size, 15); // disjoint + complete
  });
});

describe("oracle is an upper bound", () => {
  test("should_beAtLeastAsGoodAsAnyPicker_onQualityAndQpd", async () => {
    const rows = [{ id: "a", prompt: "explain a mutex", task_class: "explain" }, { id: "b", prompt: "prove this invariant", task_class: "prove" }];
    const ds = await buildDataset(rows, { embed: (t, d) => hashEmbed(t, d) });
    const oracle = scoreOracle(ds);
    const alwaysFast = scorePicker(() => "tier-fast", ds);
    assert.ok(oracle.mean_quality >= alwaysFast.mean_quality);
    assert.ok(oracle.mean_qpd >= alwaysFast.mean_qpd);
  });
});

describe("recommend — the honesty guard", () => {
  test("should_NOT_adopt_onSyntheticGroundTruth_evenWhenMetaLeads", () => {
    const ruflo = mkScore(Array(40).fill(6));
    const meta = mkScore(Array(40).fill(14)); // strong, consistent lead
    const d = recommend(ruflo, meta, { syntheticGroundTruth: true });
    assert.equal(d.recommendation, "keep");
    assert.equal(d.meta_led, true); // transparent: the point estimate DID favor metaharness
  });
  test("should_NOT_adopt_onThinRealEvidence_belowMinHeldout", () => {
    const ruflo = mkScore(Array(5).fill(6));
    const meta = mkScore(Array(5).fill(14));
    const d = recommend(ruflo, meta, { syntheticGroundTruth: false, minHeldout: 30 });
    assert.equal(d.recommendation, "keep");
  });
  test("should_adopt_onlyOnSufficientRealEvidence", () => {
    const ruflo = mkScore(Array(40).fill(6));
    const meta = mkScore(Array(40).fill(14));
    const d = recommend(ruflo, meta, { syntheticGroundTruth: false, minHeldout: 30 });
    assert.equal(d.recommendation, "adopt");
  });
  test("should_keep_onATie", () => {
    const same = mkScore(Array(40).fill(9));
    const d = recommend(same, same, { syntheticGroundTruth: false, minHeldout: 30 });
    assert.equal(d.recommendation, "keep");
    assert.equal(d.meta_led, false);
  });
});

describe("metaharness picker (real package or local fallback)", () => {
  test("should_pickAValidTier_preferringCheaperAdequate", async () => {
    const rows = [
      { id: "e1", prompt: "explain a mutex", task_class: "explain" },
      { id: "e2", prompt: "add a comment to this function", task_class: "explain" },
      { id: "p1", prompt: "prove this cross-file refactor is safe", task_class: "prove" },
    ];
    const ds = await buildDataset(rows, { embed: (t, d) => hashEmbed(t, d) });
    const { pick, backend } = await buildMetaharnessPicker(ds, { k: 2, qualityBar: 0.7 });
    for (const row of ds) assert.ok(TIERS.includes(pick(row.embedding)));
    assert.ok(typeof backend === "string" && backend.length > 0);
  });
});

describe("runEval — end-to-end on the seed corpus", () => {
  test("should_produceThreeWayReport_andKeepOnSyntheticSeed", async () => {
    const report = await runEval({});
    assert.ok(report.ruflo && report.metaharness && report.oracle); // DoD shape
    assert.equal(report.recommendation, "keep");                      // honest verdict on synthetic seed
    assert.ok(report.oracle.mean_qpd >= report.metaharness.mean_qpd - 1e-9); // oracle bounds both
    assert.ok(report.oracle.mean_qpd >= report.ruflo.mean_qpd - 1e-9);
  });
});
