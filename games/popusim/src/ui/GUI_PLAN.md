# Gameplay GUI — Planning Document

Status: draft, awaiting decisions on the open questions in §13.
Source of feature requirements: `legacy/script.js` (System @ 1758, Graph @ 4555, NewsBox @ 5739, PanelsGUI @ 4384, Visualizer @ 4855), the existing partial port in `src/ui/`, and `CLAUDE.md`.

The goal of this rebuild is **not** a pixel-perfect port of the legacy GUI. It is a clean rebuild that delivers the legacy's *capabilities* with a fresh information architecture, modern interaction patterns, and infrastructure for things the legacy never had (multiplayer, i18n, RTL, scenario distribution).

---

## 1. Scope

### In scope (this plan)
- Single-player gameplay GUI for a loaded scenario.
- Graph (history, log/linear, show/hide series).
- Pause / step / 1× / 2× / 4× speed controls.
- News popup feed (marquee ticker + expandable feed + modal for details).
- Trait/resource/metric panels with grouping (legacy `GUIGroup` / `GUIBox`).
- Player actions panel (sliders/toggles/numbers, with explicit lock-in semantics).
- Site-level view (focused on one site) and world view (list of all sites; placeholder for the future map).
- i18n string-translation system + LTR/RTL runtime switch.
- Responsive layout: desktop and mobile portrait/landscape.

### Out of scope (this plan)
- Scenario builder UI (separate project per `CLAUDE.md`; will share components).
- Multiplayer transport/lobby (the GUI must be *compatible* with multiplayer rules — see §3 — but the protocol itself is later).
- Map / geographic visualization (we ship a list view as a stand-in).
- Calculator / TraitBuilder UI (legacy 4930+) — leave the existing port alone for now; reach into it later.
- Visualizer "unit dots" mode (legacy 4855). Useful for scenario debugging but not on the critical path.

### Relationship to existing `src/ui/`
The existing `src/ui/` (Graph, NewsBox, PanelsGUI, GUIBox, Visualizer, etc.) is a *line-by-line port* of the legacy DOM-manipulation classes. It is not currently wired into `main.ts` — `main.ts` only renders the snapshot as `<pre>` text. The existing port is **not the foundation we build on**. We treat it as reference code: feature checklist + source of math (graph rule lines, log scaling, hit-testing). The new GUI lives in a new directory (`src/ui/app/`) and the legacy port can be deleted once parity is reached.

---

## 2. Framework recommendation

**Recommendation: Preact + @preact/signals, with TS + JSX via Vite.**

### Why a framework, not vanilla
The legacy GUI is ~3,000 lines of imperative DOM mutation across `System`, `PanelsGUI`, `GUIBox`, `NewsBox`, the action/trait/site panels, and the modal/tooltip system. The "lifecycle" code (create-on-add, destroy-on-empty, restore-prev-state, splice-into-correct-DOM-position) in `PanelsGUI.addGUIBox` (legacy 4398) is exactly the kind of thing a virtual-DOM diff erases. We will have ~12 panels, several with dynamic children, several with controlled inputs, and modals + tooltips on top. Vanilla scales badly here.

### Why Preact specifically (vs React)
- **Bundle size**: preact + signals ≈ 6 KB gzipped. React + react-dom ≈ 45 KB gzipped. For a game we want to ship to Steam *and* the web, every KB on the web build matters; on Steam it's bundled anyway, so the win is on the web side.
- **API parity**: hooks, JSX, context, Suspense-equivalent — Preact covers what we need. We're not using any niche React-only features.
- **Signals**: `@preact/signals` gives us fine-grained reactivity, which is a near-perfect fit for the simulator's snapshot-stream model (one snapshot per day → one signal write → only graph/affected panels re-render). Avoids manual `useMemo`/`useCallback` discipline.
- **Escape hatch**: if Preact ever becomes a constraint, the migration to React is mechanical (alias resolved differently) and we lose nothing structural.

### Why not other options
- **React**: same architecture, 7× the bundle. Defensible if the team strongly prefers React's ecosystem (devtools, Storybook, etc.), but for a self-contained app it's overkill.
- **Solid**: smaller and faster than React, comparable to Preact. Mature enough but ecosystem (i18n, virtualized lists, drag-drop for the future builder) is thinner.
- **Lit / web components**: tempting for canvas-heavy work, but our pain isn't rendering speed — it's panel-tree management and form state. Lit doesn't help with the latter.
- **Vanilla TS + templating helper**: we'd be reinventing what Preact already gives us. The "extra weight" of Preact is 6 KB; the extra weight of hand-rolled diffing is hundreds of bug-hours.

