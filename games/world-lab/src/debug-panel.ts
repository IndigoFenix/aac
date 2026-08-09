// games/world-lab/src/debug-panel.ts
//
// A dev-only creature/session READOUT that shares the LEFT column with the world-JSON
// editor via TABS (World / Debug), truly PAUSES the sim (host.setPaused → world dt=0),
// and LINKS on-screen objects to their data: clicking an object in the game jumps to and
// flashes its entity in the readout. World-lab bench only — never shipped to the app.

import type { QuestHost3D, QuestSession } from "@shared/world-engine/interaction/quest/quest-host";
import {
  inspectCreature,
  inspectRoster,
  summarizeCreature,
  type CreatureInspection,
  type InspectProbes,
} from "@shared/world-engine/interaction/quest/creature-inspect";

const host = (): QuestHost3D | null =>
  (window as unknown as { __questLab?: QuestHost3D }).__questLab ?? null;

/** THE PROBE BUNDLE, wired from the host's EXISTING read-only surface — no new
 *  sim state, no mutation. Rebuilt per call because `__questLab` is replaced on
 *  every world reload. */
const probesOf = (h: QuestHost3D | null): InspectProbes => ({
  state: h?.world?.state ?? null,
  activityOf: (cid) => h?.activityOf(cid),
  whyProbe: (cid) => h?.whyProbe(cid),
  carryOf: (cid) => h?.carryOf(cid) ?? {},
  nameOf: (cid) => h?.nameOf(cid),
  errandPath: (avatarId) => h?.world?.npcErrandPath(avatarId) ?? null,
});

/** ⏱️ THE OPEN ROW REFRESHES AT ~1 Hz, NOT PER RENDER. The list re-renders every
 *  400 ms; a why-chain walk plus a place-word lookup per creature per tick would
 *  be pure waste (and `reasonChainOf` is the most expensive read in the host).
 *  So a detail block is CACHED per creature and recomputed only when stale. */
const DETAIL_REFRESH_MS = 1000;

const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  parent.appendChild(n);
  return n;
};

/** An on-screen entity id → the creature id it belongs to (avatar bodies are
 *  `npc_<cid>`; residents/objects are bare). */
const cidOf = (rawId: string): string => (rawId.startsWith("npc_") ? rawId.slice(4) : rawId);

/** EVERY outstanding order in the world, by channel — the whole "who is meant to
 *  be doing what, and on whose say-so" at a glance. */
function outstandingTasks(session: QuestSession): Record<string, unknown> {
  const pool = session.taskPool;
  return {
    pursuits: Object.fromEntries(
      [...session.pursuits].map(([cid, p]) => [cid, `[${p.source}] ${p.goal.kind} — "${p.glyph}" (acts ${p.acts ?? 0})`]),
    ),
    acting: Object.fromEntries(
      [...session.actionHold].map(([cid, h]) => [cid, `${h.label} @ ${Math.round((h.t / h.dur) * 100)}%`]),
    ),
    poolOpen: pool?.open().map((t) => `"${t.sourceGlyph ?? t.goal.kind}" [${t.goal.kind}] from ${t.issuer}`) ?? [],
    poolClaimed: pool?.claimed().map((t) => `"${t.sourceGlyph ?? t.goal.kind}" ← ${t.claimedBy}`) ?? [],
    help: Object.fromEntries([...session.helpOrders].map(([helper, wanter]) => [helper, `helps ${wanter}`])),
    rules: (session.goals?.rules ?? []).map(
      (r) => `${JSON.stringify(r.binding)} ${r.lifetime} ${JSON.stringify(r.trigger)} → ${r.action.kind}`,
    ),
    blocked: Object.fromEntries([...session.blockedNeeds].map(([cid, b]) => [cid, `${b.goodKey} (${b.tplKey})`])),
  };
}

/** Items the creature-world says this creature OWNS (as opposed to carries) —
 *  the one reading `inspectCreature` deliberately leaves to the caller, because
 *  it is a creature-world question rather than a body question. */
function ownedItemsOf(session: QuestSession, cid: string): string[] {
  const world = session.creatures?.world;
  return world
    ? Object.values(world.items)
        .filter((it) => it.ownerId === cid)
        .map((it) => `${it.kind ?? it.id}${(it.states ?? []).length ? `.${it.states.join(".")}` : ""}`)
    : [];
}

