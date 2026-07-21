// games/world-lab/src/debug-panel.ts
//
// A dev-only creature/session READOUT that shares the LEFT column with the world-JSON
// editor via TABS (World / Debug), truly PAUSES the sim (host.setPaused → world dt=0),
// and LINKS on-screen objects to their data: clicking an object in the game jumps to and
// flashes its entity in the readout. World-lab bench only — never shipped to the app.

import type { QuestHost3D, QuestSession } from "@shared/world-engine/interaction/quest/quest-host";
import {
  assignTownJobs,
  inShiftWindow,
  jobDutyOf,
  rosterOf,
  shopDutyOf,
  type JobAssignment,
} from "@shared/world-engine/kernel/town/roster";
import { FOOD_DAY_SEC, houseDoorstep, workDoorstep } from "@shared/world-engine/kernel/town/goods";

const host = (): QuestHost3D | null =>
  (window as unknown as { __questLab?: QuestHost3D }).__questLab ?? null;

const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  parent.appendChild(n);
  return n;
};

/** Town job assignments, memoized per TownPlay (assignTownJobs is pure but a
 *  city-sized sort — don't rerun it every 400 ms render tick). */
const jobsMemo = new WeakMap<object, Map<number, JobAssignment[]>>();
function townJobsOf(session: QuestSession): Map<number, JobAssignment[]> | null {
  const town = session.town;
  if (!town) return null;
  let jobs = jobsMemo.get(town);
  if (!jobs) {
    jobs = assignTownJobs(
      town.plan.houses.map((h) => ({ index: h.index, door: houseDoorstep(town.stage.center, h) })),
      town.plan.works.map((wk) => ({ door: workDoorstep(town.stage.center, wk) })),
      town.stage.goods.length,
      town.config.seed,
    );
    jobsMemo.set(town, jobs);
  }
  return jobs;
}

/** A resident's DUTY line: its shop errand phase and/or its job shift state,
 *  from the household roster — the one allocator. "" for pure homebodies. */
function errandOf(session: QuestSession, cid: string): string {
  try {
    if (!cid.startsWith("resident_") || !session.town) return "";
    const house = session.town.plan.houses[Number(cid.split("_")[1])];
    const m = Number(cid.split("_")[2]);
    if (!house) return "";
    const roster = rosterOf(
      session.town.stage.goods.map((g, i) => ({ key: g.good.key, slot: g.good.slot ?? i })),
      undefined,
      townJobsOf(session)?.get(house.index),
    );
    let out = "";
    const duty = shopDutyOf(roster[m]);
    const good = duty ? session.town.stage.goods.find((g) => g.good.key === duty.good) : undefined;
    if (good) out += ` · ${good.good.key}:${good.errand(house, session.townClock).phase}`;
    const jd = jobDutyOf(roster[m]);
    if (jd) out += ` · job:${jd.work}${inShiftWindow(jd.window, session.townClock, FOOD_DAY_SEC) ? " ON-SHIFT" : ""}`;
    return out;
  } catch {
    return "";
  }
}

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

/** WHAT a creature is doing and WHY — the first applicable driver in the loop's
 *  own priority order — plus its inventory and meters. The per-person readout. */