### Verdict on the user's question — "is React worth the extra weight"
For React proper: probably not, given Preact gets us 95% of the value at 15% of the bundle. For a framework in general: yes, decisively.

If you specifically want React (for ecosystem, hiring, Storybook, etc.), I'd take the bundle hit without complaint — but I'd default to Preact unless there's a reason.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────┐
│  Main thread                                    │
│  ┌────────────────┐    ┌──────────────────────┐ │
│  │  SimClient     │◄──►│  GUI app (Preact)    │ │
│  │  - subscribe() │    │  - signals from snap │ │
│  │  - step/run/…  │    │  - controls → client │ │
│  └────┬───────────┘    └──────────────────────┘ │
└───────┼─────────────────────────────────────────┘
        │ postMessage (ClientMsg / WorkerMsg)
┌───────▼─────────────────────────────────────────┐
│  Simulation worker — owns the World             │
│  No DOM, no UI state.                           │
└─────────────────────────────────────────────────┘
```

### Strict separation
The GUI and the simulation already live on different threads (good, keep this). The contract between them is `src/sim/protocol.ts`. **The GUI never reaches into world objects.** Anything the GUI needs to render is in the snapshot or in scenario metadata loaded once at start.

### Snapshot extensions needed
The current `Snapshot` (protocol.ts) only carries `age` + `sites[].pops[]`. To render the GUI we need to add (subject to refinement during implementation):

- `trackers: TrackerSnapshot[]` — id, name, color, group, hidden flag, type (trait/resource/metric), `latestValue` per site, `globalLatest`.
- `historyDelta: { trackerId, siteKey?, day, value }[]` — only the new days since the last snapshot, so the wire stays small even after a long run. The GUI keeps the accumulated history client-side, indexed by tracker.
- `news: NewsItemSnapshot[]` — title, body (already-parsed strings), id, day, optional siteKey, `auto` flag (auto-open modal). Cleared by the worker once acknowledged.
- `actions: ActionSnapshot[]` — id, name, group, type (toggle/slider/number), bounds, `desired_value`, `current_value`, `enabled`, optional cost summary, optional siteKey for local actions.
- `stockpiles: StockpileSnapshot[]` — id, name, value, perSite/global flag.
- `phase`: optional, only useful if we expose intra-day animation; default omit.

Bootstrap once, on `started`:
- `meta: { phases, traits[], guiGroups[], resources[], languageBundles? }` — static scenario data the GUI needs for labels, ordering, and grouping. Sent once; not in every snapshot.

These changes go into `src/sim/protocol.ts` and the worker side enriches the snapshot. The actual on-the-wire size stays modest because we send history *deltas*, not the full series, and we don't send populations broken down per-syndrome by default (top-N rule, like `main.ts` already does for the text view).

### Multiplayer compatibility (now, not later)
`CLAUDE.md` requires: actions are locked in once at the start of the day, and randomness is deterministic from the seed. The GUI must enforce **lock-in** unilaterally — sliders bind to `desired_value`, only the worker copies it to `current_value` at the top of `newDay`. The GUI must also **never** display intra-day partial state to the user as if it were committed (all displays read from the most recent committed snapshot). Following these now means we can drop a network layer in later without rewriting the UI.

---

## 4. State management

Global state lives in three signals:

```ts
// src/ui/app/state.ts
export const snap        = signal<Snapshot | null>(null);    // most recent committed snap
export const meta        = signal<ScenarioMeta | null>(null); // bootstrap data
export const ui          = signal<UiState>({...});            // panel collapsed flags, selected site, language, dir, graph zoom, etc.
```

Plus per-tracker history accumulators (a `Map<trackerId, History>`) updated by applying each snapshot's `historyDelta`.

UI state (collapsed panels, selected site, graph view range) is persisted to `localStorage` via a tiny effect — same role as legacy's `prev_state` in `PanelsGUI`.

No Redux, no Zustand. Signals are sufficient and zero-boilerplate.

---

## 5. Component inventory

```
<App>
  <Layout>                                    -- responsive grid; switches rows/cols
    <TopBar>
      <DatePanel/>                            -- day counter, scenario name
      <SiteSelector/>                         -- dropdown / tabs
      <SpeedControls/>                        -- pause | next | 1× | 2× | 4× | (omni in dev)
      <SettingsButton/>                       -- language, RTL, GPU toggle
    </TopBar>

    <MainArea>
      <GraphPanel>
        <GraphCanvas/>                        -- ported math from legacy Graph
        <GraphLegend/>                        -- show/hide series, color swatches
        <GraphAxisControls/>                  -- log/linear, vertical zoom slider, range
      </GraphPanel>

      <SidePanels>                            -- right rail (desktop) / drawer (mobile)
        <NewsTicker/>                         -- horizontal marquee, click to expand
        <NewsFeed/>                           -- expanded list; modal on item click
        <StatusPanel>                         -- traits/resources/metrics, grouped
          <GUIGroup *>
            <TrackerRow * />                  -- bullet (hide/show) + label + value
          </GUIGroup>
        </StatusPanel>
        <ActionsPanel>                        -- player actions, grouped, with cost
          <ActionRow * />                     -- slider/toggle/number, desired vs current
        </ActionsPanel>
      </SidePanels>
    </MainArea>

    <BottomBar mobileOnly>                    -- speed controls dock here on mobile
  </Layout>

  <WorldView when={ui.value.view === 'world'}>
    -- list of <SiteCard>s, summary stats per site, click to focus
  </WorldView>

  <Modals>
    <NewsModal/>  <ConfirmBox/>  <SettingsModal/>
  </Modals>
