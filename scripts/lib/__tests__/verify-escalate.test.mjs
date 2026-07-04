// Tests for the FrugalGPT verify-then-escalate judge. Focus: the security + safety
// contract — injection rejection, fail-closed averaging, graceful skip, position swap.
// The gateway is mocked by injecting a client whose chatContent returns canned replies
// in call order (verifyEscalate calls answer_first, then rubric_first).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseScore,
  buildJudgeBody,
  verifyEscalate,
  main,
  RUBRIC,
} from "../verify-escalate.mjs";

/** Stub client: chatContent returns queued replies in order (default ""). */
function mkClient(replies = []) {
  const q = [...replies];
  return { chatContent: async () => (q.length ? q.shift() : "") };
}

test("parseScore accepts a strict in-range numeric score", () => {
  assert.equal(parseScore('{"score": 0.8}'), 0.8);
  assert.equal(parseScore('{"score": 0}'), 0);
  assert.equal(parseScore('{"score": 1}'), 1);
});

test("parseScore rejects an out-of-range injected score (fail-closed, not clamped)", () => {
  assert.equal(parseScore('{"score": 5}'), null);
  assert.equal(parseScore('{"score": -1}'), null);
});

test("parseScore rejects non-JSON and non-numeric scores", () => {
  assert.equal(parseScore("totally not json"), null);
  assert.equal(parseScore('{"score": "0.9"}'), null);
  assert.equal(parseScore("{}"), null);
  assert.equal(parseScore(""), null);
});

test("buildJudgeBody fences untrusted content and swaps order", () => {
  const nonce = "abc123";
  const first = buildJudgeBody({ prompt: "P", answer: "A", order: "answer_first", nonce, judgeModel: "m" });
  const second = buildJudgeBody({ prompt: "P", answer: "A", order: "rubric_first", nonce, judgeModel: "m" });
  const uf = first.messages[1].content;
  const us = second.messages[1].content;
  // Answer block appears before prompt block when answer_first, and after otherwise.
  assert.ok(uf.indexOf(`<<ANSWER_${nonce}>>`) < uf.indexOf(`<<PROMPT_${nonce}>>`));
  assert.ok(us.indexOf(`<<PROMPT_${nonce}>>`) < us.indexOf(`<<ANSWER_${nonce}>>`));
  // System message carries the rubric + strict-JSON instruction.
  assert.ok(first.messages[0].content.startsWith(RUBRIC.slice(0, 20)));
  assert.equal(first.temperature, 0);
  assert.equal(first.max_tokens, 20);
});

test("verifyEscalate accepts when swap-averaged score meets threshold", async () => {
  const client = mkClient(['{"score":0.9}', '{"score":0.7}']);
  const r = await verifyEscalate({ prompt: "P", answer: "A", client, threshold: 0.6 });
  assert.equal(r.decision, "accept");
  assert.equal(r.score, 0.8);
  assert.deepEqual(r.passes, [0.9, 0.7]);
});

test("verifyEscalate escalates when averaged score is below threshold", async () => {
  const client = mkClient(['{"score":0.3}', '{"score":0.4}']);
  const r = await verifyEscalate({ prompt: "P", answer: "A", client, threshold: 0.6 });
  assert.equal(r.decision, "escalate");
  assert.equal(r.score, 0.35);
});

test("a missing pass counts as 0.0 (fail-closed toward escalation)", async () => {
  // One valid high pass, one unparseable → (0.9 + 0)/2 = 0.45 < 0.6 → escalate.
  const client = mkClient(['{"score":0.9}', "garbled"]);
  const r = await verifyEscalate({ prompt: "P", answer: "A", client, threshold: 0.6 });
  assert.equal(r.score, 0.45);
  assert.equal(r.decision, "escalate");
  assert.deepEqual(r.passes, [0.9, null]);
});

test("an injected out-of-range score cannot buy acceptance", async () => {
  // Injection returns {"score":5} on both passes → both rejected → skipped, never accept.
  const client = mkClient(['{"score":5}', '{"score":5}']);
  const r = await verifyEscalate({ prompt: "P", answer: "A", client, threshold: 0.6 });
  assert.notEqual(r.decision, "accept");
  assert.equal(r.decision, "skipped");
});

test("both passes empty ⇒ graceful skip (judge unreachable)", async () => {
  const client = mkClient(["", ""]);
  const r = await verifyEscalate({ prompt: "P", answer: "A", client, threshold: 0.6 });
  assert.equal(r.decision, "skipped");
  assert.equal(r.score, null);
  assert.deepEqual(r.passes, []);
});

test("decision at exactly the threshold accepts (avg < th ? escalate : accept)", async () => {
  const client = mkClient(['{"score":0.6}', '{"score":0.6}']);
  const r = await verifyEscalate({ prompt: "P", answer: "A", client, threshold: 0.6 });
  assert.equal(r.score, 0.6);
  assert.equal(r.decision, "accept");
});

test("main --help prints usage and returns 0", async () => {
  const code = await main(["--help"]);
  assert.equal(code, 0);
});

test("main rejects an unknown arg with exit 2", async () => {
  const code = await main(["--bogus"]);
  assert.equal(code, 2);
});

test("main requires --prompt (exit 2)", async () => {
  const code = await main(["--answer", "A"]);
  assert.equal(code, 2);
});
