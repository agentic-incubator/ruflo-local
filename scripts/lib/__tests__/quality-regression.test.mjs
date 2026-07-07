// =============================================================================
// quality-regression.test.mjs — node:test coverage for the quality-regression.mjs port.
//
// AAA (Arrange-Act-Assert). Network is never touched: qualityRegression() is
// exercised with an injected stub client, mirroring gateway-client's own test
// doubles. The judge (verify-escalate.mjs) is NOT mocked at the import level —
// instead the stub client's chatContent() plays both roles (ask + judge), telling
// them apart by whether the request carries a system message (judge calls always
// do, per verify-escalate's buildJudgeBody), which exercises the real in-process
// scoring path end-to-end without any network I/O.
// =============================================================================

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRegression, qualityRegression, main } from "../quality-regression.mjs";

/** Temp JSONL corpus, one object per line; returns the file path. Caller must clean up. */
function writeCorpus(rows) {
  const dir = mkdtempSync(join(tmpdir(), "quality-regression-test-"));
  const path = join(dir, "corpus.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, path };
}

/** A client whose chatContent() serves BOTH ask calls and judge calls deterministically. */
function makeScoringClient({ fastScore, frontierScore, fastAnswer = "fast-answer", frontierAnswer = "frontier-answer" }) {
  return {
    async chatContent(body) {
      const isJudgeCall = body.messages.some((m) => m.role === "system");
      if (isJudgeCall) {
        const userContent = body.messages.find((m) => m.role === "user").content;
        const score = userContent.includes(fastAnswer) ? fastScore : frontierScore;
        return JSON.stringify({ score });
      }
      return body.model === "tier-fast" ? fastAnswer : frontierAnswer;
    },
  };
}

describe("isRegression", () => {
  test("should_returnTrue_when_frontierFastGapExceedsMargin", () => {
    // Arrange
    const fastScore = 0.5;
    const frontierScore = 0.9;
    const margin = 0.2;

    // Act
    const result = isRegression(fastScore, frontierScore, margin);

    // Assert
    assert.equal(result, true);
  });

  test("should_returnFalse_when_frontierFastGapAtMargin", () => {
    // Arrange: 0.5 - 0.3 = 0.2 exactly (no floating-point remainder at this pair).
    const fastScore = 0.3;
    const frontierScore = 0.5;
    const margin = 0.2;

    // Act
    const result = isRegression(fastScore, frontierScore, margin);

    // Assert: gap is EQUAL to margin — bash used `(F - f) > m`, not `>=`.
    assert.equal(result, false);
  });

  test("should_returnFalse_when_frontierFastGapUnderMargin", () => {
    // Arrange
    const fastScore = 0.85;
    const frontierScore = 0.9;
    const margin = 0.2;

    // Act
    const result = isRegression(fastScore, frontierScore, margin);

    // Assert
    assert.equal(result, false);
  });
});

describe("qualityRegression", () => {
  test("should_skipEveryRow_when_clientReturnsEmptyContentForAllCalls", async () => {
    // Arrange
    const { dir, path } = writeCorpus([
      { id: "a", prompt: "p1" },
      { id: "b", prompt: "p2" },
    ]);
    const stub = { chatContent: async () => "" };

    try {
      // Act
      const { report, exitCode } = await qualityRegression({ client: stub, corpus: path });

      // Assert: no generation ever succeeds → every row skipped before the judge fires.
      assert.deepEqual(report, {
        total: 2,
        scored: 0,
        skipped: 2,
        regressions: 0,
        regression_fraction: 0,
        threshold: 0.2,
        pass: true,
      });
      assert.equal(exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("should_honorLimit_when_corpusHasMoreRowsThanLimit", async () => {
    // Arrange
    const { dir, path } = writeCorpus([
      { id: "a", prompt: "p1" },
      { id: "b", prompt: "p2" },
      { id: "c", prompt: "p3" },
    ]);
    const stub = { chatContent: async () => "" };

    try {
      // Act
      const { report } = await qualityRegression({ client: stub, corpus: path, limit: 1 });

      // Assert
      assert.equal(report.total, 1);
      assert.equal(report.skipped, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("should_flagRegression_when_frontierScoresMaterallyHigherThanFast", async () => {
    // Arrange
    const { dir, path } = writeCorpus([{ id: "reg-01", prompt: "p1" }]);
    const stub = makeScoringClient({ fastScore: 0.5, frontierScore: 0.9 });

    try {
      // Act
      const { report, exitCode } = await qualityRegression({ client: stub, corpus: path });

      // Assert: gap 0.4 > default margin 0.2 → regression; frac 1.0 > default threshold 0.2 → fail.
      assert.equal(report.total, 1);
      assert.equal(report.scored, 1);
      assert.equal(report.skipped, 0);
      assert.equal(report.regressions, 1);
      assert.equal(report.regression_fraction, 1);
      assert.equal(report.pass, false);
      assert.equal(exitCode, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("should_pass_when_frontierFastGapWithinMargin", async () => {
    // Arrange
    const { dir, path } = writeCorpus([{ id: "ok-01", prompt: "p1" }]);
    const stub = makeScoringClient({ fastScore: 0.85, frontierScore: 0.9 });

    try {
      // Act
      const { report, exitCode } = await qualityRegression({ client: stub, corpus: path });

      // Assert: gap 0.05 <= margin 0.2 → no regression; frac 0 <= threshold → pass.
      assert.equal(report.scored, 1);
      assert.equal(report.regressions, 0);
      assert.equal(report.pass, true);
      assert.equal(exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  test("should_returnExitCode2_when_corpusFileDoesNotExist", async () => {
    // Arrange
    const argv = ["--corpus", "/no/such/corpus.jsonl"];

    // Act
    const exitCode = await main(argv);

    // Assert
    assert.equal(exitCode, 2);
  });

  test("should_returnExitCode2_when_unknownArgGiven", async () => {
    // Arrange
    const argv = ["--bogus"];

    // Act
    const exitCode = await main(argv);

    // Assert
    assert.equal(exitCode, 2);
  });

  test("should_returnExitCode0_when_helpRequested", async () => {
    // Arrange
    const argv = ["--help"];

    // Act
    const exitCode = await main(argv);

    // Assert
    assert.equal(exitCode, 0);
  });
});

describe("qualityRegression graceful-degradation (per-row, never fatal)", () => {
  test("should_scoreRow_when_idIsNumeric", async () => {
    // Arrange: a numeric JSON id must not throw on the .padEnd log line (finding #1).
    const { dir, path } = writeCorpus([{ id: 1, prompt: "P" }]);
    const client = makeScoringClient({ fastScore: 0.9, frontierScore: 0.9 });

    // Act
    const { report, exitCode } = await qualityRegression({ client, corpus: path });

    // Assert
    assert.equal(report.total, 1);
    assert.equal(report.scored, 1);
    assert.equal(exitCode, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("should_skipMalformedLine_andContinue_when_corpusHasBadJson", async () => {
    // Arrange: a bad line between two good rows must not abort the sweep (finding #2).
    const dir = mkdtempSync(join(tmpdir(), "quality-regression-bad-"));
    const path = join(dir, "corpus.jsonl");
    writeFileSync(path, ['{"id":"a","prompt":"P1"}', "{not valid json", '{"id":"b","prompt":"P2"}'].join("\n") + "\n");
    const client = makeScoringClient({ fastScore: 0.9, frontierScore: 0.9 });

    // Act
    const { report } = await qualityRegression({ client, corpus: path });

    // Assert: 3 lines seen, the middle one skipped, the two valid rows scored.
    assert.equal(report.total, 3);
    assert.equal(report.scored, 2);
    assert.equal(report.skipped, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("should_skipRow_when_promptMissing", async () => {
    // Arrange: a row with no prompt is skipped, not sent to the gateway as undefined.
    const { dir, path } = writeCorpus([{ id: "x" }, { id: "y", prompt: "P" }]);
    const client = makeScoringClient({ fastScore: 0.9, frontierScore: 0.9 });

    // Act
    const { report } = await qualityRegression({ client, corpus: path });

    // Assert
    assert.equal(report.total, 2);
    assert.equal(report.skipped, 1);
    assert.equal(report.scored, 1);
    rmSync(dir, { recursive: true, force: true });
  });
});
