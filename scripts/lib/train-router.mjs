// =============================================================================
// train-router.mjs — train a KRR (kernel-ridge regression) TrainedRouter on the routing
// corpus, seeded from tests/quality-prompts.jsonl → a PORTABLE JSON model (no model files).
//
// This is the pure-TS TrainedRouter shape from @metaharness/router (ruvnet ADR-073): a
// regularised kernel-ridge model over prompt embeddings that predicts a difficulty score,
// mapped to the cheapest tier candidate predicted to clear the quality bar. The model is
// self-contained JSON: { kernel, gamma, lambda, dim, qualityBar, candidates, support, alpha }.
//
// HONEST COLD-START: the seed corpus is tiny (n≈15) and carries task_class, not per-tier
// quality labels — so the target is a task-class difficulty prior, and the model is a
// cold-start challenger. On this little data it will TIE, not beat, the per-category
// champion (ADR-201 H5: learned difficulty-routing is at chance on a small corpus) — which
// is exactly why the promotion gate won't promote it. That is correct, not a failure.
//
// The embedder is a deterministic feature-hash (no native deps → the CLI runs anywhere and
// is reproducible). Pass a real embedder (ruvllm) via {embed} for a stronger model.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { str } from "./config.mjs";
import { ruvllmEmbedder, isRuvllmAvailable } from "./recorder.mjs";

/** Deterministic 64-dim feature-hash embedding — reproducible, no native deps. */
export function hashEmbed(text, dim = 64) {
  const v = new Array(dim).fill(0);
  const toks = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const t of toks) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    const bucket = Math.abs(h) % dim;
    const sign = (h & 1) === 0 ? 1 : -1;
    v[bucket] += sign;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Task-class difficulty prior in [0,1] → maps to the cheapest adequate tier. */
export function difficultyForClass(taskClass = "") {
  const c = String(taskClass).toLowerCase();
  if (/prove|derive|design|architect/.test(c)) return 0.9;
  if (/refactor|multi|orchestr/.test(c)) return 0.6;
  if (/bug|fix|test/.test(c)) return 0.35;
  if (/explain|doc|summar/.test(c)) return 0.2;
  return 0.4;
}

const rbf = (a, b, gamma) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.exp(-gamma * s);
};

/** Solve A x = b (Gaussian elimination, partial pivoting). Small n only. */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (M[i][i] || 1e-9));
}

/** Train KRR dual weights: alpha = (K + λI)^-1 y over the support embeddings. */
export function trainKRR(support, y, { gamma, lambda }) {
  const n = support.length;
  const K = support.map((xi) => support.map((xj) => rbf(xi, xj, gamma)));
  for (let i = 0; i < n; i++) K[i][i] += lambda;
  return solveLinear(K, y);
}

export const DEFAULT_CANDIDATES = [
  { tier: "tier-fast", costPerMTok: 0.0, maxDifficulty: 0.4 },
  { tier: "tier-heavy", costPerMTok: 0.0, maxDifficulty: 0.75 },
  { tier: "tier-frontier", costPerMTok: 45.0, maxDifficulty: 1.0 },
];

/** Build the portable TrainedRouter model from a seed corpus. */
export async function trainRouter({ rows, embed, candidates = DEFAULT_CANDIDATES, dim = 64, gamma, lambda = 0.1, qualityBar = 0.7, env = process.env } = {}) {
  // No-stub at the LIBRARY boundary: the DEFAULT embedder is the real-embedder resolver
  // (which honors RUFLO_REQUIRE_REAL_EMBEDDINGS), not a silent hash. Tests pass hashEmbed
  // explicitly for determinism. embed may be async — await it and derive the true dim.
  const embedder = embed ?? resolveEmbedder(env);
  const support = await Promise.all(rows.map((r) => embedder(r.prompt, dim)));
  // Guard the training data: empty/mixed-length/non-finite embeddings would NaN the KRR
  // (dim=0 → gamma=Infinity → NaN alpha) and silently write a garbage model to disk.
  const actualDim = support[0]?.length ?? 0;
  if (rows.length && (actualDim === 0 || support.some((v) => !Array.isArray(v) || v.length !== actualDim || !v.every(Number.isFinite)))) {
    throw new Error("train-router: embeddings must be non-empty, equal-length, finite vectors");
  }
  const y = rows.map((r) => difficultyForClass(r.task_class));
  const g = gamma ?? 1 / actualDim;
  const alpha = rows.length ? trainKRR(support, y, { gamma: g, lambda }) : [];
  return { kernel: "rbf", gamma: g, lambda, dim: actualDim, qualityBar, candidates, support, alpha, meta: { n: rows.length, seededAt: "train-router" } };
}

