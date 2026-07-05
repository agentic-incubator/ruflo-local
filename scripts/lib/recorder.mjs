// =============================================================================
// recorder.mjs — log every routing decision as a DRACO row into a ruvector RVF corpus.
//
// D5 (no-backfill): from day one — while still routing per-category — every request's
// decision is recorded WITH the prompt embedding, so the per-question learner (phases
// 4–5) has real training data the moment its gate wants it, zero backfill.
//
// Storage is a REAL ruvector `.rvf` store via the @ruvector/rvf SDK (HNSW-indexed,
// crash-safe, single-writer) — NOT an ad-hoc JSON file. When the SDK is absent it
// degrades to a portable JSONL corpus (same DRACO rows). `kind` says which path is live.
//
// PRIVACY (two invariants):
//   1. Raw prompt text is NEVER stored — only a sha256 `prompt_hash` + the embedding.
//   2. Raw prompt text is NEVER logged off-process either. The default embedder runs
//      IN-PROCESS via @ruvector/ruvllm (no CLI, no argv — an argv would be visible in
//      `ps`/`/proc`/audit logs). If ruvllm isn't installed the default throws asking the
//      caller to inject an embedder — it never silently falls back to an argv-leaking path.
//
// DEDUP SEMANTICS (by design): the RVF id is the full prompt_hash, so the same prompt
// recorded twice updates in place (latest decision wins) — one point per unique prompt,
// which is exactly the granularity the per-question learner keys on. Two DIFFERENT
// prompts always get distinct ids (full 256-bit hash → no truncation collision) and grow
// the count. `count()` reports UNIQUE prompts on both backends so they stay interchangeable.
// =============================================================================

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { str } from "./config.mjs";

/** DRACO row fields recorded per decision (the embedding rides as the vector). */
export const DRACO_FIELDS = ["prompt_hash", "category", "tier", "judge_score", "cost", "latency", "escalated"];

/** sha256 hex of the prompt — the stored id, never the raw text. */
export function promptHash(prompt) {
  return createHash("sha256").update(String(prompt)).digest("hex");
}

/**
 * Validate a DRACO record: fields present AND well-typed, plus a non-empty numeric
 * embedding. Returns { ok, errors }.
 */
export function validateDracoRow(row) {
  const errors = [];
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  if (!/^[0-9a-f]{64}$/.test(String(row.prompt_hash ?? ""))) errors.push("prompt_hash must be a sha256 hex string");
  if (typeof row.category !== "string" || !row.category) errors.push("category must be a non-empty string");
  if (typeof row.tier !== "string" || !row.tier) errors.push("tier must be a non-empty string");
  if (!(isNum(row.judge_score) || row.judge_score === null)) errors.push("judge_score must be a number or null");
  if (!isNum(row.cost) || row.cost < 0) errors.push("cost must be a number >= 0");
  if (!isNum(row.latency) || row.latency < 0) errors.push("latency must be a number >= 0");
  if (typeof row.escalated !== "boolean") errors.push("escalated must be a boolean");
  if (!Array.isArray(row.embedding) || row.embedding.length === 0) errors.push("embedding must be a non-empty array");
  else if (!row.embedding.every(isNum)) errors.push("embedding must contain only finite numbers");
  return { ok: errors.length === 0, errors };
}

/**
 * In-process ruvllm embedder (recommended default) — pure, deterministic, offline, and
 * crucially NO argv/CLI (so a private prompt never appears in the process table). Loads
 * @ruvector/ruvllm lazily via createRequire (its ESM entry ships extensionless imports);
 * if it isn't installed, embed() throws a clear message rather than leaking via a CLI.
 */
/** Is the in-process ruvllm embedder installed? Resolves the module without loading it. */
export function isRuvllmAvailable() {
  try {
    createRequire(import.meta.url).resolve("@ruvector/ruvllm");
    return true;
  } catch {
    return false;
  }
}

export function ruvllmEmbedder() {
  let llm = null;
  return async function embed(text) {
    if (!llm) {
      let mod;
      try {
        mod = createRequire(import.meta.url)("@ruvector/ruvllm");
      } catch {
        throw new Error(
          "recorder: no embedder — install @ruvector/ruvllm for the in-process embedder, or inject `embed` into RoutingRecorder.open(). " +
            "The recorder never shells out to embed (a raw prompt on argv would leak to the process table)."
        );
      }
      const RuvLLM = mod.RuvLLM ?? mod.default?.RuvLLM ?? mod.default;
      llm = new RuvLLM();
    }
    const out = await llm.embed(String(text));
    return Array.isArray(out) ? out : out.embedding ?? out.vector ?? out.data;
  };
}

