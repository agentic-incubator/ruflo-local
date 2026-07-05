// =============================================================================
// reflex.mjs — the day-one safety reflex: verify-then-escalate on local answers.
//
// The gateway's error-based fallback ladder can't catch a confidently-WRONG local
// answer (it only reacts to errors/timeouts). This reflex closes that gap on the
// RESPONSE side (the gateway stays dumb): when a local tier answers, score it with
// the judge and escalate to frontier ONLY when the score is below the bar. Needs no
// embedding and no learning — a pure decision over (tier, judge verdict).
//
// STATUS: reference/overlay code — runs in unit tests + offline/shadow tooling, NOT in the
// live request path (live traffic is served by the gateway / LiteLLM config). See
// docs/guide/reference/architecture-rfc.md (Path 2).
//
// PRIVACY PIN — FAIL CLOSED (non-negotiable). A private response must NEVER leave the
// box. Because the FrugalGPT judge defaults to a frontier (cloud) model, *scoring* a
// private answer would itself ship the private prompt+answer off-box. So the reflex is
// built as an ALLOWLIST, not a blocklist: ONLY tiers explicitly named as scorable
// (local, non-private — default `tier-fast`, `tier-heavy`) are ever sent off-box.
// Every other tier — `tier-private`, an unknown/blank/undefined tier, or the same name
// with different casing/whitespace — is kept local with ZERO network calls. Unknown ⇒
// private, by construction. Both the short-circuit in reflex() AND reflexDecision()
// re-check the allowlist, so the pin survives a future refactor of either.
//
// Escalation targets the frontier tier; the judge stays wherever JUDGE_MODEL points
// (set it to a local tier to keep verification cheap). The reflex degrades gracefully:
// a judge/escalation that throws, can't verify (skipped), or returns nothing keeps the
// local answer rather than failing.
// =============================================================================

import { GatewayClient } from "./gateway-client.mjs";
import { verifyEscalate } from "./verify-escalate.mjs";
import { str } from "./config.mjs";

/** Canonicalize a tier label for comparison — trim + lowercase; undefined/null → "". */
export function canonicalTier(tier) {
  return String(tier ?? "").trim().toLowerCase();
}

/**
 * The allowlist of SCORABLE tiers — local, non-private tiers that may be sent off-box
 * for scoring/escalation. Override via SCORABLE_TIERS (comma-separated). Canonicalized.
 * Note: `tier-private` is deliberately NOT here, and must never be added.
 */
export function scorableTiers(env) {
  return str("SCORABLE_TIERS", "tier-fast,tier-heavy", env)
    .split(",")
    .map(canonicalTier)
    .filter(Boolean);
}

/** Fail-closed membership test: is this tier explicitly allowed to be scored off-box? */
export function isScorable(tier, env) {
  return scorableTiers(env).includes(canonicalTier(tier));
}

/** The tier a low-scoring local answer escalates to (override via ESCALATION_TIER). */
export function escalationTier(env) {
  return str("ESCALATION_TIER", "tier-frontier", env);
}

const elapsed = (start) => Number((performance.now() - start).toFixed(3));

/**
 * Pure escalation decision from the served tier + the judge verdict. FAIL-CLOSED:
 * a non-scorable tier (private/unknown) never escalates. A skipped/absent verdict
 * (judge unreachable) keeps local — we haven't proven the answer bad, and blindly
 * escalating every turn when the judge is down would blow the frontier budget.
 * @returns {{escalate:boolean, reason:string}}
 */
export function reflexDecision({ tier, verdict, env }) {
  if (!isScorable(tier, env)) {
    return { escalate: false, reason: `tier '${tier}' is not scorable (fail-closed) — kept local` };
  }
  if (!verdict || verdict.decision === "skipped") {
    return { escalate: false, reason: "judge unavailable — kept local (cannot verify; not escalating blindly)" };
  }
  if (verdict.decision === "escalate") {
    return { escalate: true, reason: `low score ${verdict.score} < ${verdict.threshold} — escalating` };
  }
  return { escalate: false, reason: `accepted (score ${verdict.score} >= ${verdict.threshold})` };
}

/**
 * Verify-then-escalate a local-tier response.
 * @param {object} o
 * @param {string} o.tier      the tier that produced `answer` (e.g. "tier-fast", "tier-private")
 * @param {string} o.prompt    the original task
 * @param {string} o.answer    the local candidate answer
 * @param {object} [o.client]  injectable GatewayClient (for tests)
 * @param {string} [o.judgeModel] override JUDGE_MODEL
 * @param {number} [o.threshold] override VERIFY_THRESHOLD
 * @param {(prompt:string)=>Promise<string>} [o.escalate] injectable escalation fn (for tests)
 * @param {object} [o.env]     injectable env
 * @returns {Promise<{answer:string, tier:string, escalated:boolean, verdict:object|null, reason:string, overhead_ms:number}>}
 */
export async function reflex({ tier, prompt, answer, client, judgeModel, threshold, escalate, env } = {}) {
  const start = performance.now();

  // FAIL-CLOSED PRIVACY PIN — the load-bearing short-circuit. Only an explicitly
  // scorable (local, non-private) tier is sent off-box. tier-private, and anything
  // unknown/blank/undefined/mis-cased, is kept local: NO judge call, NO escalation.
  if (!isScorable(tier, env)) {
    return {
      answer,
      tier,
      escalated: false,
      verdict: null,
      reason: `tier '${tier}' is not in the scorable allowlist — kept local, never scored off-box`,
      overhead_ms: elapsed(start),
    };
  }

  const gw = client ?? new GatewayClient({ env });
  let verdict = null;
  try {
    verdict = await verifyEscalate({ prompt, answer, client: gw, judgeModel, threshold, env });
    const decision = reflexDecision({ tier, verdict, env });
    if (decision.escalate) {
      const escalateFn =
        escalate ??
        ((p) => gw.chatContent({ model: escalationTier(env), messages: [{ role: "user", content: p }] }));
      const frontierAnswer = await escalateFn(prompt);
      // Degrade gracefully: only replace when escalation actually produced an answer.
      if (frontierAnswer) {
        return { answer: frontierAnswer, tier, escalated: true, verdict, reason: decision.reason, overhead_ms: elapsed(start) };
      }
    }
    return { answer, tier, escalated: false, verdict, reason: decision.reason, overhead_ms: elapsed(start) };
  } catch (err) {
    // Chaos: a throwing judge or escalation degrades to the local answer, never rejects.
    return {
      answer,
      tier,
      escalated: false,
      verdict,
      reason: `judge/escalation error — kept local (${err?.message ?? "error"})`,
      overhead_ms: elapsed(start),
    };
  }
}
