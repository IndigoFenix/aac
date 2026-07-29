// shared/world-engine/interaction/content/quote.ts
//
// The Quote binder (§6.2) and symbol-resolution worklist (§6.5).
//
// Binding order is load-bearing: bind slots → FREEZE → (distractors / compile)
// → certify. One binding is shared across a whole exchange (prompt + every
// response) so that minimal-pair distractors vary only the slot under test.

import { getVocabularyItem } from "@shared/glyph-registry.js";
import { parseGlyph } from "@shared/glyph-compositor.js";
import type {
  BoundQuote,
  PoolDef,
  PoolMember,
  Quote,
  QuoteExchange,
  SlotBinding,
  SymbolResolution,
} from "@shared/world-engine/interaction/types.js";

const SLOT_RE = /\{(\w+)\}/g;

/** A strategy for choosing which pool member fills a slot. */
export type MemberPicker = (pool: PoolDef) => PoolMember;

/** Deterministic picker (always the first member) — used by tests and previews. */
export const firstMemberPicker: MemberPicker = (pool) => {
  const m = pool.members[0];
  if (!m) throw new Error(`pool "${pool.id}" has no members`);
  return m;
};

/** Default random picker for live instances (variety across instances). */
export const randomMemberPicker: MemberPicker = (pool) => {
  if (!pool.members.length) throw new Error(`pool "${pool.id}" has no members`);
  const i = Math.floor(Math.random() * pool.members.length);
  return pool.members[i]!;
};

/** Slot names referenced by a glyph template (`{treat}` → "treat"), in order, deduped. */
export function templateSlots(glyph: string): string[] {
  const out: string[] = [];
  for (const m of glyph.matchAll(SLOT_RE)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * Freeze one binding for a set of slot names by drawing from the pools. Constant
 * across the whole option set for the instance (§6.2).
 */
export function bindSlots(
  slots: string[],
  pools: Record<string, PoolDef>,
  pick: MemberPicker = randomMemberPicker,
): SlotBinding {
  const binding: SlotBinding = {};
  for (const slot of slots) {
    const pool = pools[slot];
    if (!pool) throw new Error(`no pool for slot "{${slot}}"`);
    binding[slot] = pick(pool);
  }
  return binding;
}

/** Substitute a frozen binding into a quote's template, producing a concrete glyph SENTENCE. */
export function resolveGlyph(quote: Quote, binding: SlotBinding): string {
  const resolved = quote.glyph.replace(SLOT_RE, (_full, slot: string) => {
    const member = binding[slot];
    if (!member) throw new Error(`quote "${quote.id}" references unbound slot "{${slot}}"`);
    return member.symbol;
  });
  return quote.operator ? `${resolved}#${quote.operator}` : resolved;
}

/** Bind one quote against an already-frozen binding. */
export function bindQuote(quote: Quote, binding: SlotBinding): BoundQuote {
  return { quote, binding, glyph: resolveGlyph(quote, binding) };
}

/** A whole exchange bound under ONE shared frozen binding (the freeze invariant). */
export interface BoundExchange {
  exchange: QuoteExchange;
  binding: SlotBinding;
  prompt: BoundQuote;
  responses: { bound: BoundQuote; correct?: boolean }[];
}

/**
 * Bind an exchange: freeze one binding over the union of all slots used by the
 * prompt and every response, then resolve each quote against it.
 */
export function bindExchange(
  exchange: QuoteExchange,
  pools: Record<string, PoolDef>,
  pick: MemberPicker = randomMemberPicker,
): BoundExchange {
  const allSlots: string[] = [];
  for (const q of [exchange.prompt, ...exchange.responses.map((r) => r.quote)]) {
    for (const s of templateSlots(q.glyph)) if (!allSlots.includes(s)) allSlots.push(s);
  }
  const binding = bindSlots(allSlots, pools, pick);
  return {
    exchange,
    binding,
    prompt: bindQuote(exchange.prompt, binding),
    responses: exchange.responses.map((r) => ({ bound: bindQuote(r.quote, binding), correct: r.correct })),
  };
}

/** The SYMBOLs a concrete glyph SENTENCE references (heads + modifiers + payloads), deduped. */
export function requiredSymbols(glyph: string): string[] {
  const parsed = parseGlyph(glyph);
  const out: string[] = [];
  const push = (k?: string) => {
    if (k && !out.includes(k)) out.push(k);
  };
  for (const slot of parsed.slots) {
    push(slot.key);
    for (const mod of slot.modifiers) push(mod);
    push(slot.payload);
  }
  return out;
}

/**
 * Check every SYMBOL a bound quote references against the registry (§6.5). The
 * registry is authoritative: a symbol present there is `resolved` regardless of
 * any glyphStatus. A not-in-registry symbol is `queued` when it's declared
 * (a bound pool member with glyphStatus "queued", or in quote.queuedSymbols),
 * else `missing` — an authoring error.
 */
export function resolveBoundSymbols(bound: BoundQuote): SymbolResolution {
  const declaredQueued = new Set<string>(bound.quote.queuedSymbols ?? []);
  for (const member of Object.values(bound.binding)) {
    if (member.glyphStatus === "queued") declaredQueued.add(member.symbol);
  }
  const res: SymbolResolution = { resolved: [], queued: [], missing: [] };
  for (const sym of requiredSymbols(bound.glyph)) {
    if (getVocabularyItem(sym)) res.resolved.push(sym);
    else if (declaredQueued.has(sym)) res.queued.push(sym);
    else res.missing.push(sym);
  }
  return res;
}

/**
 * The "symbols this game still needs" build artifact (§6.5): every declared
 * SYMBOL across the given pools + exchanges that isn't in the registry yet.
 * Members/quotes that drifted (declared queued but actually ship) are dropped,
 * since the registry is authoritative.
 */
export function symbolWorklist(
  pools: Record<string, PoolDef>,
  exchanges: QuoteExchange[],
): string[] {
  const candidates = new Set<string>();
  for (const pool of Object.values(pools)) {
    for (const m of pool.members) if (m.glyphStatus === "queued") candidates.add(m.symbol);
  }
  for (const ex of exchanges) {
    for (const q of [ex.prompt, ...ex.responses.map((r) => r.quote)]) {
      for (const s of q.queuedSymbols ?? []) candidates.add(s);
    }
  }
  return [...candidates].filter((s) => !getVocabularyItem(s)).sort();
}