// ── Store backends (exported for direct testing) ─────────────────────────────

/** A real .rvf store via @ruvector/rvf. Throws if the SDK is genuinely absent (import fails). */
export async function rvfStore(path, dimension) {
  let RvfDatabase;
  try {
    ({ RvfDatabase } = await import("@ruvector/rvf"));
  } catch (err) {
    // ONLY an absent SDK is a fallback trigger; anything else is a real error to surface.
    const e = new Error("RVF_SDK_ABSENT");
    e.cause = err;
    throw e;
  }
  // Operational errors (locked/corrupt/permission) propagate — they must NOT silently
  // downgrade a healthy corpus to JSONL and split it (reviewer P2).
  const db = existsSync(path)
    ? await RvfDatabase.open(path)
    : await RvfDatabase.create(path, { dimensions: dimension, metric: "cosine" });
  return {
    kind: "rvf",
    path,
    async ingest(entry) { await db.ingestBatch([entry]); },
    async count() { return (await db.status()).totalVectors; },
    async close() { await db.close(); },
  };
}

/** Portable JSONL fallback. count() = UNIQUE prompt_hash, matching the RVF dedup-by-id semantics. */
export function jsonlStore(rvfPath) {
  const path = /\.rvf$/.test(rvfPath) ? rvfPath.replace(/\.rvf$/, ".jsonl") : `${rvfPath}.jsonl`;
  return {
    kind: "jsonl",
    path,
    async ingest(entry) { appendFileSync(path, JSON.stringify(entry) + "\n"); },
    async count() {
      if (!existsSync(path)) return 0;
      const ids = new Set();
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line) ids.add(JSON.parse(line).id);
      }
      return ids.size;
    },
    async close() {},
  };
}

/**
 * Open (or create) the routing corpus — real .rvf when @ruvector/rvf is installed, else
 * the portable JSONL fallback. The fallback fires ONLY on an absent SDK; an operational
 * RVF error propagates (never a silent mid-run split).
 */
export async function openCorpus({ corpusPath, dimension = 768, env = process.env } = {}) {
  const path = corpusPath ?? str("ROUTING_CORPUS", ".ruvector/routing-corpus.rvf", env);
  mkdirSync(dirname(path), { recursive: true });
  try {
    return await rvfStore(path, dimension);
  } catch (err) {
    if (err?.message === "RVF_SDK_ABSENT") return jsonlStore(path);
    throw err;
  }
}

/**
 * Records routing decisions into the corpus. Runs on EVERY request regardless of routing
 * grain — this is what makes per-category-first non-throwaway.
 */
export class RoutingRecorder {
  #store;
  #embed;
  #dimension;

  constructor(store, embed, dimension) {
    this.#store = store;
    this.#embed = embed;
    this.#dimension = dimension;
  }

  static async open({ corpusPath, dimension = 768, embed = ruvllmEmbedder(), env = process.env } = {}) {
    const store = await openCorpus({ corpusPath, dimension, env });
    return new RoutingRecorder(store, embed, dimension);
  }

  get kind() { return this.#store.kind; }
  get path() { return this.#store.path; }

  /**
   * Embed + record one decision. `decision` carries the raw prompt (embedded in-process,
   * never stored/logged) plus routing metadata. Returns the validated DRACO row.
   */
  async record(decision) {
    const { prompt, category, tier, judge_score, cost, latency, escalated } = decision;
    const embedding = await this.#embed(prompt);
    if (!Array.isArray(embedding) || embedding.length !== this.#dimension) {
      throw new Error(`recorder: embedding dim ${embedding?.length} != store dim ${this.#dimension} (set dimension to match your embedder)`);
    }
    const prompt_hash = promptHash(prompt);
    const row = { prompt_hash, embedding, category, tier, judge_score, cost, latency, escalated };

    const { ok, errors } = validateDracoRow(row);
    if (!ok) throw new Error(`recorder: invalid DRACO row — ${errors.join("; ")}`);

    const { embedding: _e, ...metadata } = row; // metadata carries prompt_hash, never the raw prompt
    // id = the FULL prompt_hash (no truncation → no birthday collision across distinct prompts).
    await this.#store.ingest({ id: prompt_hash, vector: embedding, metadata });
    return row;
  }

  count() { return this.#store.count(); }
  close() { return this.#store.close(); }
}