function describeCreature(session: QuestSession, cid: string): Record<string, unknown> {
  const world = session.creatures?.world;
  const c = world?.creatures[cid];
  const pursuit = session.pursuits.get(cid);
  const claimed = session.taskPool?.claimedBy(cid);
  const help = session.helpOrders.get(cid);
  const step = session.needStep.get(cid);
  const blocked = session.blockedNeeds.get(cid);
  const hold = session.actionHold.get(cid);
  let why = "idle / autonomous (own needs)";
  if (hold)
    why = `✋ ACTING: ${hold.label} (crouch ${Math.round((hold.t / hold.dur) * 100)}%${hold.applied ? " — effect landed" : ""})`;
  else if (pursuit) why = `▶ ${pursuit.source.toUpperCase()}: "${pursuit.glyph}" (${pursuit.goal.kind}, acts ${pursuit.acts ?? 0}) → ${JSON.stringify(pursuit.goal)}`;
  else if (session.party.has(cid)) why = "following the player (party)";
  else if (help) why = `helping ${help} (on-behalf order)`;
  else if (claimed) why = `claimed pooled task: "${claimed.sourceGlyph ?? claimed.goal.kind}"`;
  else if (step) why = `need step: ${step.kind} ${step.goodKey}×${step.units} @ ${step.objId ?? "in place"}`;
  else if (blocked) why = `⚠ BLOCKED want: ${blocked.goodKey} (${blocked.tplKey}) — can't be served here`;
  const owned = world
    ? Object.values(world.items)
        .filter((it) => it.ownerId === cid)
        .map((it) => `${it.kind ?? it.id}${(it.states ?? []).length ? `.${it.states.join(".")}` : ""}`)
    : [];
  return {
    why,
    going: session.npcGoing.get(cid) ?? null,
    condition: c?.condition ?? null,
    wants: (c?.needs ?? [])
      .filter((n) => !n.fulfilled)
      .map((n) => n.target?.category ?? n.target?.kind ?? n.itemId),
    inventory: { owned, carriedStack: session.needCarried.get(cid) ?? {} },
    meters: Object.fromEntries(
      [...session.needMeters]
        .filter(([k]) => k.startsWith(`${cid}|`))
        .map(([k, v]) => [k.slice(cid.length + 1), Math.round(v * 100) / 100]),
    ),
    flags: {
      party: session.party.has(cid),
      escorting: session.escorting.has(cid),
      bonded: session.bondedCreatures.has(cid),
      addressed: session.addressedFamily === cid,
      liveNeedBody: session.liveNeedBodies.has(cid),
    },
    duty: errandOf(session, cid).trim() || null,
  };
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
  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
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

    // CLICKED entity (from a game click) at the top — a creature leads with the
    // human-readable WHAT & WHY + inventory, then the raw entity JSON; else a
    // world-item / bare id.
    if (clickedId) {
      const world = session.creatures?.world;
      const cid = cidOf(clickedId);
      const creature = world?.creatures[cid];
      const clicked = sec(`▶ Clicked: ${clickedId}`, true);
      if (creature) {
        mk("pre", "lab-debug-why", clicked).textContent = JSON.stringify(describeCreature(session, cid), null, 2);
        const raw = mk("details", "lab-debug-c", clicked) as HTMLDetailsElement;
        mk("summary", "", raw).textContent = "raw entity";
        mk("pre", "", raw).textContent = JSON.stringify(creature, null, 2);
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
        pocket: session.pocket,
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
        carried: Object.fromEntries(session.needCarried),
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

    const world = session.creatures?.world;
    const creatures = world ? Object.values(world.creatures) : [];
    const cs = sec(`Creatures (${creatures.length})`, true);
    for (const c of creatures) {
      const d = mk("details", "lab-debug-c", cs) as HTMLDetailsElement;
      d.dataset.cid = c.id; // click-to-link target
      const wants = c.needs
        .filter((n) => !n.fulfilled)
        .map((n) => n.target?.category ?? n.target?.kind ?? n.itemId)
        .join(",");
      // A DEFINED family member (world doc entities) shows its authored name.
      const famName = (() => {
        const fam = session.town?.config.family;
        const fh = session.town?.familyHouse;
        if (!fam || fh === null || fh === undefined || !c.id.startsWith(`resident_${fh}_`)) return "";
        const name = fam.members[Number(c.id.split("_")[2])]?.name;
        return name ? ` “${name}”` : "";
      })();
      mk("summary", "", d).textContent =
        `${c.id}${famName}${c.condition ? ` [${c.condition}]` : ""}${wants ? ` want:${wants}` : ""}${errandOf(session, c.id)}`;
      mk("pre", "", d).textContent = JSON.stringify(c, null, 2);
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