/** PAINT ONE EXPANDED ROW: the labelled detail lines, then the why-chain as its
 *  clause list, then the raw entity JSON behind a nested fold. Read-only — every
 *  value came out of `inspectCreature`, which only ever `get`s.
 *
 *  `openRaw` is the caller's view-local memory of which raw folds are open: the
 *  400 ms re-render throws this DOM away, and a fold that slams shut twice a
 *  second is the very complaint this section exists to fix. */
function paintDetail(
  parent: HTMLElement,
  session: QuestSession,
  ins: CreatureInspection,
  openRaw: Set<string>,
) {
  const box = mk("div", "lab-debug-detail", parent);
  for (const row of ins.rows) {
    const line = mk("div", "lab-debug-kv", box);
    mk("b", "", line).textContent = `${row.label}: `;
    line.append(row.value);
  }
  const owned = ownedItemsOf(session, ins.cid);
  if (owned.length) {
    const line = mk("div", "lab-debug-kv", box);
    mk("b", "", line).textContent = "owns: ";
    line.append(owned.join(", "));
  }
  // THE WHY-CHAIN, as the ladder it is: one rung per line, in the order
  // `reasonChainOf` walked them (activity → because → authority/motive → end).
  const why = mk("div", "lab-debug-why", box);
  mk("b", "", why).textContent = "why:";
  if (ins.why.length) {
    const list = mk("ol", "lab-debug-why-list", why);
    for (const rung of ins.why) mk("li", "", list).textContent = rung;
  } else {
    why.append(" (no chain — the host can't read one)");
  }
  const raw = mk("details", "lab-debug-c", box) as HTMLDetailsElement;
  raw.open = openRaw.has(ins.cid);
  mk("summary", "", raw).textContent = "raw entity";
  mk("pre", "", raw).textContent = JSON.stringify(
    session.creatures?.world.creatures[ins.cid] ?? null,
    null,
    2,
  );
  raw.addEventListener("toggle", () => {
    if (raw.open) openRaw.add(ins.cid);
    else openRaw.delete(ins.cid);
  });
}

export interface DebugPanel {
  dispose(): void;
}

