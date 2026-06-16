// shared/social-bot/debug.ts
//
// Debug-tool wire types for the social-trainer peer. A debug-mode header dialog
// in the AAC client shows the live engine internals (sent each turn via
// `social_peer_debug`) and lets a tester fully reconfigure the peer's parameters
// and restart the director (`social_peer_reconfigure`).
//
// NOTE: this is a developer/clinician debugging surface, gated behind debugMode.

import type { Competency } from "./state";

export interface SocialGenome {
  warmth: number;        // 0 cold .. 1 warm
  expressiveness: number;// 0 reserved .. 1 expressive
  stability: number;     // 0 volatile .. 1 even
  openness: number;      // 0 guarded .. 1 quick to connect
  assertiveness: number; // 0 yielding .. 1 holds ground
  patience: number;      // 0 impatient .. 1 forgiving
}

export interface SocialSlpConfigWire {
  goalDimensions: Competency[];
  lockedDimensions: Competency[];
  maxChallengeIntensity: number; // 0..1
  challengeRatio: number;        // 0..1
}

/** The full editable parameter set behind a social-peer session. The client
 *  sends this back (whole or in part) to restart the director with overrides. */
export interface SocialPeerParams {
  name: string;
  gender: "male" | "female";
  archetype: string;
  genome: SocialGenome;
  /** topic → affinity (-1 cold .. +1 loves). */
  interests: Record<string, number>;
  /** proposition → stance the character holds. */
  stances: Record<string, { position: number; conviction: number }>;
  humorStyle: string;
  difficulty: number;       // 0..1 — "how much it meets you halfway"
  languageLevelInt: number; // 1..5 (see shared/aac-language-level)
  slp: SocialSlpConfigWire;
  model: string;
}

/** Live deterministic-engine state, emitted every turn in debug mode. */
export interface SocialPeerLiveState {
  turnIndex: number;
  mode: string;
  vector: { valence: number; arousal: number; rapport: number };
  velocity: { valence: number; arousal: number; rapport: number };
  directive: {
    tone: string;
    energy: number;
    pragmaticMove: string;
    lengthHint: string;
    mayDisclose: boolean;
    identityMove?: string | null;
    probe?: string | null;
  };
  lastChallenge: { probe: string; dim: string | null; intensity: number };
  scaffolding: number;
  askShare: number;
  /** EngineParams (springs/baselines/biases) — shown as JSON in the dialog. */
  engineParams: Record<string, unknown>;
  skills: Array<{ competency: string; value: number; samples: number }>;
  /** UserModel internal scalars — shown as JSON. */
  userModel: Record<string, unknown>;
  moments: Array<{ kind: string; summary: string; weight: number }>;
  lastReply: string;
}

export interface SocialPeerDebugSnapshot {
  params: SocialPeerParams;
  live: SocialPeerLiveState;
}

/** Client → server: restart the peer with these (whole) parameters. Debug-only. */
export interface SocialPeerReconfigure {
  params: SocialPeerParams;
}
