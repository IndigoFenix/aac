/* ============================================================================
   IDENTITY & RELATIONAL LAYER  (extends conversation-director.ts)
   ----------------------------------------------------------------------------
   Gives the character an inner life (interests + stances) and tracks the
   relationship to the user's content. The director was pragmatically aware
   (shape of turns); this makes it relationally aware (what's being said, by
   whom, about what the character cares about).

   Three additions, one principle each:
     INTERESTS  — value scales with how much the character cares about the topic
     STANCES    — rapport tracks MANNER + AUTHENTICITY, never raw agreement
     COMPLIMENTS— rapport-gated, habituating hard, specificity-weighted
   ========================================================================== */

import type { UserTurnFeatures, ResponseDirective } from "./conversation-director";

// ---------------------------------------------------------------------------
// 1. AUTHORED CHARACTER IDENTITY  (version-controlled, like the anchor glyphs)
// ---------------------------------------------------------------------------

export interface CharacterIdentity {
  /** topic -> affinity, -1 (cold/dislikes) .. +1 (lights up about it) */
  interests: Record<string, number>;
  /** proposition -> { position -1..1, conviction 0..1 } */
  stances: Record<string, { position: number; conviction: number }>;
}

// ---------------------------------------------------------------------------
// 2. RELATIONAL MODEL OF THE USER  (built up during the session)
// ---------------------------------------------------------------------------

export interface UserModel {
  /** topics the user disclosed interest in -> last turn index seen (for callbacks) */
  knownInterests: Record<string, number>;
  /** the user's own stances we've heard, to detect flip-flopping toward us */
  heardStances: Record<string, number>;
  /** compliment ledger: harsher, separate habituation from the novelty window */
  compliments: { count: number; lastTurnIndex: number };
  /** rolling read of how much the user's stances track ours = sycophancy signal */
  agreementTracking: number; // EMA 0..1, high = "agrees with whatever we just said"
}

export function emptyUserModel(): UserModel {
  return { knownInterests: {}, heardStances: {}, compliments: { count: 0, lastTurnIndex: -99 }, agreementTracking: 0.5 };
}

// ---------------------------------------------------------------------------
// 3. EXPANDED PERCEPTION  (added fields the LLM classifier must now fill)
// ---------------------------------------------------------------------------

export interface ContentFeatures {
  topic: string | null;            // primary topic referenced this turn
  // opinion / stance, only meaningful when the turn took a position:
  stanceProp: string | null;       // which proposition, if any
  alignment: number;               // -1 fully disagree .. +1 fully agree w/ character
  manner: number;                  // 0 hostile/dismissive .. 1 warm/respectful
  engagedOurView: boolean;         // did they actually address the character's stance?
  // compliment:
  compliment: boolean;
  complimentSpecific: number;      // 0 generic ("you're great") .. 1 specific & earned
  complimentSincere: number;       // 0 hollow/flattery .. 1 sincere
  // conversation mechanics (batch-A competency detection):
  interrupted: boolean;            // user cut in / didn't wait their turn
  topicShiftBridged: boolean;      // when they changed subject, did they segue (vs jump)?
  greeting: boolean;               // user opened with a greeting (hi / hello / their name)
  nearClosing: boolean;            // the conversation is at a natural wrap-up point
  closedGracefully: boolean;       // at a wrap-up point, the user closed it (bye / "this was nice")
  // social-emotional + register (batch-B competency detection):
  consideredPeerPerspective: boolean; // user referenced/asked about how YOU (the peer) feel or think
  expressedOwnEmotion: boolean;       // user named a feeling of their own ("I'm happy" / "that's scary")
  empathyOpportunity: boolean;        // you shared something emotional that warranted a caring response
  userShowedEmpathy: boolean;         // at such a moment, the user responded with care/concern
  seemedStuck: boolean;               // user seemed confused / stuck / unsure
  askedForHelp: boolean;              // when stuck, they asked you for help or clarification
  declined: boolean;                  // user turned down a request/suggestion you made
  refusedPolitely: boolean;           // if they declined, they did it kindly (vs harshly)
}

export type FullTurn = UserTurnFeatures & ContentFeatures;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------
// 4. IMPULSE CONTRIBUTIONS  (added to the velocity kick the springs receive)
// ---------------------------------------------------------------------------

