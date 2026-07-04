// recorder.test.mjs — DRACO routing-corpus recorder. Proves: rows validate (present +
// well-typed); recording two DISTINCT requests grows the REAL .rvf count 1→2 and persists
// across a reopen; the raw prompt never lands on disk (read the .rvf bytes back and grep);
// the JSONL fallback backend works and dedups consistently with RVF; dim mismatch is
// caught. The embedder is a deterministic fake (distinct small vector per prompt) so no
// native model is touched.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promptHash,
  validateDracoRow,
  RoutingRecorder,
  jsonlStore,
  DRACO_FIELDS,
} from "../recorder.mjs";

let RVF_OK = false;
try { await import("@ruvector/rvf"); RVF_OK = true; } catch { RVF_OK = false; }

const DIM = 8;
/** Deterministic distinct DIM-dim vector per text (from hash bytes). */
function fakeEmbed(text) {
  const h = promptHash(text);
  return Array.from({ length: DIM }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255 + 0.001);
}
const decision = (prompt, over = {}) => ({
  prompt, category: "code", tier: "tier-fast", judge_score: 0.8, cost: 0, latency: 5.1, escalated: false, ...over,
});

describe("validateDracoRow (present + well-typed)", () => {
  const good = { prompt_hash: promptHash("p"), embedding: [0.1], category: "code", tier: "tier-fast", judge_score: 0.5, cost: 0, latency: 1, escalated: false };
  test("should_accept_when_allFieldsWellTyped", () => {
    assert.equal(validateDracoRow(good).ok, true);
  });
  test("should_reject_when_typesWrong_orEmbeddingEmpty", () => {
    assert.equal(validateDracoRow({ ...good, embedding: [] }).ok, false);      // empty embedding
    assert.equal(validateDracoRow({ ...good, judge_score: "high" }).ok, false); // wrong type
    assert.equal(validateDracoRow({ ...good, escalated: "yes" }).ok, false);    // not boolean
    assert.equal(validateDracoRow({ ...good, cost: -5 }).ok, false);            // negative
    assert.equal(validateDracoRow({ ...good, latency: NaN }).ok, false);        // NaN
    assert.equal(validateDracoRow({ ...good, prompt_hash: "nothex" }).ok, false); // bad hash
  });
  test("should_allow_nullJudgeScore", () => {
    assert.equal(validateDracoRow({ ...good, judge_score: null }).ok, true);
  });
});

describe("jsonlStore fallback backend", () => {
  test("should_growUniqueCount_when_ingestingDistinctIds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-"));
    const s = jsonlStore(join(dir, "c.rvf")); // derives c.jsonl
    assert.ok(s.path.endsWith(".jsonl"));
    await s.ingest({ id: "aa", vector: [1], metadata: {} });
    await s.ingest({ id: "bb", vector: [2], metadata: {} });
    assert.equal(await s.count(), 2);
    rmSync(dir, { recursive: true, force: true });
  });
  test("should_dedupById_matchingRvfSemantics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-dedup-"));
    const s = jsonlStore(join(dir, "c.rvf"));
    await s.ingest({ id: "same", vector: [1], metadata: {} });
    await s.ingest({ id: "same", vector: [2], metadata: {} });
    assert.equal(await s.count(), 1); // unique-prompt semantics, same as RVF dedup-by-id
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("RoutingRecorder — real .rvf store", { skip: RVF_OK ? false : "@ruvector/rvf not installed" }, () => {
  test("should_recordValidatedRowWithEmbedding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-schema-"));
    const rec = await RoutingRecorder.open({ corpusPath: join(dir, "c.rvf"), dimension: DIM, embed: fakeEmbed });
    const row = await rec.record(decision("how do I sort a list"));
    assert.equal(rec.kind, "rvf");
    assert.equal(validateDracoRow(row).ok, true);
    assert.equal(row.embedding.length, DIM);
    await rec.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("should_growVectorCount_1to2_when_recordingTwoDistinctRequests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-grow-"));
    const rec = await RoutingRecorder.open({ corpusPath: join(dir, "c.rvf"), dimension: DIM, embed: fakeEmbed });
    await rec.record(decision("how do I sort a list in python"));
    assert.equal(await rec.count(), 1);
    await rec.record(decision("what is the capital of France", { category: "geo" }));
    assert.equal(await rec.count(), 2); // REAL ruvector store — count grows
    await rec.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("should_persistCount_when_reopenedAfterRestart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-reopen-"));
    const path = join(dir, "c.rvf");
    const rec = await RoutingRecorder.open({ corpusPath: path, dimension: DIM, embed: fakeEmbed });
    await rec.record(decision("alpha prompt"));
    await rec.record(decision("beta prompt"));
    await rec.close();
    const reopened = await RoutingRecorder.open({ corpusPath: path, dimension: DIM, embed: fakeEmbed });
    assert.equal(await reopened.count(), 2);
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("should_keepRawPromptOffDisk_whenReadingCorpusBytesBack", async () => {
    // Privacy on-disk (not just row shape): the secret must not appear in any store byte.
    const dir = mkdtempSync(join(tmpdir(), "rec-priv-"));
    const secret = "my api key is sk-supersecret-abcdef123456";
    const rec = await RoutingRecorder.open({ corpusPath: join(dir, "c.rvf"), dimension: DIM, embed: fakeEmbed });
    const row = await rec.record(decision(secret));
    await rec.close();
    // Read every file the store wrote and assert the raw secret is absent.
    let bytes = "";
    for (const f of readdirSync(dir)) bytes += readFileSync(join(dir, f), "latin1");
    assert.equal(bytes.includes(secret), false, "raw prompt must never be written to the corpus");
    assert.equal(bytes.includes("sk-supersecret"), false);
    assert.equal(row.prompt_hash, promptHash(secret)); // only the hash represents it
    assert.ok(!DRACO_FIELDS.includes("prompt"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("should_throwClearError_when_embeddingDimMismatchesStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-dim-"));
    const rec = await RoutingRecorder.open({ corpusPath: join(dir, "c.rvf"), dimension: DIM, embed: () => [1, 2, 3] }); // 3 != 8
    await assert.rejects(() => rec.record(decision("x")), /embedding dim 3 != store dim 8/);
    await rec.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
