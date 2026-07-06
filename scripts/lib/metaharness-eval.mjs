// =============================================================================
// metaharness-eval.mjs — OFFLINE head-to-head: @metaharness/router vs ruflo's router
// vs the per-question ORACLE, on a held-out split. Records an honest adopt/keep decision.
//
// D7 / phase 10. This is an OFFLINE comparator — NEVER a second live learner (running two
// learners at once blurs both their labels; see docs/research/metaharness-and-ruflo-local.md §5).
// If — and only if — metaharness wins on the held-out split by a real margin, adoption would
// DISABLE ruflo's learner; otherwise we keep ruflo. On a tiny seed corpus the two tie (the DRACO
// n≈20 ceiling), and "keep" is the correct, honest outcome.
//
// GROUNDED in real source (RuvNet brain):
//   * @metaharness/router (agent-harness-generator/packages/router) v0.3.2 — "cost-optimal model
//     router: route each query to the cheapest model that's good enough (k-NN over labelled
//     embeddings), the productized DRACO Phase-2 finding." API: Router.fromExamples(rows, prices,
//     {k,qualityBar}) → route(embedding) → {id, predictedQuality, costPerMTok, metBar}.
//   * The optional-dependency-with-local-fallback pattern mirrors open-claude-code
//     v2/src/optimize/router.mjs (dynamic import; never a hard runtime dep).
//
// GROUND TRUTH (honest caveat, surfaced in the report `meta.note`): with no live corpus yet, we
// seed from the labelled tests/quality-prompts.jsonl and derive a PRINCIPLED synthetic per-tier
// quality from difficultyForClass (harder task → local tiers score lower, frontier stays high).
// The report is explicit that this is a seed evaluation, not production telemetry.
// =============================================================================

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { difficultyForClass, trainRouter, predict, parseJsonl, resolveEmbedder, DEFAULT_CANDIDATES } from "./train-router.mjs";
import { isRuvllmAvailable } from "./recorder.mjs";
import { pairedSignificance, qPerDollar } from "./promotion-gate.mjs";

/** The eval cost ladder ($/1M tok, blended): a small local gradient so "cheapest adequate" is
 *  meaningful (fast < heavy ≪ frontier). Local tiers are ~free but not identical; frontier is metered. */
export const EVAL_PRICES = { "tier-fast": 0.05, "tier-heavy": 0.15, "tier-frontier": 45.0 };
/** Each tier's capability ceiling (difficulty it can still handle well) — derived from
 *  DEFAULT_CANDIDATES' own maxDifficulty, not a hand-copied literal, so a future tier-ladder
 *  tune in train-router.mjs can never silently desync the eval harness from the real router. */
export const TIER_CAPABILITY = Object.fromEntries(DEFAULT_CANDIDATES.map((c) => [c.tier, c.maxDifficulty]));
export const TIERS = Object.keys(EVAL_PRICES);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Synthetic-but-principled ground-truth quality of `tier` on a task of `difficulty`: a tier that
 * covers the difficulty scores ~1; beyond its ceiling quality drops steeply. Deterministic.
 */
export function groundTruthQuality(tier, difficulty) {
  const cap = TIER_CAPABILITY[tier] ?? 1;
  return clamp01(1 - 3 * Math.max(0, difficulty - cap));
}

/** Deterministic quality per tier for one labelled row (from its task_class difficulty). */
export function rowScores(taskClass) {
  const d = difficultyForClass(taskClass);
  const scores = {};
  for (const t of TIERS) scores[t] = groundTruthQuality(t, d);
  return { difficulty: d, scores };
}

/** Cost-floored quality-per-dollar (the DRACO efficiency signal). Local ≈ $0 → floored. */
export const qpd = (quality, tier) => qPerDollar(quality, EVAL_PRICES[tier], { freeCostFloor: 0.001 });

/**
 * Build the eval dataset: embed each labelled prompt (real embedder when present, hash fallback —
 * consistent with the rest of the kit) and attach its per-tier ground-truth scores.
 */
export async function buildDataset(rows, { embed, dim = 64 } = {}) {
  const embedder = embed ?? resolveEmbedder();
  return Promise.all(
    rows.map(async (r) => {
      const embedding = await embedder(r.prompt, dim);
      const { difficulty, scores } = rowScores(r.task_class);
      return { id: r.id, prompt: r.prompt, task_class: r.task_class, embedding, difficulty, scores };
    })
  );
}

