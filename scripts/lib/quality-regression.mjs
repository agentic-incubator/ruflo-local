// =============================================================================
// quality-regression.mjs — gate model swaps on a fixed prompt corpus (limitations §3)
//
// In-process Node port of quality-regression.sh — SAME contract, no bash/jq/curl:
// runs tests/quality-prompts.jsonl through tier-fast and tier-frontier, scores each
// answer with the (noisy, rubric-anchored, swap-averaged) judge, and flags a
// REGRESSION when tier-fast scores materially below tier-frontier. Exits non-zero
// when the regression fraction exceeds the threshold — run it in CI after any model
// swap (see docs/guide/reference/observability.md → Quality-regression harness).
//
// KEY IMPROVEMENT over the bash port: scoring happens IN-PROCESS by importing the
// ported judge (verify-escalate.mjs) directly — no shelling out to
// verify-escalate.sh, no jq round-trip. Same client instance drives both the
// tier-fast/tier-frontier asks and the judge calls.
//
// Degrades gracefully: if the judge/frontier is unreachable every row is "skipped"
// and the harness exits 0 (nothing to certify), mirroring smoke-test's tier-frontier
// path.
//
// SECURITY: model answers are UNTRUSTED and are only ever handed to verifyEscalate()
// as the `answer` param, which encodes them as structured JSON (never interpolated
// into instructions or a shell) — see verify-escalate.mjs's own SECURITY note.
// =============================================================================

import { readFileSync } from "node:fs";
import { GatewayClient } from "./gateway-client.mjs";
import { verifyEscalate } from "./verify-escalate.mjs";
import { regressionConfig } from "./config.mjs";

const DEFAULT_CORPUS = "tests/quality-prompts.jsonl";

/** True when the frontier−fast score gap exceeds margin (a "regression"). */
export function isRegression(fastScore, frontierScore, margin) {
  return frontierScore - fastScore > margin;
}

/**
 * Run the fast-vs-frontier quality regression sweep and return the summary.
 * @param {{client?:GatewayClient, corpus?:string, threshold?:number, limit?:number,
 *           env?:object}} [opts]
 * @returns {Promise<{report:object, exitCode:number}>}
 */
export async function qualityRegression({ client, corpus, threshold, limit, env } = {}) {
  const gw = client ?? new GatewayClient({ env });
  const cfg = regressionConfig(env);
  const { fastModel, frontierModel, margin } = cfg;
  const th = threshold ?? cfg.threshold;
  const corpusPath = corpus ?? DEFAULT_CORPUS;
  const lim = limit ?? 0;

  let raw;
  try {
    raw = readFileSync(corpusPath, "utf8");
  } catch {
    throw new Error(`quality-regression: corpus not found: ${corpusPath}`);
  }

  let total = 0;
  let scored = 0;
  let skipped = 0;
  let regressions = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (lim > 0 && total >= lim) break;
    total++;

    // Degrade per-row like the bash `jq -r` did: a malformed JSONL line or a row
    // missing `prompt` is SKIPPED, not fatal — one bad line must not abort the sweep
    // (this is the "degrades gracefully" contract in the module header).
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      skipped++;
      process.stderr.write(`SKIP  ${"?".padEnd(20)} (unscored — malformed corpus line)\n`);
      continue;
    }
    // Coerce id to string (bash `jq -r` stringified every field; a numeric JSON id
    // must not throw on .padEnd below).
    const id = String(row.id ?? "?");
    const prompt = row.prompt;
    if (!prompt) {
      skipped++;
      process.stderr.write(`SKIP  ${id.padEnd(20)} (unscored — missing prompt)\n`);
      continue;
    }

    // Skip BEFORE scoring when a generation is empty — avoids firing the judge (4
    // calls) on a row we'd discard anyway (the degraded path this harness tolerates).
    const fastAns = await gw.chatContent({
      model: fastModel,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    const frontAns = await gw.chatContent({
      model: frontierModel,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    if (!fastAns || !frontAns) {
      skipped++;
      process.stderr.write(`SKIP  ${id.padEnd(20)} (unscored — model unavailable)\n`);
      continue;
    }

    const fastResult = await verifyEscalate({ prompt, answer: fastAns, client: gw, env });
    const frontResult = await verifyEscalate({ prompt, answer: frontAns, client: gw, env });
    const fastScore = fastResult.score;
    const frontScore = frontResult.score;
    if (fastScore === null || frontScore === null) {
      skipped++;
      process.stderr.write(`SKIP  ${id.padEnd(20)} (unscored — judge unavailable)\n`);
      continue;
    }

    scored++;
    if (isRegression(fastScore, frontScore, margin)) {
      regressions++;
      process.stderr.write(`REGR  ${id.padEnd(20)} fast=${fastScore} frontier=${frontScore}\n`);
    } else {
      process.stderr.write(`ok    ${id.padEnd(20)} fast=${fastScore} frontier=${frontScore}\n`);
    }
  }

  const frac = scored > 0 ? Number((regressions / scored).toFixed(4)) : 0;
  const pass = frac <= th;
  const report = {
    total,
    scored,
    skipped,
    regressions,
    regression_fraction: frac,
    threshold: th,
    pass,
  };
  // Nothing scored (judge/frontier absent) → skip, don't fail CI. Otherwise fail on regression.
  const exitCode = scored === 0 ? 0 : pass ? 0 : 1;
  return { report, exitCode };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const USAGE = `quality-regression.mjs — gate model swaps on a fixed prompt corpus (§3)

  --corpus FILE    JSONL corpus, one {id,prompt,...} per line (default tests/quality-prompts.jsonl)
  --threshold F    max regressed fraction before non-zero exit (default 0.2)
  --limit N        only run the first N prompts (0 = all)
  --help           show this help

Exit: 0 if regression fraction <= threshold (or nothing could be scored); 1 otherwise.`;

export async function main(argv = process.argv.slice(2)) {
  let corpus;
  let threshold;
  let limit;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--corpus": corpus = argv[++i]; break;
      case "--threshold": threshold = Number(argv[++i]); break;
      case "--limit": limit = Number(argv[++i]); break;
      case "--help":
      case "-h": process.stdout.write(USAGE + "\n"); return 0;
      default:
        process.stderr.write(`quality-regression: unknown arg '${argv[i]}'\n${USAGE}\n`);
        return 2;
    }
  }

  let result;
  try {
    result = await qualityRegression({ corpus, threshold, limit });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  process.stdout.write(JSON.stringify(result.report, null, 2) + "\n");
  return result.exitCode;
}

// Run as a script (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