export function identityImpulse(
  f: FullTurn,
  id: CharacterIdentity,
  um: UserModel,
  rapportNow: number,
  turnIndex: number,
) {
  let v = 0, a = 0, r = 0;
  const notes: string[] = []; // human-readable trace for the SLP log

  // --- INTERESTS -----------------------------------------------------------
  if (f.topic) {
    const affinity = id.interests[f.topic] ?? 0;
    if (f.wasQuestion && affinity > 0) {
      // asking about something it cares about >> a generic question
      r += 0.5 * affinity; a += 0.4 * affinity; v += 0.35 * affinity;
      notes.push(`asked about a loved topic (${f.topic})`);
    } else if (affinity < -0.3 && (f.wasQuestion || f.disclosure > 0)) {
      // pressing a topic it's cold on is mildly costly
      v -= 0.2; a -= 0.15;
    }
    // user revealing their OWN interest is disclosure we should remember
    if (f.disclosure > 0.3) {
      um.knownInterests[f.topic] = turnIndex;
      r += 0.15;
    }
  }

  // --- STANCES: manner + authenticity dominate, NOT alignment --------------
  if (f.stanceProp) {
    // track whether the user keeps aligning with us => sycophancy signal
    const charPos = id.stances[f.stanceProp]?.position ?? 0;
    const tracksUs = clamp(1 - Math.abs(f.alignment - Math.sign(charPos)) / 2, 0, 1);
    um.agreementTracking = 0.7 * um.agreementTracking + 0.3 * tracksUs;
    um.heardStances[f.stanceProp] = f.alignment;

    const engagement = 0.4 + 0.6 * (f.engagedOurView ? f.contingency : 0);
    // warmth carries it; cold/dismissive manner is negative regardless of agreement
    let stanceR = (0.6 * f.manner - 0.25) * engagement;

    // genuine, warm difference is MORE bonding than bland agreement
    if (Math.abs(f.alignment) < 0.6 && f.manner > 0.6) { stanceR += 0.2; notes.push("disagreed warmly"); }

    // sycophancy: hollow agreement plateaus and erodes; it reads as having no self
    if (um.agreementTracking > 0.75 && f.alignment > 0.5) {
      stanceR = Math.min(stanceR, 0) - 0.1;
      notes.push("agreement reads as people-pleasing");
    }
    r += stanceR;
    v += 0.3 * (f.manner - 0.5);
  }

  // --- COMPLIMENTS: rapport-gated, habituating hard, specificity-weighted ---
  if (f.compliment) {
    const sinceLast = turnIndex - um.compliments.lastTurnIndex;
    if (sinceLast > 12) um.compliments.count = 0; // reset if they backed off a while
    const habituation = Math.max(-0.6, 1 - 0.45 * um.compliments.count); // 3rd ~0.1, 4th negative
    // gate WITH rapport, not against it: too much too soon is uncomfortable
    const rapportGate = clamp((rapportNow + 0.15) / 1.0, -0.4, 1);
    const quality = 0.5 * f.complimentSpecific + 0.5 * f.complimentSincere;
    const value = 0.6 * habituation * rapportGate * (0.4 + 0.6 * quality);
    r += value; v += 0.6 * Math.max(0, value);
    um.compliments.count += 1;
    um.compliments.lastTurnIndex = turnIndex;
    if (value <= 0) notes.push(habituation < 0 ? "over-complimenting reads as manipulation" : "compliment landed too soon");
    else if (f.complimentSpecific < 0.3) notes.push("compliment was generic");
  }

  return { valence: v, arousal: a, rapport: r, notes };
}

// ---------------------------------------------------------------------------
// 5. NEW DIRECTIVE MOVES  (the character acts FROM its identity)
// ---------------------------------------------------------------------------

export type IdentityMove =
  | "volunteer_interest"   // open a topic it loves (great bid; un-gameable)
  | "callback_user_interest" // reopen something the USER disclosed earlier
  | "share_stance"         // state its own opinion, conviction-scaled
  | "test_sycophancy"      // gently challenge hollow agreement
  | "receive_compliment";  // respond in-character (warm accepts; guarded deflects)

/** Layer identity intent on top of the base directive. Call after deriveDirective. */
export function augmentDirective(
  base: ResponseDirective,
  id: CharacterIdentity,
  um: UserModel,
  rapportNow: number,
  turnIndex: number,
): ResponseDirective & { identityMove?: IdentityMove; topicHint?: string; stanceHint?: string } {
  // sycophancy is the priority correction — the teachable moment
  if (um.agreementTracking > 0.78) {
    const prop = Object.keys(id.stances).find((p) => id.stances[p].conviction > 0.5);
    return { ...base, identityMove: "test_sycophancy", stanceHint: prop, mayDisclose: true };
  }
  // a recent, earned compliment in a warm state -> reciprocate; guarded -> deflect
  if (turnIndex - um.compliments.lastTurnIndex === 0) {
    return { ...base, identityMove: "receive_compliment" };
  }
  // when it owns the turn (open_bid), prefer offering identity over generic chatter
  if (base.pragmaticMove === "open_bid") {
    const staleUserInterest = Object.entries(um.knownInterests)
      .find(([, seen]) => turnIndex - seen > 6);
    if (staleUserInterest && rapportNow > 0.2) {
      return { ...base, identityMove: "callback_user_interest", topicHint: staleUserInterest[0] };
    }
    const loved = Object.entries(id.interests).sort((a, b) => b[1] - a[1])[0];
    if (loved && loved[1] > 0.4) return { ...base, identityMove: "volunteer_interest", topicHint: loved[0] };
  }
  // in OPEN/PLAYFUL, occasionally assert a real opinion so it feels like a person
  if ((base.tone === "warm" || base.tone === "playful") && Math.random() < 0.3) {
    const prop = Object.keys(id.stances).find((p) => id.stances[p].conviction > 0.6);
    if (prop) return { ...base, identityMove: "share_stance", stanceHint: prop };
  }
  return base;
}