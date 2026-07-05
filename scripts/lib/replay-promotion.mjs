// =============================================================================
// replay-promotion.mjs — clean-room replay of a promotion decision from its RECEIPT alone.
//
// The acceptance check for a promotion is not "our logs say it passed" — it is "an independent
// party, given only the receipt + the frozen held-out file, recomputes the SAME decision."
// So this module:
//   1. is OFFLINE / network-trapped — it imports only promotion-gate.mjs + node:crypto and never
//      performs I/O; there is no fetch/child_process path to reach the network (a test pins this
//      by trapping globalThis.fetch to throw and asserting replay still succeeds);
//   2. verifies IDENTICAL HASHES — the frozen set's real sha256 must equal the hash the receipt
//      claims it evaluated against (tamper-evident against a swapped yardstick);
//   3. RECOMPUTES the decision from the receipt's inputs and compares it to the receipt's recorded
//      result WITHOUT trusting that result — a doctored receipt fails the replay.
// =============================================================================

import { PromotionGate, frozenHash, verifyFrozenSet, FROZEN_V1_SHA256 } from "./promotion-gate.mjs";

/**
 * Replay a promotion decision from its receipt.
 * @param {object} o
 * @param {object} o.receipt  { gate_config, rolling_samples, held_out, frozen_sha256, result }
 * @param {object} o.frozen   the parsed frozen held-out set the receipt names
 * @param {string} [o.expectedSha256]  out-of-band pin for the frozen set (defaults to the v1 code constant)
 * @returns {{accepted:boolean, recomputed:object, claimed:object|null, mismatches:string[], frozenHash:string}}
 */
export function replayPromotion({ receipt, frozen, expectedSha256 = FROZEN_V1_SHA256 }) {
  if (!receipt || typeof receipt !== "object") throw new Error("replayPromotion: receipt is required");
  // (1)+(2) tamper-evident: the frozen set must be self-consistent AND match the OUT-OF-BAND pin —
  // not merely its own `_meta.sha256`, which an attacker could edit-and-recompute.
  verifyFrozenSet(frozen, { expected: expectedSha256 });
  const actualFrozen = frozenHash(frozen.cases);
  const mismatches = [];
  if (receipt.frozen_sha256 !== actualFrozen) {
    mismatches.push(`frozen hash mismatch: receipt ${receipt.frozen_sha256 || "<none>"} != actual ${actualFrozen}`);
  }
  // (3) clean-room recompute — ignore receipt.result entirely while deciding.
  const gate = new PromotionGate(receipt.gate_config || {});
  for (const s of receipt.rolling_samples || []) gate.record(s);
  const recomputed = gate.evaluateWithHeldOut({ frozen, challengerHeldOut: receipt.held_out || [] });
  // ...then compare against what the receipt claimed, WITHOUT having trusted it.
  const claimed = receipt.result ?? null;
  if (!claimed) {
    mismatches.push("receipt carries no claimed result to verify — nothing to accept");
  } else if (claimed.promote !== recomputed.promote) {
    mismatches.push(`decision mismatch: receipt.promote=${claimed.promote} recomputed=${recomputed.promote}`);
  }
  return { accepted: mismatches.length === 0, recomputed, claimed, mismatches, frozenHash: actualFrozen };
}