</App>
```

Group ownership (legacy `GUIGroup`) is bootstrap data: `meta.guiGroups[]` defines key, name, parent. The status panel and actions panel both project trackers/actions into the same group tree.

---

## 6. Graph

Render to a `<canvas>` (not SVG). Ported math from legacy `Graph.render` (4795) and `drawHist` (4754):

- **Horizontal**: x-axis is days. `width_of_day` derived from current zoom; pan via translate. "At end" follow mode (auto-scroll to today) is preserved, and turned off the moment the user pans backward.
- **Vertical**: linear when `max ≤ 100`; logarithmic via legacy `convertToLog` (4620) when `max > 100`. Legend offers an explicit "log/linear" toggle that wins over the auto-pick.
- **Series**: from the per-tracker history accumulator. Color from tracker. Line dashing for percentage-mode series (legacy 4774). Skip when `tracker.hidden` or the series is toggled off in the legend.
- **Grid**: rule lines (legacy `drawRules` 4715) with auto-spaced rows.
- **Performance**: only redraw when `(snap, ui.graphRange, ui.graphLog, ui.hiddenSeries)` changes. Use a single `requestAnimationFrame`-coalesced render. Series count is bounded by tracker count (tens, not thousands), so no canvas/webgl heroics needed.

Legend lives outside the canvas as a real DOM list — keyboard-accessible and i18n-friendly, unlike legacy.

---

## 7. News ticker + feed

- **Ticker**: a CSS-driven horizontal scrolling marquee (`@keyframes` translateX, paused on hover/focus). Latest item only; clicking opens the feed.
- **Feed**: vertical list of all items. Items with body text are clickable → modal.
- **Auto-popup**: events with `auto: true` (legacy `EventResult.auto`) push a modal immediately on the next snapshot. The modal queues if multiple arrive in the same day.
- **RTL**: marquee animates right-to-left in LTR, left-to-right in RTL — controlled by a single CSS custom property flipped by `dir`.
- **Accessibility**: respect `prefers-reduced-motion` — replace the marquee with a static "latest news" line that updates in place.

---

## 8. Player actions panel

The legacy actions UI was buggy in places. Goals for the new one:

1. **Lock-in is visible.** Each action shows two values: *desired* (the slider you're touching) and *current* (the locked-in value the simulation is using). Different colors. A tooltip explains: "Changes apply at the start of the next day."
2. **Cost is upfront.** Show the resource cost per unit and the total cost at the current desired value. If the player can't afford the desired value, show how much will actually be applied (legacy `cost_capped_value`, `script.js:6952-6993`) and *why*, instead of silently capping.
3. **Disabled actions stay visible.** Greyed out with the reason (locked by an event, prerequisite missing, etc.) rather than hidden — players reported the legacy made actions "disappear" mysteriously.
4. **Slider semantics on mobile.** Number-input fallback for accuracy + `<input type="range">` for the slider. Long-press to type. Two-finger drag for fine adjust on touch.
5. **Group by `GUIGroup`** (same tree as the status panel).

Open creative direction (see §13): allow scheduling — set a desired value to apply N days from now. Simple to model; legacy never had it. Optional.

---

## 9. World view (multi-site)

For now: a flat list of `<SiteCard>`s, each showing
- site name + key,
- total population,
- top-3 syndromes (by share),
- per-site headline metrics (configurable),
- a sparkline of total infected (or whatever the scenario's primary metric is).

Click → switch focus to that site (graph and panels follow).

This is structured so that swapping the list for a real map later only changes the `<WorldView>` component — site cards become map pins, the rest stays.

---

## 10. Internationalization (i18n)

### Translation system
- **Format**: ICU MessageFormat (handles plurals, gender, number/date formatting). Library: `@formatjs/icu-messageformat-parser` + `intl-messageformat` (~10 KB gzipped, no React dependency).
- **Storage**: one JSON file per locale: `src/ui/app/locales/{en,es,fr,ja,ar,he,...}.json`. Key namespacing by panel: `news.ticker.label`, `actions.cost.cant_afford`, etc.
- **Dynamic strings from scenarios**: news titles, action names, and trait names come from the scenario JSON. Scenarios may include their own `i18n` block keyed by scenario; missing keys fall back to the default (English) string written in the scenario. Long-term we want scenarios to ship per-locale bundles.
- **Bundle splitting**: the active locale is loaded on demand (`import('./locales/' + locale + '.json')`); only English is bundled by default.

### API
```ts
const { t, locale, setLocale, dir } = useI18n();
t('news.ticker.label')                         // "News"
t('actions.cost.payout', { amount: 12.5 })     // "Costs {amount} per day."
```

### Pseudo-locale for testing
A `pseudo` locale wraps strings (`[!!Hello World!!]`) so layout truncation, padding, and missed strings show up immediately. Built into the i18n loader; opt-in via a settings toggle.

---

## 11. RTL / LTR

- Set `<html dir="rtl">` on the root. Drives logical CSS properties throughout.
- **Stylesheet rules**: use `margin-inline-start/end`, `padding-inline-*`, `border-inline-*`, `inset-inline-*`. No `left`/`right` outside of the canvas.
- **Icons that imply direction** (play, next, back) are mirrored under RTL via a `[dir=rtl]` SVG transform.
- **Graph**: stays LTR regardless of UI direction. Time always flows left → right; flipping it would confuse domain users. Y-axis labels go on the right side instead of the left when in RTL, but the data does not flip.
- **Marquee**: direction flips with `dir` (CSS variable on the keyframe).
- **Number formatting** uses `Intl.NumberFormat(locale)` so digits, separators, and percent signs come out correctly.

---

## 12. Responsive layout

CSS Grid with two breakpoints:

| Width | Layout |
|---|---|
| ≥ 1100 px | 3-column: left rail (status/actions), center (graph + news ticker), right rail (news feed expanded) |
| 700–1099 px | 2-column: graph + ticker on top, panels below in tabs |
| < 700 px | 1-column: graph collapses to ¼ height, panels become a bottom-sheet drawer with tabs (Status / Actions / News) |

Speed controls always reachable: top bar on desktop, bottom dock on mobile (thumb zone).

We aim for **portrait phone first**, then scale up. Mobile is where the legacy GUI was weakest (calculator, action sliders, modal sizing), so we test on a 360 × 800 viewport early and often.

---

## 13. Decisions (confirmed)

1. **Framework**: Preact + signals.
2. **News modal behavior**: events that show a popup (`auto: true` with body text) **pause** the simulation; ticker-only news (no body) does not pause. The pause is automatic and reverses when the player dismisses the modal — they can override by hitting play again first.
3. **Scheduled player actions**: in scope. Players can set a desired value to "apply N days from now" or "apply on day X." Implementation lives in the action panel (`<ScheduleControl>`); the snapshot carries a `schedule[]` per action and the worker reads them at lock-in time.
4. **Hidden vs disabled actions**: scenario events can mark an action `hidden` (not shown — useful for secret/conditional actions) or `disabled` (visible, greyed out, with an explanation). Both flags ship in the action snapshot.
5. **Launch locales**: `en, es, fr, he, ar, de, ko, pt, ru, yue, zh`. Both RTL languages ship day-one (he, ar). Translation source-of-truth is `en.ts`; structural parity enforced by `npm run validate-i18n`.
6. **Single codebase** for web + Steam (Tauri wrap later).
7. **Threading note**: simulation runs *client-side* in a Worker — never server-side. The GUI/sim split is purely for organizational clarity, not security. Don't trust the sim to enforce any security boundary; it's part of the same trust domain as the UI.

(Still open and listed in §16.)

---

## 14. Milestones

All milestones M0–M8 landed in a single pass.

- **M0 — scaffolding.** Preact + signals + intl-messageformat installed; Vite + tsconfig configured for JSX (`react-jsx` with `preact` import source); `src/ui/app/` created.
- **M1 — graph + speed controls.** Canvas graph with log/linear axis, follow-current-day, legend chips. Pause / step / 1× / 2× / 4× wired through SimClient.
- **M2 — status panel + groups.** Trackers grouped by GUIGroup; bullets toggle the same hidden-series state the legend uses.
- **M3 — news.** Ticker + feed + modal. Modal-bearing auto-news pauses; ticker-only news doesn't. Reduced-motion fallback honored.
- **M4 — actions.** Slider / toggle / number with desired-vs-current display. Hidden vs. disabled actions distinguished (events drive both flags). Schedule-for-future-day controls. Cost display with capped-by-budget warning.
- **M5 — world view.** Site cards with population + top-3 syndrome shares; click to focus.
- **M6 — i18n + RTL.** ICU loader, 11 locales (en/es/fr/de/pt/ru/ko/zh/yue/he/ar), validator-script enforced structural parity, pseudo-locale toggle, RTL via CSS logical properties + marquee direction flip.
- **M7 — accessibility / responsive.** Logical properties throughout, ARIA roles on interactive elements, keyboard handlers on bullets / chips / cards, visible focus outlines via the dark theme, single-column collapse below 1100 px. Keyboard shortcuts (space to pause, ←/→ to step) deferred to a follow-up — not implemented yet.
- **M8 — kill legacy port.** `src/ui/{graph,news,panels,canvas,scrollbar,calculator,worldbuilder}` deleted; `src/ui/index.ts` re-exports only the new app.

Calculator + WorldBuilder + Visualizer remain to be ported as separate efforts; their data hooks into the same SimClient + bootstrap flow, so reattaching them is incremental.

---

## 15. Testing strategy

- **Snapshot extensions** (protocol changes) get vitest unit tests on the worker side.
- **Component tests** with `@testing-library/preact` for: lock-in semantics on the action slider, hide/show series in the graph legend, news modal queueing, RTL flip rendering.
- **Visual regression** (manual at first, Playwright later) for the responsive breakpoints and the RTL pass.
- **Integration**: a "play 100 days" smoke test that boots a scenario and confirms the graph has 100 points and at least one news item rendered.
- **Pseudo-locale CI**: render every screen under `pseudo` and assert no untranslated raw strings (`/^[A-Z][a-z]+ /` in the visible DOM).

---

## 16. Risks

- **Snapshot bloat.** Sending all of history in every snapshot would scale poorly. Mitigation: history *deltas* + top-N populations (already done in `main.ts`).
- **Lock-in confusion.** The "desired vs current" UX is not standard; players may slide and expect immediate effect. Mitigation: explicit two-color display + tooltip + onboarding hint on first session.
- **Legacy port temptation.** It is sitting right there. We must resist hooking into it for "just this one panel" — it'll bring in `System` / `World` references and re-tangle the architecture.
- **RTL regressions** sneaking in via `left`/`right` literals. Mitigation: stylelint rule banning `left`/`right`/`margin-left`/etc. in favor of logical properties.
- **i18n key drift** between scenarios and the UI. Mitigation: a single registry + a build-time check that the active locale has every key the code references.

---

## 17. Decision log

- [decided] Framework: Preact + signals.
- [decided] Bundle target: single codebase, Tauri-wrapped for Steam later.
- [decided] Graph rendering: canvas, ported math from legacy.
- [decided] i18n: ICU MessageFormat, *.ts files per locale (validator-friendly), lazy-loaded.
- [decided] State: signals, persisted to localStorage.
- [decided] Auto-news with body text pauses; ticker-only news does not.
- [decided] Scheduled player actions in scope.
- [decided] Hidden vs disabled actions both supported (event-driven).
- [decided] Launch locales: en, es, fr, he, ar, de, ko, pt, ru, yue, zh.
- [decided] Sim runs client-side; GUI/sim split is for organization, not security.
- [open] Scenario distribution UI scope.
- [open] localStorage key strategy (per-scenario vs per-user) — defaulting to per-scenario, can revisit.