/** Deterministic held-out split (every 3rd row → held-out) so the report is reproducible. */
export function splitTrainHeldout(dataset) {
  const train = [], heldout = [];
  dataset.forEach((row, i) => (i % 3 === 0 ? heldout : train).push(row));
  return { train, heldout };
}

/** cosine similarity. */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Build a metaharness cost-optimal picker. Uses the REAL @metaharness/router when installed
 * (Router.fromExamples → route), else a local k-NN fallback with identical semantics (cheapest
 * tier whose k-NN-predicted quality clears the bar, else best-predicted). Returns { pick, backend }.
 */
export async function buildMetaharnessPicker(train, { k = 5, qualityBar = 0.7 } = {}) {
  const rows = train.map((r) => ({ embedding: r.embedding, scores: r.scores }));
  // Local k-NN fallback — ALWAYS built, with the same DRACO semantics (cheapest tier whose k-NN-
  // predicted quality clears the bar, else best-predicted). Robust to k>train, empty train, and
  // zero-vector embeddings (cosine `|| 1`, `kk || 1`). Also backstops a misbehaving real package.
  const kk = Math.min(k, rows.length) || 1;
  const localPick = (embedding) => {
    const predByTier = {};
    for (const t of TIERS) {
      const sims = rows
        .map((r) => ({ w: (cosine(embedding, r.embedding) + 1) / 2, q: r.scores[t] }))
        .sort((a, b) => b.w - a.w)
        .slice(0, kk);
      const wsum = sims.reduce((s, x) => s + x.w, 0) || 1;
      predByTier[t] = sims.reduce((s, x) => s + x.w * x.q, 0) / wsum;
    }
    const cleared = TIERS.filter((t) => predByTier[t] >= qualityBar).sort((a, b) => EVAL_PRICES[a] - EVAL_PRICES[b]);
    return cleared.length ? cleared[0] : TIERS.slice().sort((a, b) => predByTier[b] - predByTier[a])[0];
  };
  try {
    const mod = await import("@metaharness/router");
    if (mod?.Router?.fromExamples) {
      const router = mod.Router.fromExamples(rows, EVAL_PRICES, { k, qualityBar });
      // DEFENSIVE: a present package whose route() throws or returns no valid id must NOT crash the
      // whole eval (no report written) — fall back to the local k-NN pick for that query instead.
      const pick = (embedding) => {
        try {
          const r = router.route(embedding);
          return r && r.id && TIERS.includes(r.id) ? r.id : localPick(embedding);
        } catch {
          return localPick(embedding);
        }
      };
      return { pick, backend: "@metaharness/router" };
    }
  } catch {
    /* absent → local fallback (never a hard dependency) */
  }
  return { pick: localPick, backend: "local-fallback" };
}

/** Build the ruflo-side picker (train-router KRR → predict). */
export async function buildRufloPicker(train, { embed, dim = 64 } = {}) {
  // Feed train-router the same embeddings we built, so the head-to-head is apples-to-apples.
  const model = await trainRouter({ rows: train.map((r) => ({ prompt: r.prompt, task_class: r.task_class })), embed: embed ?? resolveEmbedder(), dim });
  return { pick: (embedding) => predict(model, embedding).tier };
}

/** Score a picker over the held-out set against ground truth. Returns aggregate + per-query qpd. */
export function scorePicker(pick, heldout) {
  const per = heldout.map((row) => {
    const tier = pick(row.embedding);
    const quality = row.scores[tier] ?? 0;
    return { id: row.id, tier, quality, cost: EVAL_PRICES[tier], qpd: qpd(quality, tier) };
  });
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    mean_quality: mean(per.map((p) => p.quality)),
    mean_cost: mean(per.map((p) => p.cost)),
    mean_qpd: mean(per.map((p) => p.qpd)),
    per,
  };
}

/**
 * The per-question ORACLE — the best ACHIEVABLE per query, computed independently per metric
 * (max quality and max q/$ can be different tiers), so it is a true upper bound for both.
 */