export function mountDebugPanel(): DebugPanel {
  const layout = document.getElementById("layout");
  const fileEl = document.getElementById("world-file") as HTMLElement | null;
  const viewEl = document.getElementById("view");
  if (!layout || !fileEl) return { dispose() {} };

  // Left-column wrapper: a tab bar over the world-JSON OR the debug readout.
  const leftCol = mk("div", "lab-left", layout);
  layout.insertBefore(leftCol, fileEl);
  const tabs = mk("div", "lab-tabs", leftCol);
  const worldTab = mk("button", "lab-tab", tabs);
  worldTab.textContent = "World";
  const debugTab = mk("button", "lab-tab", tabs);
  debugTab.textContent = "🐞 Debug";
  leftCol.appendChild(fileEl); // move the world-JSON into the wrapper (id preserved)

  const panel = mk("div", "lab-debug", leftCol);
  const head = mk("div", "lab-debug-head", panel);
  const pauseLabel = mk("label", "lab-debug-ctl", head);
  const pauseChk = mk("input", "", pauseLabel) as HTMLInputElement;
  pauseChk.type = "checkbox";
  pauseLabel.append(" pause");
  const refreshBtn = mk("button", "lab-debug-ctl", head);
  refreshBtn.textContent = "⟳";
  const clickedEl = mk("span", "lab-debug-clicked", head);
  const body = mk("div", "lab-debug-body", panel);

  let timer: ReturnType<typeof setInterval> | null = null;
  let clickedId: string | null = null; // the last on-screen entity clicked
  /** 👁️ VIEW-LOCAL EXPANSION STATE. Which rows the reader has opened is a fact
   *  about this panel, never about the sim — nothing here is written back, and
   *  a world reload simply drops it. It survives the 400 ms re-render because it
   *  lives out here rather than in the DOM the render throws away. */
  const openCids = new Set<string>();
  /** Creatures the reader CLICKED that the named roster doesn't carry (an
   *  ambient townsperson). Pinning them keeps the crowd a statistic by default
   *  while still letting one be singled out — also view-local. */
  const pinnedCids = new Set<string>();
  /** Which raw-entity folds inside an open row are open — same reasoning. */
  const openRaw = new Set<string>();
  /** The ~1 Hz cache behind `DETAIL_REFRESH_MS`: cid → its last inspection. */
  const detailCache = new Map<string, { at: number; ins: CreatureInspection }>();
  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  /** The open row's readout, recomputed at most once a second. Every call is a
   *  pure read of the host's probes (see creature-inspect.ts). */
  const detailOf = (session: QuestSession, cid: string): CreatureInspection => {
    const now = Date.now();
    const hit = detailCache.get(cid);
    if (hit && now - hit.at < DETAIL_REFRESH_MS) return hit.ins;
    const ins = inspectCreature(session, cid, probesOf(host()));
    detailCache.set(cid, { at: now, ins });
    return ins;
  };

  const render = () => {
    const session = host()?.session ?? null;
    body.textContent = "";
    if (!session) {
      body.textContent = "no quest session (pick a town / quest scope)";
      return;
    }
    const sec = (label: string, open: boolean): HTMLElement => {
      const d = mk("details", "lab-debug-sec", body);
      d.open = open;
      mk("summary", "", d).textContent = label;
      return d;
    };

    // CLICKED entity (from a game click) at the top — a creature shows the SAME
    // detail block an expanded list row does (one readout, one owner); else a
    // world-item / bare id.
    if (clickedId) {
      const world = session.creatures?.world;
      const cid = cidOf(clickedId);
      const creature = world?.creatures[cid];
      const clicked = sec(`▶ Clicked: ${clickedId}`, true);
      if (creature) {
        paintDetail(clicked, session, detailOf(session, cid), openRaw);
      } else {
        const item = world?.items[clickedId] ?? null;
        mk("pre", "", clicked).textContent = item
          ? JSON.stringify(item, null, 2)
          : "(world object — no creature-world entity data)";
      }
    }

    // OUTSTANDING ORDERS — commands, the pooled-task board, help/on-behalf,
    // standing rules, blocked wants: everything the sim is trying to get done.
    mk("pre", "", sec("Outstanding orders", true)).textContent = JSON.stringify(
      outstandingTasks(session),
      null,
      2,
    );

    mk("pre", "", sec("Session", true)).textContent = JSON.stringify(
      {
        townClock: session.townClock,
        carrying: host()?.carryOf(session.handsCid) ?? {},
        wornBags: Object.fromEntries([...session.wornBags].map(([c, w]) => [c, w.glyph])),
        selectedPocket: (session as unknown as { selectedPocketGlyph?: string }).selectedPocketGlyph,
        party: [...session.party],
        escorting: [...session.escorting],
        heardWants: [...session.heardWants],
      },
      null,
      2,
    );

    // LIVE NEEDS (quest-host stepNeeds): meters, carried stacks, active walk-steps,
    // promoted bodies, shown houses, and every non-empty container stack — the whole
    // steal→shop / gift→deposit loop at a glance.
    mk("pre", "", sec("Live needs", true)).textContent = JSON.stringify(
      {
        meters: Object.fromEntries(
          [...session.needMeters].map(([k, v]) => [k, Math.round(v * 100) / 100]),
        ),
        carried: Object.fromEntries(
          [...new Set([...session.liveNeedBodies, ...session.wornBags.keys()])]
            .map((cid) => [cid, host()?.carryOf(cid) ?? {}] as const)
            .filter(([, c]) => Object.keys(c).length > 0),
        ),
        steps: Object.fromEntries(
          [...session.needStep].map(([k, s]) => [k, `${s.kind} ${s.goodKey}×${s.units} @ ${s.objId ?? "?"}`]),
        ),
        liveBodies: [...session.liveNeedBodies],
        housesShown: [...session.houseShown],
        containers: Object.fromEntries(
          [...session.containerStock].filter(([, stock]) => Object.keys(stock).length > 0),
        ),
      },
      null,
      2,
    );

    // CREATURES — every row EXPANDS (stocking-offload-and-carry.md §2). The list
    // is `inspectRoster`'s: the family and its pets (whether or not anything has
    // registered them yet), everything the session HAS registered, and every
    // body the live needs loop drives. OFF-SCREEN AND ABSTRACTED BODIES ARE THE
    // POINT — clicking needs a body under the pointer, which is exactly what a
    // shopper that vanished mid-trip does not have. The rest of the town is a
    // COUNT, never enumerated (a crowd is summarized, an individual is named).
    const world = session.creatures?.world;
    const roster = inspectRoster(session, probesOf(host()));
    const listed = [...roster.named];
    for (const cid of pinnedCids) if (!listed.includes(cid)) listed.push(cid);
    const cs = sec(
      `Creatures (${listed.length}${roster.ambient ? ` + ${roster.ambient} ambient` : ""})`,
      true,
    );
    for (const cid of listed) {
      const d = mk("details", "lab-debug-c", cs) as HTMLDetailsElement;
      d.dataset.cid = cid; // click-to-link target
      d.open = openCids.has(cid);
      // The COLLAPSED line stays cheap: no why-chain walk for a row nobody
      // opened (`summarizeCreature` asks none of the expensive probes).
      mk("summary", "", d).textContent = summarizeCreature(session, cid, probesOf(host()));
      if (d.open) paintDetail(d, session, detailOf(session, cid), openRaw);
      // Expand/collapse paints or drops the block IN PLACE — never a full
      // re-render, which would tear down the very row being toggled (and, since
      // setting `.open` above queues a toggle event of its own, would loop).
      d.addEventListener("toggle", () => {
        if (d.open) {
          openCids.add(cid);
          if (!d.querySelector(".lab-debug-detail")) paintDetail(d, session, detailOf(session, cid), openRaw);
        } else {
          openCids.delete(cid);
          d.querySelector(".lab-debug-detail")?.remove();
        }
      });
    }

    const items = world ? Object.values(world.items) : [];
    mk("pre", "", sec(`Items (${items.length})`, false)).textContent = JSON.stringify(items, null, 2);
  };

  const setActive = (tab: "world" | "debug") => {
    worldTab.classList.toggle("on", tab === "world");
    debugTab.classList.toggle("on", tab === "debug");
    fileEl.hidden = tab !== "world";
    panel.hidden = tab !== "debug";
    stopTimer();
    if (tab === "debug") {
      render();
      if (!pauseChk.checked) timer = setInterval(render, 400); // follow live unless paused
    }
  };

  /** Clicking an object in the game shows its data at the top + flashes its row. */
  const linkEntity = (rawId: string) => {
    clickedId = rawId;
    // A clicked CREATURE joins the list even when it is ambient — so the reader
    // can keep watching it after it walks off screen and abstracts away.
    const clickedCid = cidOf(rawId);
    if (host()?.session?.creatures?.world.creatures[clickedCid]) pinnedCids.add(clickedCid);
    setActive("debug"); // switches tab + renders (which now includes the Clicked section)
    clickedEl.textContent = `clicked: ${rawId}`;
    const target = body.querySelector(`[data-cid="${CSS.escape(cidOf(rawId))}"]`) as HTMLDetailsElement | null;
    if (target) {
      target.open = true;
      target.scrollIntoView({ block: "center" });
      target.classList.add("flash");
      setTimeout(() => target.classList.remove("flash"), 1200);
    }
  };

  // A ONE-SHOT pick at the actual click point — works even while PAUSED, where
  // the live settled-gaze hover can't advance (dt=0). Falls back to the hover.
  const onViewClick = (e: MouseEvent) => {
    const h = host();
    const hv = h?.pickEntityAt(e.clientX, e.clientY) ?? h?.hoveredEntity();
    if (hv) linkEntity(hv.id);
  };
  viewEl?.addEventListener("click", onViewClick);

  worldTab.addEventListener("click", () => setActive("world"));
  debugTab.addEventListener("click", () => setActive("debug"));
  refreshBtn.addEventListener("click", render);
  pauseChk.addEventListener("change", () => {
    host()?.setPaused(pauseChk.checked);
    stopTimer();
    if (!pauseChk.checked) timer = setInterval(render, 400);
    render();
  });

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.key.toLowerCase() === "d" && t?.tagName !== "TEXTAREA" && t?.tagName !== "INPUT") {
      setActive(panel.hidden ? "debug" : "world");
    }
  };
  window.addEventListener("keydown", onKey);

  setActive("world");

  return {
    dispose() {
      stopTimer();
      window.removeEventListener("keydown", onKey);
      viewEl?.removeEventListener("click", onViewClick);
      host()?.setPaused(false);
      layout.insertBefore(fileEl, leftCol); // restore the world-JSON to the layout
      leftCol.remove();
    },
  };
}
