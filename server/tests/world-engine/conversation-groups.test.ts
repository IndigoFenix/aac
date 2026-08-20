// GROUP DYNAMICS IN THE HOST (multi-entity-conversations.md §3f, §4.8) — the
// laws an ambient circle obeys: how it forms, who is let in, what it says, and
// how it ends.
//
// WHY THIS IS A MIRROR TEST. `quest-host.ts` cannot be value-imported here: its
// import chain reaches JSX, which this jest project does not compile. So each
// law below is pinned by re-stating the host's OWN expression — copied, not
// paraphrased — and driving it through the very modules the host drives
// (`conversation-form.ts`, `conversation.ts`, `creature-converse.ts`). Every
// mirror is labelled with the host function it copies, so the two can be diffed
// by eye. (Same discipline as `conversation-host-membership.test.ts`, which
// mirrors the ⑥/⑦ half.)
//
// The system this replaced: `runNpcExchange` — two utterances, one wall timer,
// `Math.random`, and no record at all, so nothing could ever join it, overhear
// it, answer anybody but the person who spoke, or execute a single thing.
//
// ⑫⑤ NOTE — `runTurn` below drives real 3+ rosters through the real façade and
// never trips `underSpecified`, which is by construction rather than by luck:
// `chooseSpeakerMove` RESTORES the addressee on any act that names a person
// (only `FLOOR_SAFE_ACTS` may come back unaddressed), and no member of
// `ADDRESSEE_REQUIRED_ACTS` is floor-safe. The two rules were written against
// each other, so an NPC cannot put a request/offer/trade/invite on the floor.
// The player half — a BOARD PRESS, which carries no such restoration — is
// pinned in `conversation-ambiguity.test.ts`.
//
// DB-free / GL-free — runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import { hashSeed, mulberry32 } from "@shared/prng.js";
import {
  CONV_FORM,
  bystanderJoins,
  mayJoin,
  pickConversationFocus,
  pickOpener,
  ringSlotFor,
  type FocusCandidate,
  type FormCandidate,
  type RingBody,
} from "@shared/world-engine/interaction/dialogue/conversation-form.js";
import {
  addressingOf,
  createConversation,
  joinConversation,
  leaveConversation,
  soleOther,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import {
  chooseSpeakerMove,
  speakInConversation,
} from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import type {
  DialogueAct,
  ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import {
  createCreatureWorld,
  type CreatureEvent,
  type CreatureWorld,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { makePersonality, type Personality } from "@shared/world-engine/interaction/behavior/personality.js";
import { DEFAULT_RELATION } from "@shared/world-engine/interaction/behavior/relations.js";
import { LOCAL_PLAYER_CID, isPlayerCid, playerCidOf } from "@shared/world-engine/interaction/quest/player-identity.js";

// ---------------------------------------------------------------------------
// The host's own constants and small functions, mirrored
// ---------------------------------------------------------------------------

/** MIRROR of quest-host's ambient-chat dials. */
const CHAT_PAIR_RADIUS = 6;
const CHAT_COOLDOWN = 22;
const GROUP_TURN_GAP_S = 4;
const GROUP_DULL_RETRY_S = 2;
const GROUP_WALK_TIMEOUT_S = 20;

/** MIRROR of `creatureMood(cid)` — the stable per-creature temperament hashed
 *  from its id, with no personality data field anywhere. */
function creatureMood(cid: string): Personality {
  let h = 0;
  for (let i = 0; i < cid.length; i++) h = (h * 31 + cid.charCodeAt(i)) | 0;
  h = Math.abs(h);
  const dial = (shift: number) => 0.25 + (((h >> shift) & 7) / 7) * 0.6; // 0.25..0.85
  return makePersonality({
    warmth: dial(0),
    expressiveness: dial(3),
    openness: dial(6),
    assertiveness: dial(9),
  });
}

/** MIRROR of `chatRng(session)` — one fresh stream per formation attempt. */
const chatRng = (seed: number, attempt: number) => mulberry32(hashSeed(seed, "chat", attempt));
/** MIRROR of `convoRng(session, c)` — one fresh stream per TURN, keyed by the
 *  conversation's ID and the seq the utterance is about to take. */
const convoRng = (seed: number, id: string, nextSeq: number) =>
  mulberry32(hashSeed(seed, "convo", id, nextSeq));

interface Body {
  x: number;
  y: number;
  r: number;
}

/** MIRROR of `GroupCircle` — the sim half of an ambient conversation. */
interface GroupCircle {
  anchor: { x: number; y: number };
  nextTurnAt: number;
  dullS: number;
  slots: Map<string, number>;
  ringR: number;
  dwell: Map<string, number>;
  incoming: Map<string, number>;
  pending: { speakerCid: string; glyph: string; dueIn: number } | null;
  facing: { speakerCid: string; addresseeCid?: string } | null;
  turnedAway: Set<string>;
  leaving: Set<string>;
  lastWordsAt: number;
}

/** MIRROR of `HostConversation` — ONE shape for both kinds of conversation.
 *  ⑩ adds `faced`: which creature each AUTHOR that joined a circle walked up to
 *  — its board, its default addressee, and the `cid` its sync is keyed on. */
interface HostConversation {
  id: string;
  nodeId: string;
  convo: ConversationState;
  group?: GroupCircle;
  faced?: Map<string, string>;
}

/** MIRROR of `ConvoView` — ⑩ split `cid` (the creature the board FACES) from
 *  `convoId` (the record it is a view OF). They are the same string for every
 *  player-opened conversation and different the moment a player joins a circle. */
interface ConvoView {
  cid: string;
  convoId: string;
}

/**
 * A stand-in for the host's conversation book and its ambient loop, holding only
 * what the host holds: the id-keyed records, the one-conversation-per-creature
 * index, the bodies, the cooldowns and the clock.
 */
class GroupMirror {
  readonly conversations = new Map<string, HostConversation>();
  readonly convoOfCreature = new Map<string, string>();
  readonly bodies = new Map<string, Body>();
  readonly chatCooldown = new Map<string, number>();
  readonly npcTasks = new Map<string, number>();
  readonly party = new Set<string>();
  readonly carrying = new Set<string>();
  readonly needMeters = new Map<string, number>();
  readonly socialThreshold = new Map<string, number>();
  readonly said: string[] = [];
  readonly walks: Array<{ cid: string; to: { x: number; y: number } }> = [];
  taskClock = 0;
  convoIdSeq = 0;
  attempt = 0;
  seed = 7;
  level: "a" | "b" | "c" = "b";
  focusedConvoId: string | null = null;
  /** MIRROR of the host's `convoView` — the board THIS device has open. */
  convoView: ConvoView | null = null;
  /** MIRROR of the host's `convoAddressee` — the fellow member this device's
   *  gaze picked. ⑫③ demoted it to a LOCAL OPTIMISTIC ECHO: the durable answer
   *  lives on the roster row (`ConvoMember.addressing`), and null here no longer
   *  means "whoever the board faces" — it means the next rung down. */
  convoAddressee: string | null = null;
  /** MIRROR of `headingSpokenFor(cid)` — `sess.actionHold` ∪ `headingHeldByLegs`.
   *  A body whose hands or legs already own its heading cannot spend the LOOK
   *  channel (law ①). Nothing moves during a conversation yet, so it is empty in
   *  every test here; ⑫② is what fills it. */
  readonly heldHeading = new Set<string>();
  /** MIRROR of `authorEmbodied(LOCAL_PLAYER_CID)` — a formless spirit takes no
   *  ring slot. Flipped per test. */
  embodied = true;

  // ── the index (`seatMember` / `unseatMember` / `dropConversation`) ────────

  conversationOf(cid: string): HostConversation | undefined {
    const id = this.convoOfCreature.get(cid);
    return (id !== undefined ? this.conversations.get(id) : undefined) ?? this.conversations.get(cid);
  }

  seatMember(c: HostConversation, cid: string) {
    const prior = this.convoOfCreature.get(cid);
    if (prior !== undefined && prior !== c.id) {
      const old = this.conversations.get(prior);
      if (old) leaveConversation(old.convo, cid);
    }
    this.convoOfCreature.set(cid, c.id);
    return joinConversation(c.convo, cid, this.taskClock, this.level);
  }

  unseatMember(c: HostConversation, cid: string) {
    leaveConversation(c.convo, cid);
    if (this.convoOfCreature.get(cid) === c.id) this.convoOfCreature.delete(cid);
  }

  dropConversation(c: HostConversation) {
    for (const m of c.convo.members) {
      if (this.convoOfCreature.get(m.id) === c.id) this.convoOfCreature.delete(m.id);
    }
    this.conversations.delete(c.id);
    // ⑩ — the board goes with the record: a circle that broke up has no view.
    if (this.convoView?.convoId === c.id) this.closeConvoView();
  }

  // ── ⑩ THE PLAYER'S MEMBERSHIP ─────────────────────────────────────────────

  /** MIRROR of `closeConvoView()` — the view half, and the addressee with it. */
  closeConvoView() {
    this.convoView = null;
    this.convoAddressee = null;
  }

  /** MIRROR of `viewRecord()` — the ONE view↔record resolution. */
  viewRecord(): HostConversation | null {
    return this.convoView ? (this.conversations.get(this.convoView.convoId) ?? null) : null;
  }

  /** MIRROR of `facedBy(c, memberCid)` — the BOARD's aim and the wire key.
   *  ⑫③ took away its third job (the default addressee) and left these two. */
  facedBy(c: HostConversation, memberCid: string): string {
    const faced = c.faced?.get(memberCid);
    if (faced && c.convo.members.some((m) => m.id === faced)) return faced;
    if (!c.group) return c.nodeId;
    return c.convo.members.find((m) => !isPlayerCid(m.id))?.id ?? c.nodeId;
  }

  /** MIRROR of `liveConvoAddressee()` — a member who left addresses nobody. */
  liveConvoAddressee(): string | null {
    const a = this.convoAddressee;
    if (!a) return null;
    const c = this.viewRecord();
    if (c && c.convo.members.some((m) => m.id === a)) return a;
    this.convoAddressee = null;
    return null;
  }

  /** MIRROR of `memberAddressee(c, memberCid)` — ⑫③'s NULLABLE channel order:
   *  dyad → the heading is spoken for ⇒ null → `addressing` → the local echo →
   *  null. The faced creature is NOT the bottom rung any more (the board's aim is
   *  not the sentence's addressee); the rungs themselves are pinned in
   *  `conversation-addressee.test.ts`. */
  memberAddressee(c: HostConversation, memberCid: string): string | null {
    const sole = soleOther(c.convo, memberCid);
    if (sole) return sole;
    if (!isPlayerCid(memberCid) && this.heldHeading.has(memberCid)) return null;
    const held = addressingOf(c.convo, memberCid);
    if (held) return held;
    if (memberCid === LOCAL_PLAYER_CID && this.convoView?.convoId === c.id) {
      const picked = this.liveConvoAddressee();
      if (picked) return picked;
    }
    return null;
  }

  /** MIRROR of `setConvoAddressee` (the state half — the glance is a facing). */
  setConvoAddressee(cid: string) {
    const c = this.viewRecord();
    if (!c || !c.convo.members.some((m) => m.id === cid)) return;
    this.convoAddressee = cid;
  }

  /**
   * ★ MIRROR of `conversationWith(nodeId, memberCid)` — ⑩'s reversal. ★
   *
   * A creature already standing in a CIRCLE no longer gives itself up: the
   * author is seated in the circle's own record, at a ring slot if it has a body
   * to stand on, and the record it joins IS its board.
   */
  conversationWith(nodeId: string, memberCid: string = LOCAL_PLAYER_CID): HostConversation {
    const circle = this.conversationOf(nodeId);
    if (circle?.group) {
      const already = this.convoOfCreature.get(memberCid) === circle.id;
      if (!already) {
        (circle.faced ??= new Map()).set(memberCid, nodeId);
        if (this.embodied) this.reserveSlot(circle, memberCid);
      }
      this.seatMember(circle, memberCid);
      return circle;
    }
    let c = this.conversations.get(nodeId);
    if (!c) {
      c = { id: nodeId, nodeId, convo: createConversation(nodeId, this.taskClock) };
      this.conversations.set(nodeId, c);
      this.seatMember(c, nodeId);
    }
    this.seatMember(c, memberCid);
    return c;
  }

  /** MIRROR of `openCreatureConvo(nodeId)` — the view half. */
  open(nodeId: string): HostConversation {
    const c = this.conversationWith(nodeId, LOCAL_PLAYER_CID);
    this.convoView = { cid: nodeId, convoId: c.id };
    this.convoAddressee = null;
    return c;
  }

  /** MIRROR of `conversationSpent(c, tick)` — ⑩'s group-guard refinement. */
  spent(c: HostConversation): boolean {
    const hasAuthor = c.convo.members.some((m) => isPlayerCid(m.id));
    if (c.group) return hasAuthor && !c.convo.members.some((m) => !isPlayerCid(m.id));
    return !hasAuthor; // (the idle door is pinned in conversation-host-membership)
  }

  /** MIRROR of `sweepConversation(c)` — keyed on the RECORD, not the creature. */
  sweep(c: HostConversation): boolean {
    if (this.convoView?.convoId === c.id) return false;
    if (!this.spent(c)) return false;
    this.dropConversation(c);
    return true;
  }

  /** MIRROR of `departConversation(c, memberCid)`. */
  departConversation(c: HostConversation, memberCid: string) {
    if (c.group) this.departGroup(c, memberCid);
    else this.unseatMember(c, memberCid);
    if (memberCid === LOCAL_PLAYER_CID && this.convoView?.convoId === c.id) this.closeConvoView();
    if (!this.conversations.has(c.id)) return;
    this.sweep(c);
  }

  /** MIRROR of `lapseConvoMembership(nodeId)` — ⑩'s idle rule. */
  lapseConvoMembership() {
    const c = this.viewRecord();
    if (!c?.group) {
      // A DYAD keeps today's close: the record is the player's, and nothing is
      // happening in it that they are not doing.
      if (c) this.departConversation(c, LOCAL_PLAYER_CID);
      this.closeConvoView();
      return;
    }
    this.departConversation(c, LOCAL_PLAYER_CID);
  }

  /** MIRROR of `syncConvoMembers`'s keying — the creature THAT MEMBER faces. */
  syncKeyFor(c: HostConversation, memberCid: string): string {
    return this.facedBy(c, memberCid);
  }

  // ── eligibility (`socialMeter01` / `chatEligible` / `standingAndFree` /
  //    ⑫ `standingHere`) ────────────────────────────────────────────────────

  socialMeter01(cid: string): number {
    const key = [...this.needMeters.keys()].find((k) => k.startsWith(`${cid}|social`));
    if (!key) return 0.5;
    const th = this.socialThreshold.get(cid) ?? 1;
    const meter = this.needMeters.get(key) ?? 0;
    return th > 0 ? Math.min(1, meter / th) : 0;
  }

  chatEligible(cid: string): boolean {
    if (isPlayerCid(cid)) return false;
    if (this.convoOfCreature.has(cid)) return false;
    if ((this.chatCooldown.get(cid) ?? 0) > 0) return false;
    if (!this.bodies.has(cid)) return false;
    return this.standingAndFree(cid);
  }

  /** THE DRAFT test: free to be pulled in. */
  standingAndFree(cid: string): boolean {
    if (!this.bodies.has(cid)) return false;
    if ((this.npcTasks.get(cid) ?? 0) > 0) return false;
    if (this.carrying.has(cid)) return false;
    return true;
  }

  /** ⑫ — THE SEATED test: presence only. Availability is deliberately not asked
   *  (working while talking is legal; what it costs is paid elsewhere). */
  standingHere(cid: string): boolean {
    return this.bodies.has(cid);
  }

  // ── the ring (`ringBodies` / `reserveSlot`) ───────────────────────────────

  ringBodies(c: HostConversation): RingBody[] {
    const out: RingBody[] = [];
    for (const [cid, angle] of c.group!.slots) {
      out.push({ id: cid, angle, radiusM: this.bodies.get(cid)?.r ?? 0.35 });
    }
    return out;
  }

  reserveSlot(c: HostConversation, cid: string) {
    const g = c.group!;
    const slot = ringSlotFor(this.ringBodies(c), { radiusM: this.bodies.get(cid)?.r ?? 0.35 });
    g.slots.set(cid, slot.angle);
    g.ringR = slot.ringR;
    return {
      x: g.anchor.x + g.ringR * Math.cos(slot.angle),
      y: g.anchor.y + g.ringR * Math.sin(slot.angle),
    };
  }

  // ── formation (`openGroup` / `inviteToCircle` / `arriveAtCircle`) ─────────

  openGroup(opener: string, partner: string): HostConversation | null {
    const a = this.bodies.get(opener);
    const b = this.bodies.get(partner);
    if (!a || !b) return null;
    const id = `conv:${this.convoIdSeq++}`;
    const c: HostConversation = {
      id,
      nodeId: opener,
      convo: createConversation(id, this.taskClock),
      group: {
        anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        nextTurnAt: this.taskClock,
        dullS: 0,
        slots: new Map(),
        ringR: CONV_FORM.ringRadius(2),
        dwell: new Map(),
        incoming: new Map(),
        pending: null,
        facing: null,
        turnedAway: new Set(),
        leaving: new Set(),
        lastWordsAt: this.taskClock,
      },
    };
    this.conversations.set(id, c);
    const g = c.group!;
    g.slots.set(opener, Math.atan2(a.y - g.anchor.y, a.x - g.anchor.x));
    const partnerSlot = ringSlotFor(this.ringBodies(c), { radiusM: b.r });
    g.slots.set(partner, partnerSlot.angle);
    g.ringR = partnerSlot.ringR;
    this.seatMember(c, opener);
    this.seatMember(c, partner);
    g.facing = { speakerCid: opener, addresseeCid: partner };
    return c;
  }

  inviteToCircle(c: HostConversation, cid: string) {
    const g = c.group!;
    const spot = this.reserveSlot(c, cid);
    g.incoming.set(cid, this.taskClock + GROUP_WALK_TIMEOUT_S);
    g.dwell.delete(cid);
    this.npcTasks.set(cid, 1); // the errand queue the walk rides
    this.walks.push({ cid, to: spot });
  }

  arriveAtCircle(c: HostConversation, cid: string) {
    const g = c.group;
    if (!g || !this.conversations.has(c.id) || !g.incoming.has(cid)) return;
    g.incoming.delete(cid);
    this.npcTasks.delete(cid);
    if (!mayJoin(c.convo.members.map((m) => m.id), cid)) {
      g.slots.delete(cid);
      return;
    }
    this.seatMember(c, cid);
    this.said.push(`${cid}:hi`);
  }

  // ── leaving (`departGroup` / `disperseGroup`) ─────────────────────────────

  departGroup(c: HostConversation, cid: string) {
    const g = c.group;
    if (!g) return;
    this.unseatMember(c, cid);
    g.slots.delete(cid);
    g.incoming.delete(cid);
    g.dwell.delete(cid);
    g.turnedAway.delete(cid);
    g.leaving.delete(cid);
    if (g.pending?.speakerCid === cid) g.pending = null;
    c.faced?.delete(cid);
    // ⑩ — a cooldown is a CREATURE's rest from being drafted; an author is never
    // drafted, so one would mean nothing on them.
    if (!isPlayerCid(cid)) this.chatCooldown.set(cid, CHAT_COOLDOWN);
    if (c.convo.members.length < 2) this.disperseGroup(c);
  }

  disperseGroup(c: HostConversation) {
    const g = c.group;
    if (!g) return;
    for (const m of c.convo.members) {
      if (!isPlayerCid(m.id)) this.chatCooldown.set(m.id, CHAT_COOLDOWN);
    }
    for (const cid of g.incoming.keys()) this.chatCooldown.set(cid, CHAT_COOLDOWN);
    this.dropConversation(c);
  }

  // ── ⑫ the anchor follows its people (`stepGroupAnchor`) ───────────────────

  /** Mirrors quest-host's `stepGroupAnchor`: ease the anchor toward the members'
   *  centroid, then station-keep the IDLE ones. Returns whom it walked. */
  stepGroupAnchor(c: HostConversation, dt: number, rate = 0.7, band = 3.5): string[] {
    const g = c.group;
    if (!g) return [];
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (const m of c.convo.members) {
      const av = this.bodies.get(m.id);
      if (!av) continue;
      sumX += av.x;
      sumY += av.y;
      n++;
    }
    if (n === 0) return [];
    const k = 1 - Math.exp(-rate * dt);
    g.anchor.x += (sumX / n - g.anchor.x) * k;
    g.anchor.y += (sumY / n - g.anchor.y) * k;
    const walked: string[] = [];
    for (const m of c.convo.members) {
      if (isPlayerCid(m.id)) continue;
      if ((this.npcTasks.get(m.id) ?? 0) > 0) continue;
      if (g.incoming.has(m.id)) continue;
      const av = this.bodies.get(m.id);
      if (!av) continue;
      if (Math.hypot(av.x - g.anchor.x, av.y - g.anchor.y) <= band) continue;
      walked.push(m.id);
    }
    return walked;
  }

  // ── the sweep (`sweepGroups`) ─────────────────────────────────────────────

  sweepGroups(rng: () => number) {
    for (const c of [...this.conversations.values()]) {
      const g = c.group;
      if (!g) continue;
      for (const [cid, deadline] of [...g.incoming]) {
        if (this.taskClock < deadline) continue;
        g.incoming.delete(cid);
        g.slots.delete(cid);
      }
      for (const m of [...c.convo.members]) {
        if (isPlayerCid(m.id)) continue;
        if (!this.conversations.has(c.id)) break;
        const av = this.bodies.get(m.id);
        const drifted = !av || Math.hypot(av.x - g.anchor.x, av.y - g.anchor.y) > CONV_FORM.driftLeaveM;
        // ⑫ — presence only. A busy member stays and pays elsewhere.
        if (drifted || !this.standingHere(m.id)) {
          this.departGroup(c, m.id);
          continue;
        }
      }
      if (!this.conversations.has(c.id)) continue;
      for (const [cid, dwelled] of [...g.dwell]) {
        if (dwelled < CONV_FORM.joinDwellS) continue;
        g.dwell.set(cid, 0);
        if (!this.chatEligible(cid)) continue;
        if (!mayJoin(c.convo.members.map((m) => m.id), cid)) continue;
        const mood = creatureMood(cid);
        if (!bystanderJoins(mood.openness, mood.warmth, rng)) continue;
        this.inviteToCircle(c, cid);
      }
    }
  }

  /** MIRROR of `stepGroup`'s dwell half — accrued per frame, rolled on the sweep. */
  accrueDwell(c: HostConversation, dt: number) {
    const g = c.group!;
    for (const cid of this.bodies.keys()) {
      if (isPlayerCid(cid) || this.convoOfCreature.has(cid) || g.incoming.has(cid)) continue;
      const av = this.bodies.get(cid)!;
      const near = Math.hypot(av.x - g.anchor.x, av.y - g.anchor.y) <= CONV_FORM.joinRadiusM;
      if (!near) {
        g.dwell.delete(cid);
        continue;
      }
      g.dwell.set(cid, (g.dwell.get(cid) ?? 0) + dt);
    }
  }

  // ── formation attempt (`stepNpcChatter`'s tail) ───────────────────────────

  /** MIRROR of the ★ FORMATION ★ block: pre-filter to creatures that HAVE a
   *  partner in range, then one seeded softmax draw over social × expressiveness. */
  formationAttempt(rng: () => number): HostConversation | null {
    const cids = [...this.bodies.keys()].filter((cid) => this.chatEligible(cid));
    if (cids.length < 2) return null;
    const near = cids.slice();
    for (let i = near.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [near[i], near[j]] = [near[j]!, near[i]!];
    }
    const partnerOf = new Map<string, string>();
    for (const cid of near) {
      const av = this.bodies.get(cid)!;
      let best = CHAT_PAIR_RADIUS;
      let found: string | null = null;
      for (const other of cids) {
        if (other === cid) continue;
        const oav = this.bodies.get(other)!;
        const d = Math.hypot(oav.x - av.x, oav.y - av.y);
        if (d <= best) {
          best = d;
          found = other;
        }
      }
      if (found) partnerOf.set(cid, found);
    }
    if (partnerOf.size === 0) return null;
    const forms: FormCandidate[] = [...partnerOf.keys()].map((cid) => ({
      id: cid,
      social: this.socialMeter01(cid),
      expressiveness: creatureMood(cid).expressiveness,
    }));
    const opener = pickOpener(forms, rng);
    const partner = opener ? partnerOf.get(opener) : undefined;
    return opener && partner ? this.openGroup(opener, partner) : null;
  }

  // ── focus (`publishConversationFocus`) ────────────────────────────────────

  focusCandidates(here: { x: number; y: number } | null): FocusCandidate[] {
    const cands: FocusCandidate[] = [];
    // ⑩ — a joined CIRCLE is already a candidate below, with its real anchor
    // distance and its own last-words clock, so it is never pushed twice.
    const mine = this.convoView?.convoId ?? null;
    const mineRec = mine ? this.conversations.get(mine) : null;
    if (mine && !mineRec?.group) {
      cands.push({ id: mine, hasLocalPlayer: true, distM: 0, lastWordsAgoS: 0 });
    }
    for (const c of this.conversations.values()) {
      const g = c.group;
      if (!g) continue;
      cands.push({
        id: c.id,
        hasLocalPlayer: c.convo.members.some((m) => m.id === LOCAL_PLAYER_CID),
        distM: here ? Math.hypot(g.anchor.x - here.x, g.anchor.y - here.y) : Infinity,
        lastWordsAgoS: this.taskClock - g.lastWordsAt,
      });
    }
    return cands;
  }

  publishFocus(here: { x: number; y: number } | null): string | null {
    this.focusedConvoId = pickConversationFocus(this.focusCandidates(here));
    return this.focusedConvoId;
  }

  /** MIRROR of `groupVoiceOn(c)` — the ⑧ mute rule, in PRESENTATION only.
   *  ⑩: …unless the child is IN this circle, in which case the board they have
   *  open IS this conversation and muting it would silence what they joined. */
  groupVoiceOn(c: HostConversation, boardChoiceOpen: boolean): boolean {
    if (boardChoiceOpen && !c.convo.members.some((m) => m.id === LOCAL_PLAYER_CID)) return false;
    return this.focusedConvoId === c.id;
  }
}

// ---------------------------------------------------------------------------
// A town to talk in
// ---------------------------------------------------------------------------

const ADA = "resident_0_0";
const BEN = "resident_0_1";
const CAL = "resident_1_0";
const DOT = "resident_1_1";

/** Four townsfolk standing near enough to talk, all idle and off cooldown. */
function town(): GroupMirror {
  const h = new GroupMirror();
  h.bodies.set(ADA, { x: 0, y: 0, r: 0.35 });
  h.bodies.set(BEN, { x: 2, y: 0, r: 0.35 });
  h.bodies.set(CAL, { x: 1, y: 2, r: 0.35 });
  h.bodies.set(DOT, { x: 30, y: 30, r: 0.35 }); // across town
  return h;
}

// ---------------------------------------------------------------------------
// 1. FORMATION — seeded, and the same every time
// ---------------------------------------------------------------------------

describe("formation — who opens, and who they open with", () => {
  it("the same seed forms the same circle, twice, from the same town", () => {
    const run = () => {
      const h = town();
      const c = h.formationAttempt(chatRng(h.seed, 0));
      return c?.convo.members.map((m) => m.id) ?? null;
    };
    const first = run();
    expect(first).not.toBeNull();
    expect(first).toHaveLength(2);
    expect(run()).toEqual(first);
  });

  it("…and a DIFFERENT seed is free to form a different one (the tail stays live)", () => {
    const rosters = new Set<string>();
    for (let seed = 0; seed < 24; seed++) {
      const h = town();
      h.seed = seed;
      const c = h.formationAttempt(chatRng(seed, 0));
      if (c) rosters.add(c.convo.members.map((m) => m.id).join("+"));
    }
    // Three eligible bodies within 6 m ⇒ more than one possible pair. A softmax
    // that only ever produced one of them would be an argmax with extra steps.
    expect(rosters.size).toBeGreaterThan(1);
  });

  it("a lonely, talkative creature opens far more often than a contented quiet one", () => {
    // The dial the design names: `openerScore` is social × expressiveness, and
    // the softmax leaves the quiet one a live tail rather than zero.
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 200; seed++) {
      const h = town();
      h.needMeters.set(`${ADA}|social`, 1);
      h.socialThreshold.set(ADA, 1);
      h.needMeters.set(`${BEN}|social`, 0);
      h.socialThreshold.set(BEN, 1);
      const c = h.formationAttempt(chatRng(seed, 0));
      if (!c) continue;
      const opener = c.nodeId;
      counts.set(opener, (counts.get(opener) ?? 0) + 1);
    }
    expect((counts.get(ADA) ?? 0)).toBeGreaterThan(counts.get(BEN) ?? 0);
  });

  it("nobody is drafted from across town — CHAT_PAIR_RADIUS is the reach", () => {
    const h = town();
    const c = h.formationAttempt(chatRng(h.seed, 0));
    expect(c!.convo.members.map((m) => m.id)).not.toContain(DOT);
  });

  it("the ANCHOR is the midpoint, and both openers are seated on real bearings", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    const g = c.group!;
    expect(g.anchor).toEqual({ x: 1, y: 0 });
    // Ada is at -x from the anchor, Ben at +x: the ring the pure layer describes
    // and the ring on the ground are the same ring from the first frame.
    expect(Math.cos(g.slots.get(ADA)!)).toBeCloseTo(-1, 6);
    expect(Math.cos(g.slots.get(BEN)!)).toBeCloseTo(1, 6);
  });

  it("a creature that is already talking is never drafted into a second circle", () => {
    const h = town();
    const first = h.openGroup(ADA, BEN)!;
    expect(h.chatEligible(ADA)).toBe(false);
    expect(h.chatEligible(BEN)).toBe(false);
    // …and the index says where each of them is, which is the law itself.
    expect(h.convoOfCreature.get(ADA)).toBe(first.id);
    expect(h.conversationOf(BEN)).toBe(first);
  });

  it("busy hands, errands and cooled-down speakers are all out of the DRAFT", () => {
    const h = town();
    h.carrying.add(BEN);
    h.npcTasks.set(CAL, 1);
    h.chatCooldown.set(DOT, 5);
    for (const cid of [BEN, CAL, DOT]) expect(h.chatEligible(cid)).toBe(false);
  });

  it("⑫ — A PARTY MEMBER MAY TALK. Following the player is not a reason to be silent", () => {
    // The ban was the only thing making "follow me, and let's talk while we
    // walk" impossible — and the follow loop IS station-keeping, so a companion
    // walking beside you is the best-placed body in the world to talk to.
    const h = town();
    h.party.add(ADA);
    expect(h.chatEligible(ADA)).toBe(true);
    expect(h.standingHere(ADA)).toBe(true);
  });

  it("⑫ — a seated member is judged on PRESENCE, never on being busy", () => {
    const h = town();
    h.party.add(ADA);
    h.npcTasks.set(ADA, 1); // an errand: out of the draft…
    h.carrying.add(ADA);
    expect(h.chatEligible(ADA)).toBe(false);
    expect(h.standingHere(ADA)).toBe(true); // …but still standing right there
  });

  it("⑫ — a body that streamed out is genuinely gone", () => {
    const h = town();
    h.bodies.delete(ADA);
    expect(h.standingHere(ADA)).toBe(false);
  });

  it("⑫ — a busy member is no longer swept out of a circle it is standing in", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    h.npcTasks.set(CAL, 1); // pulled onto an errand mid-conversation
    h.carrying.add(CAL);
    h.sweepGroups(() => 1 - 1e-9);
    expect(c.convo.members.map((m) => m.id)).toContain(CAL);
    expect(c.group!.leaving.has(CAL)).toBe(false);
  });

  it("⑫ — but a member that walks OUT of the leash still leaves", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    const g = c.group!;
    h.bodies.set(CAL, { x: g.anchor.x + CONV_FORM.driftLeaveM + 1, y: g.anchor.y, r: 0.35 });
    h.sweepGroups(() => 1 - 1e-9);
    expect(c.convo.members.map((m) => m.id)).not.toContain(CAL);
  });
});