export function scoreOracle(heldout) {
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const bestQuality = heldout.map((row) => Math.max(...TIERS.map((t) => row.scores[t])));
  const bestQpd = heldout.map((row) => Math.max(...TIERS.map((t) => qpd(row.scores[t], t))));
  const bestQualityCost = heldout.map((row) => {
    const t = TIERS.slice().sort((a, b) => row.scores[b] - row.scores[a])[0];
    return EVAL_PRICES[t];
  });
  return { mean_quality: mean(bestQuality), mean_cost: mean(bestQualityCost), mean_qpd: mean(bestQpd), per: [] };
}

/**
 * Adopt/keep decision. A statistical win (metaharness q/$ beats ruflo by a significant margin with
 * no quality regression) is necessary but NOT sufficient: adoption ALSO requires SUFFICIENT and
 * REAL evidence. We NEVER adopt — i.e. never disable ruflo's learner — on a thin or SYNTHETIC seed
 * corpus, even when the point estimate favors metaharness. This mirrors the promotion-gate discipline
 * and the phase's honest guardrail (DRACO n≈20 ceiling → a tie/insufficient-evidence outcome is the
 * correct one on a seed corpus). `meta_led` records the point-estimate win transparently.
 */
export function recommend(rufloScore, metaScore, { qualityRegressionEps = 0.02, seFloor = 0.01, alpha = 0.05, minHeldout = 30, syntheticGroundTruth = true } = {}) {
  const n = Math.min(rufloScore.per.length, metaScore.per.length);
  const diffs = Array.from({ length: n }, (_, i) => metaScore.per[i].qpd - rufloScore.per[i].qpd);
  const sig = pairedSignificance(diffs, { alpha, seFloor });
  const qualityOk = metaScore.mean_quality >= rufloScore.mean_quality - qualityRegressionEps;
  const metaLed = sig.significant && qualityOk;                 // point-estimate win
  const evidenceOk = n >= minHeldout && !syntheticGroundTruth;  // sufficient + real telemetry
  const adopt = metaLed && evidenceOk;
  let rationale;
  if (adopt) {
    rationale = `adopt: metaharness q/$ beats ruflo by a significant margin on sufficient REAL evidence (mean Δ ${sig.mean.toFixed(3)}, p=${sig.pValue.toFixed(3)}, n=${n}) with no quality regression — adoption DISABLES ruflo's learner to avoid two-brain label blur.`;
  } else if (metaLed) {
    const why = syntheticGroundTruth ? "SYNTHETIC (seed corpus, not production telemetry)" : `THIN (n_heldout=${n} < ${minHeldout})`;
    rationale = `keep: metaharness LED on held-out q/$ (mean Δ ${sig.mean.toFixed(3)}, p=${sig.pValue.toFixed(3)}) — the cost-optimal router correctly took cheaper adequate tiers — but the evidence is ${why}, so we do NOT disable ruflo's learner on this basis. Re-run against a materialized .ruvector corpus (past the DRACO n≈20 ceiling) to promote this to an adopt.`;
  } else {
    rationale = `keep: metaharness does not beat ruflo on held-out q/$ by a significant margin (mean Δ ${sig.mean.toFixed(3)}, p=${sig.pValue.toFixed(3)})${qualityOk ? "" : " and it regresses quality"} — a tie is expected on this seed corpus; do NOT run two live learners.`;
  }
  return { recommendation: adopt ? "adopt" : "keep", rationale, paired_qpd_delta: sig.mean, p_value: sig.pValue, significant: sig.significant, meta_led: metaLed };
}

/** Load labelled rows: the real .rvf corpus is not row-iterable via the recorder API, so seed from
 *  the labelled prompts (honest — surfaced as seed_source). */
export function loadRows({ corpusPath, seedPath = "tests/quality-prompts.jsonl" } = {}) {
  if (corpusPath && existsSync(corpusPath) && /\.jsonl$/.test(corpusPath)) {
    return { rows: parseJsonl(readFileSync(corpusPath, "utf8")), seed_source: corpusPath };
  }
  // .rvf corpora aren't row-iterable here; fall back to the labelled seed with a clear note.
  return { rows: parseJsonl(readFileSync(seedPath, "utf8")), seed_source: `${seedPath} (seed; ${corpusPath ?? "no"} corpus not row-iterable)` };
}