/**
 * No-stub embedder policy (ruflo 3.25.1 norm): a real in-process embedder is the DEFAULT;
 * a hash fallback is a silent last resort ONLY when a real one is unavailable AND the caller
 * hasn't demanded real embeddings. Pure so it's unit-testable without toggling native deps.
 * @returns {"ruvllm"|"hash"} · throws when requireReal and no real embedder is available.
 */
export function embedderDecision({ ruvllmAvailable, requireReal }) {
  if (ruvllmAvailable) return "ruvllm";
  if (requireReal) {
    throw new Error(
      "train-router: RUFLO_REQUIRE_REAL_EMBEDDINGS=1 but no real embedder is available — " +
        "install @ruvector/ruvllm or inject an embedder; refusing to train on semantically-meaningless hash vectors."
    );
  }
  return "hash";
}

/**
 * Resolve the runtime-DEFAULT embedder: real in-process ruvllm when present, else hashEmbed —
 * unless RUFLO_REQUIRE_REAL_EMBEDDINGS=1, in which case the hash last-resort THROWS.
 */
export function resolveEmbedder(env = process.env) {
  const requireReal = str("RUFLO_REQUIRE_REAL_EMBEDDINGS", "", env) === "1";
  // Decide ONCE, up front, on module PRESENCE — not per-call in a catch. This throws now
  // (requireReal && absent) rather than mid-training, and crucially it does NOT swallow a
  // RUNTIME embed failure into a silent hash downgrade (mirrors recorder's absent-vs-operational
  // split): when ruvllm is present, its runtime errors propagate.
  const mode = embedderDecision({ ruvllmAvailable: isRuvllmAvailable(), requireReal });
  if (mode === "ruvllm") {
    const ruv = ruvllmEmbedder();
    return (text) => ruv(text);
  }
  return async (text, dim) => hashEmbed(text, dim ?? 64);
}

/** Predict difficulty for a new embedding, then the cheapest candidate that covers it. */
export function predict(model, embedding) {
  let difficulty = 0;
  for (let i = 0; i < model.support.length; i++) difficulty += model.alpha[i] * rbf(embedding, model.support[i], model.gamma);
  // Fail SAFE: a non-finite score (corrupt model / NaN alpha) must NOT default to the most
  // expensive off-box tier — clamp to 0 so it maps to the cheapest local candidate.
  difficulty = Number.isFinite(difficulty) ? Math.max(0, Math.min(1, difficulty)) : 0;
  const cand = model.candidates.find((c) => difficulty <= c.maxDifficulty) ?? model.candidates[0];
  return { difficulty, tier: cand.tier };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const USAGE = `train-router.mjs — train a KRR TrainedRouter → portable JSON
  --seed <file.jsonl>   seed corpus ({prompt, task_class} per line)
  --out  <file.json>    output model path
  --help`;

export function parseJsonl(text) {
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export async function main(argv = process.argv.slice(2)) {
  let seed, out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") seed = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") { process.stdout.write(USAGE + "\n"); return 0; }
    else { process.stderr.write(`train-router: unknown arg '${argv[i]}'\n`); return 2; }
  }
  if (!seed || !out) { process.stderr.write("train-router: --seed and --out are required\n"); return 2; }
  const rows = parseJsonl(readFileSync(seed, "utf8"));
  // trainRouter's default embedder is now the real-embedder resolver (no-stub); it
  // degrades to hash or throws per RUFLO_REQUIRE_REAL_EMBEDDINGS.
  const model = await trainRouter({ rows });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(model, null, 2));
  process.stdout.write(`train-router: trained on ${rows.length} rows → ${out} (candidates=${model.candidates.length}, alpha=${model.alpha.length})\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c));