// ---------------------------------------------------------------------------
// 2. JOINING — the dwell, the roll, and the seat that carries the floor
// ---------------------------------------------------------------------------

describe("a bystander joins — and only ON ARRIVAL is it in the conversation", () => {
  const circle = () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    return { h, c };
  };

  it("walking PAST a circle never rolls the dice", () => {
    const { h, c } = circle();
    h.accrueDwell(c, 1); // one second inside the radius…
    h.bodies.set(CAL, { x: 20, y: 20, r: 0.35 }); // …and away it goes
    h.accrueDwell(c, 1);
    expect(c.group!.dwell.has(CAL)).toBe(false);
    h.sweepGroups(() => 0);
    expect(c.convo.members.map((m) => m.id)).not.toContain(CAL);
  });

  it("the dwell has to RUN OUT before the roll happens at all", () => {
    const { h, c } = circle();
    h.accrueDwell(c, CONV_FORM.joinDwellS - 0.1);
    h.sweepGroups(() => 0); // a roll of 0 always passes — so nothing may roll yet
    expect(h.walks).toHaveLength(0);
    h.accrueDwell(c, 0.2);
    h.sweepGroups(() => 0);
    expect(h.walks).toEqual([{ cid: CAL, to: expect.anything() }]);
  });

  it("a FAILED roll restarts the stopwatch — it has to keep standing there", () => {
    const { h, c } = circle();
    h.accrueDwell(c, CONV_FORM.joinDwellS);
    h.sweepGroups(() => 1 - 1e-9); // the roll that never passes
    expect(h.walks).toHaveLength(0);
    expect(c.group!.dwell.get(CAL)).toBe(0);
  });

  it("🚨 the roll starts a WALK, not a membership — floor rights come with the seat", () => {
    const { h, c } = circle();
    h.accrueDwell(c, CONV_FORM.joinDwellS);
    h.sweepGroups(() => 0);
    // Reserved, walking, and NOT on the roster: it cannot be arbitrated into
    // answering a question from thirty feet away.
    expect(c.group!.incoming.has(CAL)).toBe(true);
    expect(c.group!.slots.has(CAL)).toBe(true);
    expect(c.convo.members.map((m) => m.id)).toEqual([ADA, BEN]);

    h.arriveAtCircle(c, CAL);
    expect(c.convo.members.map((m) => m.id)).toEqual([ADA, BEN, CAL]);
    expect(h.said).toContain(`${CAL}:hi`); // greets on arrival
    expect(c.group!.incoming.size).toBe(0);
  });

  it("a reserved slot takes the largest GAP, so nobody walks into anybody", () => {
    const { h, c } = circle();
    const before = [...c.group!.slots.values()].sort((a, b) => a - b);
    h.reserveSlot(c, CAL);
    const angle = c.group!.slots.get(CAL)!;
    // Two bodies at 0 and π: the newcomer lands on one of the two bisectors.
    const gapMid = [(before[0]! + before[1]!) / 2, (before[1]! + before[0]!) / 2 + Math.PI];
    expect(gapMid.some((m) => Math.abs(((angle - m) % (2 * Math.PI)) % Math.PI) < 1e-6)).toBe(true);
    // …and the ring never sits inside the separation rule.
    const seats = [...c.group!.slots.values()].sort((a, b) => a - b);
    for (let i = 0; i < seats.length; i++) {
      const d = i + 1 < seats.length ? seats[i + 1]! - seats[i]! : 2 * Math.PI - seats[i]! + seats[0]!;
      expect(2 * c.group!.ringR * Math.sin(d / 2)).toBeGreaterThanOrEqual(0.35 + 0.35 + CONV_FORM.ringMarginM - 1e-9);
    }
  });

  it("a walk that never arrives releases its reservation", () => {
    const { h, c } = circle();
    h.inviteToCircle(c, CAL);
    h.taskClock += GROUP_WALK_TIMEOUT_S;
    h.sweepGroups(() => 1 - 1e-9);
    expect(c.group!.incoming.has(CAL)).toBe(false);
    expect(c.group!.slots.has(CAL)).toBe(false);
  });

  it("the roster CAP holds against NPCs and never against a player", () => {
    const { c } = circle();
    for (const extra of ["r2", "r3", "r4"]) joinConversation(c.convo, extra, 0, "b");
    const ids = c.convo.members.map((m) => m.id);
    expect(ids).toHaveLength(CONV_FORM.maxMembers);
    expect(mayJoin(ids, "r5")).toBe(false);
    expect(mayJoin(ids, LOCAL_PLAYER_CID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. THE TURN LOOP — a real transcript, through the real façade
// ---------------------------------------------------------------------------

/** MIRROR of `runGroupTurn`'s mover search + `speakGroupMove`, over the REAL
 *  `chooseSpeakerMove` / `speakInConversation`. Returns the line said, or null
 *  for a dull turn (which is what accumulates toward `boreS`). */
function runTurn(
  h: GroupMirror,
  w: CreatureWorld,
  c: HostConversation,
  opts: ProjectionOpts,
): { speaker: string; glyph: string; reply?: string } | null {
  const g = c.group!;
  const rng = convoRng(h.seed, c.id, c.convo.nextSeq);
  g.turnedAway.clear();

  const leaver = c.convo.members.find((m) => g.leaving.has(m.id));
  if (leaver) {
    const bye: DialogueAct = { kind: "bye", glyph: "goodbye" };
    speakInConversation(w, c.convo, leaver.id, bye, undefined, opts, {
      tick: h.taskClock,
      rng,
      personalityOf: creatureMood,
    });
    g.leaving.delete(leaver.id);
    h.departGroup(c, leaver.id);
    g.nextTurnAt = h.taskClock + GROUP_TURN_GAP_S;
    return { speaker: leaver.id, glyph: "goodbye" };
  }

  const movers = c.convo.members.map((m) => m.id).filter((id) => !isPlayerCid(id));
  for (let i = movers.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [movers[i], movers[j]] = [movers[j]!, movers[i]!];
  }
  for (const cid of movers) {
    const move = chooseSpeakerMove(w, c.convo, cid, opts, {
      personality: creatureMood(cid),
      relationTo: () => DEFAULT_RELATION,
      rng,
    });
    if (!move) continue;
    const spoken = speakInConversation(w, c.convo, cid, move.act, move.addresseeId, opts, {
      tick: h.taskClock,
      rng,
      personalityOf: creatureMood,
    });
    g.facing = { speakerCid: cid, ...(move.addresseeId ? { addresseeCid: move.addresseeId } : {}) };
    for (const r of spoken.silent) if (r.kind === "turn-away") g.turnedAway.add(r.id);
    g.lastWordsAt = h.taskClock;
    g.dullS = 0;
    g.nextTurnAt = h.taskClock + GROUP_TURN_GAP_S;
    // SAYING GOODBYE IS LEAVING (`speakerActWeight` keeps `bye` on every board).
    if (move.act.kind === "bye") h.departGroup(c, cid);
    return {
      speaker: cid,
      glyph: move.act.glyph,
      ...(spoken.response?.result.responseGlyph ? { reply: spoken.response.result.responseGlyph } : {}),
    };
  }

  g.dullS += GROUP_DULL_RETRY_S;
  g.nextTurnAt = h.taskClock + GROUP_DULL_RETRY_S;
  return null;
}

describe("the turn loop — a circle that actually talks", () => {
  const world = () =>
    createCreatureWorld(
      [
        { id: ADA, needs: [{ itemId: "cookie_1", value: 3 }] },
        { id: BEN },
        { id: CAL },
      ],
      [{ id: "cookie_1", ownerId: BEN }],
    );
  const opts: ProjectionOpts = { symbolOf: (id: string) => id.replace(/_\d+$/, "") };

  const transcript = (turns: number) => {
    const h = town();
    const w = world();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    const out: string[] = [];
    for (let i = 0; i < turns; i++) {
      h.taskClock += GROUP_TURN_GAP_S;
      const said = runTurn(h, w, c, opts);
      out.push(said ? `${said.speaker}|${said.glyph}|${said.reply ?? "—"}` : "…");
    }
    return out;
  };

  it("🚨 the same seed replays the same transcript, line for line", () => {
    const a = transcript(8);
    const b = transcript(8);
    expect(a).toEqual(b);
    expect(a.filter((l) => l !== "…").length).toBeGreaterThan(0);
  });

  it("the conversation ACCUMULATES: seqs advance and the history grows", () => {
    const h = town();
    const w = world();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    for (let i = 0; i < 5; i++) {
      h.taskClock += GROUP_TURN_GAP_S;
      runTurn(h, w, c, opts);
    }
    expect(c.convo.nextSeq).toBeGreaterThan(0);
    expect(c.convo.history.length).toBeGreaterThan(0);
    // Every utterance came from somebody who was in the room — the CAST, not the
    // current roster: history outlives membership, which is law 1 (a member
    // leaving never destroys what the others are using).
    const cast = new Set([ADA, BEN, CAL]);
    for (const u of c.convo.history) expect(cast.has(u.speakerId)).toBe(true);
  });

  it("a third member is addressable — the circle is not two dyads", () => {
    const h = town();
    const w = world();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    const addressed = new Set<string>();
    for (let i = 0; i < 30; i++) {
      h.taskClock += GROUP_TURN_GAP_S;
      runTurn(h, w, c, opts);
      for (const u of c.convo.history) for (const a of u.addresseeIds ?? []) addressed.add(a);
    }
    expect(addressed.size).toBeGreaterThan(1);
  });

  it("a member with nothing to say drops out of the running rather than blocking it", () => {
    // A creature the dialogue world has never heard of returns null from
    // `chooseSpeakerMove` — the mover search steps over it.
    const h = town();
    const w = world();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, "ghost_9"); // no row in the creature world
    h.taskClock += GROUP_TURN_GAP_S;
    const said = runTurn(h, w, c, opts);
    expect(said?.speaker).not.toBe("ghost_9");
  });
});

// ---------------------------------------------------------------------------
// 4. HOW A CIRCLE ENDS
// ---------------------------------------------------------------------------

describe("end conditions — boredom, drift, and being needed elsewhere", () => {
  /** MIRROR of `runGroupTurn`'s boredom arm: the WARMEST member closes it. */
  const warmestCloser = (c: HostConversation): string | undefined => {
    let closer = c.convo.members[0]?.id;
    let best = -Infinity;
    for (const m of c.convo.members) {
      if (isPlayerCid(m.id)) continue;
      const w = creatureMood(m.id).warmth;
      if (w > best) {
        best = w;
        closer = m.id;
      }
    }
    return closer;
  };

  it("dull turns accumulate, and CONV_FORM.boreS is the wall", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    const g = c.group!;
    let beats = 0;
    while (g.dullS < CONV_FORM.boreS) {
      g.dullS += GROUP_DULL_RETRY_S;
      beats++;
    }
    // Three visible beats of nobody speaking, not an instant hang-up.
    expect(beats).toBe(3);
    expect(g.dullS).toBeGreaterThanOrEqual(CONV_FORM.boreS);
  });

  it("the warmest member says the goodbye — the one who minded most that it ended", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    const warmths = c.convo.members.map((m) => [m.id, creatureMood(m.id).warmth] as const);
    const top = [...warmths].sort((a, b) => b[1] - a[1])[0]![0];
    expect(warmestCloser(c)).toBe(top);
  });

  it("dispersal deletes the record, releases the index and cools everyone down", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    h.disperseGroup(c);
    expect(h.conversations.has(c.id)).toBe(false);
    expect(h.convoOfCreature.size).toBe(0);
    for (const cid of [ADA, BEN, CAL]) expect(h.chatCooldown.get(cid)).toBe(CHAT_COOLDOWN);
    expect(h.chatEligible(ADA)).toBe(false); // …so the same circle can't re-form instantly
  });

  it("DRIFT past the leash is a silent leave — the body already left", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    h.bodies.set(CAL, { x: 100, y: 100, r: 0.35 });
    h.sweepGroups(() => 1 - 1e-9);
    expect(c.convo.members.map((m) => m.id)).toEqual([ADA, BEN]);
    expect(c.group!.leaving.has(CAL)).toBe(false); // no goodbye owed by an absent body
    expect(h.convoOfCreature.has(CAL)).toBe(false);
  });

  it("…and the leash is `driftLeaveM`, not a step of thinking", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    const g = c.group!;
    h.bodies.set(CAL, { x: g.anchor.x + CONV_FORM.driftLeaveM - 0.5, y: g.anchor.y, r: 0.35 });
    h.sweepGroups(() => 1 - 1e-9);
    expect(c.convo.members.map((m) => m.id)).toContain(CAL);
  });

  it("⑫ — BEING NEEDED ELSEWHERE IS NO LONGER AN EVICTION (the law that changed)", () => {
    // Until ⑫ this earned an immediate goodbye: any member with an errand was
    // marked `leaving` on the next sweep. That made "working while talking"
    // impossible by construction — a companion who took one step to catch up was
    // thrown out of the conversation it was walking in. Now it simply stays; what
    // being busy costs is paid in the argmax and in the floor its lines land on.
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    h.npcTasks.set(CAL, 1); // a need pulled it onto an errand
    h.sweepGroups(() => 1 - 1e-9);
    expect(c.group!.leaving.has(CAL)).toBe(false);
    expect(c.convo.members.map((m) => m.id)).toContain(CAL);

    // …and its next turn is an ordinary one, not a bye.
    const w = createCreatureWorld([{ id: ADA }, { id: BEN }, { id: CAL }], []);
    const said = runTurn(h, w, c, { symbolOf: (id: string) => id });
    expect(said?.glyph).not.toBe("goodbye");
    expect(c.convo.members.map((m) => m.id)).toContain(CAL);
  });

  it("⑫ — THE CIRCLE FOLLOWS ITS PEOPLE: the anchor eases toward the centroid", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    const g = c.group!;
    const start = { ...g.anchor };
    // Both walk east together — a stroll, not a departure.
    h.bodies.set(ADA, { x: start.x + 6, y: start.y, r: 0.35 });
    h.bodies.set(BEN, { x: start.x + 6, y: start.y + 1, r: 0.35 });
    for (let i = 0; i < 60; i++) h.stepGroupAnchor(c, 1 / 30);
    expect(g.anchor.x).toBeGreaterThan(start.x + 4);
  });

  it("⑫ — …so a strolling pair is NEVER ejected for strolling", () => {
    // The bug this fixes: with a pinned anchor, walking 8 m in any direction was
    // indistinguishable from abandoning the conversation.
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    const g = c.group!;
    const far = CONV_FORM.driftLeaveM + 5;
    for (let step = 1; step <= 20; step++) {
      const x = (far / 20) * step;
      h.bodies.set(ADA, { x, y: 0, r: 0.35 });
      h.bodies.set(BEN, { x, y: 1, r: 0.35 });
      for (let i = 0; i < 15; i++) h.stepGroupAnchor(c, 1 / 30);
      h.sweepGroups(() => 1 - 1e-9);
    }
    expect(c.convo.members.map((m) => m.id)).toEqual([ADA, BEN]);
  });

  it("⑫ — the anchor does NOT jitter with a sidestep (it is eased, not snapped)", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    const g = c.group!;
    const before = { ...g.anchor };
    h.bodies.set(ADA, { x: before.x + 0.4, y: before.y, r: 0.35 }); // one shuffle
    h.stepGroupAnchor(c, 1 / 30);
    expect(Math.hypot(g.anchor.x - before.x, g.anchor.y - before.y)).toBeLessThan(0.02);
  });

  it("⑫ — STATION-KEEPING walks an IDLE straggler back, and leaves a BUSY one alone", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    const g = c.group!;
    // Both are far from the anchor; only one of them has nothing else to do.
    h.bodies.set(CAL, { x: g.anchor.x + 6, y: g.anchor.y, r: 0.35 });
    h.bodies.set(BEN, { x: g.anchor.x - 6, y: g.anchor.y, r: 0.35 });
    h.npcTasks.set(BEN, 1); // BEN's legs are spoken for — its errand is its own business
    const walked = h.stepGroupAnchor(c, 1 / 30);
    expect(walked).toContain(CAL);
    expect(walked).not.toContain(BEN);
  });

  it("⑫ — a member already inside the band is never made to walk", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    expect(h.stepGroupAnchor(c, 1 / 30)).toEqual([]);
  });

  it("a member marked `leaving` still gets the floor for its goodbye", () => {
    // The leaver branch itself is unchanged — only what puts somebody INTO the
    // set changed (⑧ will make it an outbid deadline). Pin the branch directly so
    // the goodbye path stays covered while its trigger moves.
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    c.group!.leaving.add(CAL);
    const w = createCreatureWorld([{ id: ADA }, { id: BEN }, { id: CAL }], []);
    const said = runTurn(h, w, c, { symbolOf: (id: string) => id });
    expect(said).toEqual({ speaker: CAL, glyph: "goodbye" });
    expect(c.convo.members.map((m) => m.id)).toEqual([ADA, BEN]);
  });

  it("SAYING GOODBYE IS LEAVING — nobody stands there after their own bye", () => {
    const h = town();
    const w = createCreatureWorld([{ id: ADA }, { id: BEN }, { id: CAL }], []);
    const c = h.openGroup(ADA, BEN)!;
    h.seatMember(c, CAL);
    // Drive it through the mirrored turn path: the leaver arm fires the same bye
    // an idle speaker's own board would have offered.
    c.group!.leaving.add(CAL);
    const said = runTurn(h, w, c, { symbolOf: (id: string) => id });
    expect(said).toEqual({ speaker: CAL, glyph: "goodbye" });
    expect(c.convo.members.map((m) => m.id)).not.toContain(CAL);
    expect(h.convoOfCreature.has(CAL)).toBe(false);
  });

  it("a roster under two is not a conversation", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.departGroup(c, BEN);
    expect(h.conversations.has(c.id)).toBe(false);
    expect(h.convoOfCreature.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. ACTS EXECUTE — and the ONE guard that survives
// ---------------------------------------------------------------------------

describe("puzzle integrity — the item-class guard that replaced CHAT_SAFE_ACTS", () => {
  /** MIRROR of `isPuzzleItem` — `convItems` is the staged cast of an authored
   *  game (the cookie to find, the vendor's stock, the quest gift). */
  const isPuzzleItem = (convItems: Array<{ entityId: string }>, entityId: string) =>
    convItems.some((i) => i.entityId === entityId);

  /** MIRROR of `applyGroupEvents` — the filter, and what survives it. */
  const applied = (convItems: Array<{ entityId: string }>, events: CreatureEvent[]) => {
    const moved: string[] = [];
    const fulfilled: string[] = [];
    for (const event of events) {
      if (event.type === "item-transferred" || event.type === "transfer-pending") {
        if (isPuzzleItem(convItems, event.itemId)) continue;
        if (event.type === "transfer-pending") continue;
        if (event.to) moved.push(event.itemId);
      } else if (event.type === "need-fulfilled") {
        fulfilled.push(event.creatureId);
      }
    }
    return { moved, fulfilled };
  };

  const staged = [{ entityId: "cookie_1" }]; // the quest cookie

  it("🚨 a quest item NEVER moves on its own, however the act was phrased", () => {
    const out = applied(staged, [
      { type: "item-transferred", itemId: "cookie_1", from: ADA, to: BEN },
      { type: "transfer-pending", itemId: "cookie_1", from: ADA, to: BEN },
    ]);
    expect(out.moved).toEqual([]);
  });

  it("…and an ORDINARY item does — which is the whole point of decision 4", () => {
    const out = applied(staged, [{ type: "item-transferred", itemId: "bread_7", from: ADA, to: BEN }]);
    expect(out.moved).toEqual(["bread_7"]);
  });

  it("a need answered by a neighbour is a need FULFILLED, puzzle item or not", () => {
    const out = applied(staged, [{ type: "need-fulfilled", creatureId: BEN, itemId: "bread_7", value: 2 }]);
    expect(out.fulfilled).toEqual([BEN]);
  });

  it("a released item (no receiver) is not a hand-over", () => {
    const out = applied([], [{ type: "item-transferred", itemId: "bread_7", from: ADA, to: null }]);
    expect(out.moved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. FOCUS — which conversation the camera holds and the TTS voices
// ---------------------------------------------------------------------------

describe("publishConversationFocus — one answer for the camera and the voice", () => {
  it("THE PLAYER'S OWN CONVERSATION ALWAYS WINS, silent or not", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    c.group!.lastWordsAt = h.taskClock; // a lively circle, right there
    h.open("resident_2_2"); // …and the child is mid-exchange elsewhere
    expect(h.publishFocus({ x: 1, y: 0 })).toBe("resident_2_2");
  });

  it("with the player in none of them, the NEAREST circle with words on screen wins", () => {
    const h = town();
    const near = h.openGroup(ADA, BEN)!;
    h.bodies.set(CAL, { x: 40, y: 0, r: 0.35 });
    h.bodies.set(DOT, { x: 42, y: 0, r: 0.35 });
    const far = h.openGroup(CAL, DOT)!;
    near.group!.lastWordsAt = h.taskClock;
    far.group!.lastWordsAt = h.taskClock;
    expect(h.publishFocus({ x: 0, y: 0 })).toBe(near.id);
    expect(h.publishFocus({ x: 41, y: 0 })).toBe(far.id);
  });

  it("a circle that has said NOTHING for focusHoldS is over as far as the camera cares", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.taskClock = CONV_FORM.focusHoldS + 1;
    expect(h.publishFocus({ x: 0, y: 0 })).toBeNull();
    c.group!.lastWordsAt = h.taskClock;
    expect(h.publishFocus({ x: 0, y: 0 })).toBe(c.id);
  });

  it("an empty square focuses on NOTHING — a real answer, not a least-bad option", () => {
    const h = town();
    expect(h.publishFocus({ x: 0, y: 0 })).toBeNull();
  });

  it("🚨 THE MUTE RULE IS PRESENTATION: the circle keeps running, it just goes quiet", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    c.group!.lastWordsAt = h.taskClock;
    h.publishFocus({ x: 0, y: 0 });
    expect(h.groupVoiceOn(c, false)).toBe(true);
    // A board open on this device silences the VOICE and nothing else — the
    // record, the roster and the turn clock are all untouched by a screen.
    expect(h.groupVoiceOn(c, true)).toBe(false);
    expect(h.conversations.has(c.id)).toBe(true);
    expect(c.group!.nextTurnAt).toBe(0);
  });

  it("an UNFOCUSED circle is seen and not heard", () => {
    const h = town();
    const near = h.openGroup(ADA, BEN)!;
    h.bodies.set(CAL, { x: 40, y: 0, r: 0.35 });
    h.bodies.set(DOT, { x: 42, y: 0, r: 0.35 });
    const far = h.openGroup(CAL, DOT)!;
    near.group!.lastWordsAt = h.taskClock;
    far.group!.lastWordsAt = h.taskClock;
    h.publishFocus({ x: 0, y: 0 });
    expect(h.groupVoiceOn(near, false)).toBe(true);
    expect(h.groupVoiceOn(far, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. THE INDEX — one conversation per creature, anywhere
// ---------------------------------------------------------------------------

describe("convoOfCreature — the law made checkable", () => {
  it("seating a creature that was talking elsewhere MOVES it; it is never in two", () => {
    const h = town();
    const first = h.openGroup(ADA, BEN)!;
    const second = h.openGroup(CAL, DOT)!;
    h.seatMember(second, ADA);
    expect(first.convo.members.map((m) => m.id)).toEqual([BEN]);
    expect(second.convo.members.map((m) => m.id)).toContain(ADA);
    expect(h.convoOfCreature.get(ADA)).toBe(second.id);
  });

  it("a player opening a board on a circle's member JOINS that circle (⑩)", () => {
    // MIRROR of `conversationWith`'s ⑩ arm — the reversal of ⑧, which pulled the
    // creature OUT and dispersed what was left. Walking up to a group of people
    // talking is joining them.
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    const board = h.open(ADA);
    expect(board).toBe(g); // 🚨 the board IS the circle's own record
    expect(h.conversations.has(g.id)).toBe(true); // …and nobody was pulled out of it
    expect(g.convo.members.map((m) => m.id)).toEqual([ADA, BEN, LOCAL_PLAYER_CID].sort());
    expect(h.convoOfCreature.get(ADA)).toBe(g.id);
    expect(h.convoOfCreature.get(LOCAL_PLAYER_CID)).toBe(g.id);
  });

  it("a group record's id is NEVER reused, so the camera latch cannot be fooled", () => {
    const h = town();
    const a = h.openGroup(ADA, BEN)!;
    h.disperseGroup(a);
    h.chatCooldown.clear();
    const b = h.openGroup(ADA, BEN)!;
    expect(b.id).not.toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// 8. ⑩ — THE PLAYER IN THE CIRCLE
//
// The laws phase ⑩ adds to a group record: the player JOINS instead of pulling
// somebody out, the view and the record stop being the same string, the gaze
// picks whom they are talking to inside the roster, and going quiet lapses their
// MEMBERSHIP rather than ending the conversation.
// ---------------------------------------------------------------------------

describe("⑩ joining a circle — the board is the circle's own record", () => {
  it("the VIEW faces the creature the child chose; the RECORD is the whole circle", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(BEN); // …the child walked up to Ben, not to the opener
    expect(h.convoView).toEqual({ cid: BEN, convoId: g.id });
    expect(h.convoView!.cid).not.toBe(h.convoView!.convoId); // 🚨 no longer one string
    expect(h.viewRecord()).toBe(g);
    // …and `id === nodeId` still holds for everything a player OPENED, which is
    // why every ⑥–⑨ path is byte-identical.
    const h2 = town();
    const dyad = h2.open(CAL);
    expect(h2.convoView).toEqual({ cid: CAL, convoId: CAL });
    expect(dyad.id).toBe(dyad.nodeId);
  });

  it("the faced creature is remembered PER AUTHOR — two children, two boards", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    const ben = playerCidOf("person-ben", "person-ann");
    h.conversationWith(ADA, LOCAL_PLAYER_CID);
    h.conversationWith(BEN, ben);
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(ADA);
    expect(h.facedBy(g, ben)).toBe(BEN);
    expect(g.convo.members.map((m) => m.id).sort()).toEqual([ADA, BEN, LOCAL_PLAYER_CID, ben].sort());
  });

  it("an EMBODIED player takes a ring slot; a formless spirit takes none", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    expect(g.group!.slots.has(LOCAL_PLAYER_CID)).toBe(true);

    const s = town();
    s.embodied = false; // a spirit — there is nothing standing there
    const g2 = s.openGroup(ADA, BEN)!;
    s.open(ADA);
    expect(g2.group!.slots.has(LOCAL_PLAYER_CID)).toBe(false);
    expect(g2.convo.members.map((m) => m.id)).toContain(LOCAL_PLAYER_CID); // …but still IN it
  });

  it("re-opening the same circle on a DIFFERENT member does not re-face the player", () => {
    // Re-facing is the `address` cell's job, not a side effect of a second
    // `conversationWith` — the record is already this member's.
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    const slots = g.group!.slots.size;
    h.conversationWith(BEN, LOCAL_PLAYER_CID);
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(ADA);
    expect(g.group!.slots.size).toBe(slots); // …and no second seat is reserved
  });

  it("the circle's turn loop carries on with the player seated — and never speaks FOR them", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    const movers = g.convo.members.map((m) => m.id).filter((id) => !isPlayerCid(id));
    expect(movers.sort()).toEqual([ADA, BEN].sort());
    expect(movers).not.toContain(LOCAL_PLAYER_CID);
  });

  it("a player is NEVER cooled down — a cooldown is a creature's rest from being drafted", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    h.departGroup(g, LOCAL_PLAYER_CID);
    expect(h.chatCooldown.has(LOCAL_PLAYER_CID)).toBe(false);
    expect(h.chatCooldown.has(ADA)).toBe(false); // …and the circle carried on
    expect(h.conversations.has(g.id)).toBe(true);
  });
});

describe("⑩ the sync round-trip through convoOfCreature", () => {
  it("the message is keyed on the creature THAT MEMBER faces, not on the record", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    const ben = playerCidOf("person-ben", "person-ann");
    h.conversationWith(BEN, ben); // Ben's device dwelled on BEN
    // A follower matches an inbound sync against the board it has open, so a
    // message keyed on the circle's id (or on its opener) would look like
    // somebody else's conversation and freeze exactly the board it is meant to
    // move.
    expect(h.syncKeyFor(g, ben)).toBe(BEN);
    expect(h.syncKeyFor(g, ben)).not.toBe(g.id);
    expect(h.syncKeyFor(g, ben)).not.toBe(g.nodeId);
  });

  it("a player-opened record keys on its own creature, exactly as ⑥ did", () => {
    const h = town();
    const c = h.open(CAL);
    expect(h.syncKeyFor(c, LOCAL_PLAYER_CID)).toBe(CAL);
    expect(h.syncKeyFor(c, LOCAL_PLAYER_CID)).toBe(c.id);
  });

  it("the faced creature LEAVING re-aims the board at whoever is still there", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    h.departGroup(g, ADA); // Ada wanders off mid-conversation
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(BEN); // …not a hole
    expect(h.syncKeyFor(g, LOCAL_PLAYER_CID)).toBe(BEN);
  });
});

describe("⑩ convoAddressee — the gaze picks the partner inside the roster", () => {
  const seated = () => {
    const h = town();
    h.bodies.set(CAL, { x: 1, y: 1, r: 0.35 });
    const g = h.openGroup(ADA, BEN)!;
    h.seatMember(g, CAL);
    h.open(ADA);
    return { h, g };
  };

  it("addressing a fellow member changes WHOM the next thing said is said to", () => {
    const { h, g } = seated();
    // ⑫③ — with nothing spent on a channel, a 4-person circle addresses NOBODY:
    // the line goes to the floor. (Under ⑩ the faced creature answered here,
    // which is what made addressing free.) The board's aim is unmoved either way.
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBeNull();
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(ADA);
    h.setConvoAddressee(BEN);
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(BEN);
    // …and NOTHING was handed anywhere: the roster is exactly what it was.
    expect(g.convo.members.map((m) => m.id).sort()).toEqual([ADA, BEN, CAL, LOCAL_PLAYER_CID].sort());
    expect(h.convoView!.cid).toBe(ADA); // the board still faces who it faced
  });

  it("addressing somebody who is NOT in the roster is refused", () => {
    const { h, g } = seated();
    h.setConvoAddressee(DOT); // across town, in no conversation at all
    expect(h.convoAddressee).toBeNull();
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBeNull();
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(ADA); // …and the board is untouched
  });

  it("it CLEARS when that member leaves the roster", () => {
    const { h, g } = seated();
    h.setConvoAddressee(BEN);
    h.departGroup(g, BEN);
    expect(h.liveConvoAddressee()).toBeNull();
    expect(h.convoAddressee).toBeNull();
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBeNull(); // …back to the floor
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(ADA);
  });

  it("…and when the board closes or switches", () => {
    const { h } = seated();
    h.setConvoAddressee(BEN);
    h.closeConvoView();
    expect(h.convoAddressee).toBeNull();

    const { h: h2 } = seated();
    h2.setConvoAddressee(BEN);
    h2.open(DOT); // a switch to somebody in another conversation entirely
    expect(h2.convoAddressee).toBeNull();
  });

  it("a VOCATIVE preempts it — a spoken name beats the gaze-set addressee", () => {
    // MIRROR of `applySpokenSentence`'s resolution and the override it hands to
    // `runCreatureAct`: vocative > relayed target > convoAddressee > the board's
    // creature. This is the GESTURE the utterance carries, and its bottom rung is
    // `convoView.cid` — a spoken sentence must reach somebody or it is not a
    // conversational move at all. ⑫③ changed the rung under a BOARD PRESS
    // (`memberAddressee`), not this one.
    const { h, g } = seated();
    h.setConvoAddressee(BEN);
    const resolve = (vocative: string | null, relayed: string | null) =>
      vocative ?? relayed ?? h.liveConvoAddressee() ?? h.convoView!.cid;
    expect(resolve(CAL, null)).toBe(CAL); // 🚨 the name wins
    expect(resolve(null, CAL)).toBe(CAL); // a relayed target too
    expect(resolve(null, null)).toBe(BEN); // …and otherwise the gaze stands
    h.convoAddressee = null;
    expect(resolve(null, null)).toBe(ADA); // …and under that, the board's creature
    // The resolved addressee travels WITH the turn, so nothing downstream
    // re-resolves it out from under the name.
    h.setConvoAddressee(BEN);
    const override = resolve(CAL, null);
    expect(override ?? h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(CAL);
  });

  it("⑫③ a DYAD needs none of this — the exemption answers before the echo does", () => {
    // Law ④: with one other person there is nothing to disambiguate, so the
    // whole mechanism above is skipped and ⑦'s answer is byte-identical.
    const h = town();
    const c = h.open(CAL);
    expect(h.memberAddressee(c, LOCAL_PLAYER_CID)).toBe(CAL);
    expect(h.memberAddressee(c, CAL)).toBe(LOCAL_PLAYER_CID);
  });
});

describe("⑩ idle lapses MEMBERSHIP in a circle, and closes a dyad", () => {
  it("the circle carries on without the idle player", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    h.lapseConvoMembership();
    expect(h.conversations.get(g.id)).toBe(g); // 🚨 still talking
    expect(g.convo.members.map((m) => m.id).sort()).toEqual([ADA, BEN].sort());
    expect(g.group!.slots.has(LOCAL_PLAYER_CID)).toBe(false); // the ring closed
    expect(h.convoView).toBeNull();
    expect(h.convoAddressee).toBeNull();
  });

  it("a DYAD keeps today's close — nothing was happening in it but the child", () => {
    const h = town();
    const c = h.open(CAL);
    h.lapseConvoMembership();
    expect(h.convoView).toBeNull();
    expect(h.conversations.has(c.id)).toBe(false);
  });

  it("the LAST creature leaving a joined circle ends it — a ring of one is not a conversation", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    h.departGroup(g, ADA);
    expect(h.conversations.has(g.id)).toBe(true); // Ben and the child are still here
    h.departGroup(g, BEN);
    expect(h.conversations.has(g.id)).toBe(false);
    expect(h.convoView).toBeNull(); // …and the board went with it
  });
});

describe("⑩ conversationSpent — the group-guard refinement", () => {
  it("a circle with a player in it is NOT spent while there is somebody to talk to", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    expect(h.spent(g)).toBe(false);
  });

  it("an ALL-NPC circle is never this predicate's business — its own dynamics end it", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    expect(h.spent(g)).toBe(false);
    leaveConversation(g.convo, BEN); // …even a roster the sweep has emptied
    expect(h.spent(g)).toBe(false);
  });

  it("🚨 an author left standing in an EMPTY ring is spent — nobody is left to talk to", () => {
    const h = town();
    const g = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    // Both creatures drift off between sweeps, straight out of the roster: no
    // turn ever runs there again, so nothing else would end this record.
    leaveConversation(g.convo, ADA);
    leaveConversation(g.convo, BEN);
    expect(h.spent(g)).toBe(true);
    expect(h.sweep(g)).toBe(false); // …but never out from under the open board
    h.closeConvoView();
    expect(h.sweep(g)).toBe(true);
  });
});

describe("⑩ the mute rule, once the child has joined", () => {
  it("a circle the player is IN stays voiced with their board open", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    c.group!.lastWordsAt = h.taskClock;
    h.open(ADA);
    h.publishFocus({ x: 0, y: 0 });
    expect(h.focusedConvoId).toBe(c.id); // the roster wins the focus
    expect(h.groupVoiceOn(c, true)).toBe(true); // 🚨 …and the board does not mute it
  });

  it("a circle the player is NOT in still goes quiet while a board is up", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    c.group!.lastWordsAt = h.taskClock;
    h.publishFocus({ x: 0, y: 0 });
    expect(h.groupVoiceOn(c, false)).toBe(true);
    expect(h.groupVoiceOn(c, true)).toBe(false);
  });

  it("the focus candidate for a joined circle is published ONCE, not twice", () => {
    const h = town();
    const c = h.openGroup(ADA, BEN)!;
    h.open(ADA);
    const cands = h.focusCandidates({ x: 0, y: 0 });
    expect(cands.filter((x) => x.id === c.id)).toHaveLength(1);
    expect(cands[0]!.hasLocalPlayer).toBe(true);
  });
});