/** Run the full offline eval and return the report object. */
export async function runEval({ corpusPath, env = process.env } = {}) {
  const { rows, seed_source } = loadRows({ corpusPath });
  const embed = resolveEmbedder(env);
  const usedReal = isRuvllmAvailable(); // real in-process embedder present?
  const dataset = await buildDataset(rows, { embed });
  const { train, heldout } = splitTrainHeldout(dataset);

  const meta = await buildMetaharnessPicker(train);
  const ruflo = await buildRufloPicker(train, { embed });

  const rufloScore = scorePicker(ruflo.pick, heldout);
  const metaScore = scorePicker(meta.pick, heldout);
  const oracleScore = scoreOracle(heldout);

  const pct = (a, b) => (b > 0 ? Number((a / b).toFixed(3)) : null);
  const shape = (s) => ({
    mean_quality: Number(s.mean_quality.toFixed(4)),
    mean_cost: Number(s.mean_cost.toFixed(4)),
    mean_qpd: Number(s.mean_qpd.toFixed(4)),
    pct_oracle_quality: pct(s.mean_quality, oracleScore.mean_quality),
    pct_oracle_qpd: pct(s.mean_qpd, oracleScore.mean_qpd),
  });

  // The seed corpus's ground truth is synthetic (difficultyForClass), so adoption is gated OFF
  // regardless of the point estimate — an honest verdict, not a rigged one.
  const decision = recommend(rufloScore, metaScore, { syntheticGroundTruth: true });
  return {
    meta: {
      generated_for: "autopilot phase 10 (D7)",
      seed_source,
      n_total: dataset.length,
      n_train: train.length,
      n_heldout: heldout.length,
      metaharness_backend: meta.backend,
      embedder: usedReal ? "real in-process (@ruvector/ruvllm)" : "hash (ruvllm absent)",
      qualityBar: 0.7,
      eval_prices: EVAL_PRICES,
      note:
        "OFFLINE seed evaluation. Ground-truth per-tier quality is derived from difficultyForClass (synthetic-but-principled), NOT production telemetry — a tie on this tiny corpus is expected (DRACO n≈20 ceiling). STRUCTURAL TILT (disclosed): the synthetic ground-truth ceilings equal ruflo's own tier thresholds AND ruflo learns difficultyForClass (the same function generating the labels), so this offline setup is tilted TOWARD ruflo (near-oracle by construction). A 'keep' here is therefore weak evidence that metaharness is inferior — only that it does not clearly win. Re-run against a materialized .ruvector routing corpus (real telemetry) to remove this tilt and get a production-grade verdict.",
    },
    ruflo: shape(rufloScore),
    metaharness: shape(metaScore),
    oracle: { mean_quality: Number(oracleScore.mean_quality.toFixed(4)), mean_cost: Number(oracleScore.mean_cost.toFixed(4)), mean_qpd: Number(oracleScore.mean_qpd.toFixed(4)) },
    recommendation: decision.recommendation,
    rationale: decision.rationale,
    metaharness_led_on_point_estimate: decision.meta_led,
    paired_qpd_delta: Number(decision.paired_qpd_delta.toFixed(4)),
    p_value: Number(decision.p_value.toFixed(4)),
    significant: decision.significant,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const USAGE = `metaharness-eval.mjs — OFFLINE head-to-head: @metaharness/router vs ruflo vs oracle
  --corpus <path>   routing corpus (.rvf falls back to the labelled seed; .jsonl read directly)
  --out    <file>   write the JSON report here
  --help`;

export async function main(argv = process.argv.slice(2)) {
  let corpusPath, out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus") corpusPath = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") { process.stdout.write(USAGE + "\n"); return 0; }
    else { process.stderr.write(`metaharness-eval: unknown arg '${argv[i]}'\n`); return 2; }
  }
  if (!out) { process.stderr.write("metaharness-eval: --out is required\n"); return 2; }
  const report = await runEval({ corpusPath });
  const { writeFileSync } = await import("node:fs");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`metaharness-eval: ${report.recommendation.toUpperCase()} — ruflo q/$ ${report.ruflo.mean_qpd} vs metaharness ${report.metaharness.mean_qpd} (backend ${report.meta.metaharness_backend}, n_heldout=${report.meta.n_heldout}) → ${out}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c));
