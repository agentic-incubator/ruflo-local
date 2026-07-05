// =============================================================================
// challenger.mjs — run the trained per-question router in SHADOW alongside the champion.
//
// This is the router-parallel-recorder pattern: for every request the CHAMPION serves
// (its tier is what actually runs), while the challenger (the KRR TrainedRouter) computes
// the tier it WOULD have picked — recorded, never served. The challenger cannot affect
// production traffic until the promotion gate (promotion-gate.mjs) promotes it on real,
// sustained evidence. `observe()` always returns the champion's served tier — that return
// value is the contract the "shadow-only" test pins.
// =============================================================================

import { predict, hashEmbed } from "./train-router.mjs";

export class ShadowChallenger {
  /** @param {object} model trained-router JSON · @param {(t:string,d:number)=>number[]} embed */
  constructor(model, embed = hashEmbed) {
    this.model = model;
    this.embed = embed;
    this.records = [];
  }

  /**
   * Parallel-record one request: the champion's SERVED tier plus the challenger's SHADOW
   * pick. SHADOW = computed and logged, never served. Returns the champion tier unchanged.
   *
   * The shadow computation is fully ISOLATED from the serving path: it is wrapped so a
   * malformed model / NaN alpha / bad dim can never throw into the caller (availability, not
   * just the return value, is protected). A pinned-private request is NEVER scored off-box —
   * the challenger records tier-private for it and does not run predict() (locality pin).
   */
  observe({ prompt, championTier, pinnedPrivate = false }) {
    let challengerTier = championTier;
    let difficulty = null;
    if (pinnedPrivate) {
      challengerTier = "tier-private"; // locality pin — never predict/route a private prompt
    } else {
      try {
        const shadow = predict(this.model, this.embed(prompt, this.model.dim));
        challengerTier = shadow.tier;
        difficulty = shadow.difficulty;
      } catch {
        challengerTier = championTier; // shadow failed → fall back to champion, never throw
      }
    }
    this.records.push({
      championTier,
      challengerTier,
      difficulty,
      served: championTier, // shadow-only: the served tier is ALWAYS the champion's
      agree: challengerTier === championTier,
    });
    return championTier;
  }

  /** Agreement rate between shadow picks and the champion (a cheap divergence signal). */
  agreementRate() {
    if (this.records.length === 0) return 1;
    return this.records.filter((r) => r.agree).length / this.records.length;
  }
}
