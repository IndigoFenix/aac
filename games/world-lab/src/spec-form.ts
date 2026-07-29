/**
 * spec-form.ts — the World tab's RECURSIVE TREE EDITOR (project_scope_object
 * _vacuum_law: sub-entity-first). The document IS an `ObjectDef` tree: a root
 * object (any scopeable kind) whose typed child-lists nest down the ladder
 * (galaxy → solar_system → body → region → town → structure → creature/item).
 *
 * Each node renders its params sub-form (from its kind's descriptor) plus an
 * "Add <child>" button + an EXHAUSTIVE toggle per child-group. The tree is the
 * stored spec; `getDocument()` lowers it (lowerObjectDef) to the runnable
 * `aivota-world` envelope and folds in the session settings (avatar / scale /
 * culture — how you VIEW the world, orthogonal to what it IS).
 */
import { OBJECT_KINDS, lowerObjectDef, type ObjectDef } from "@shared/world-engine/object-def";
import { validateFields, type FieldSpec, type GroupSpec } from "@shared/world-engine/kernel/spec-schema";

type Dict = Record<string, unknown>;

/** A loadable preset: an ObjectDef tree + its session settings. */
export interface TreeWorld {
  tree: ObjectDef;
  session?: Dict; // avatar / can_fly / avatar_species / scale / culture
}

/** The scopeable kinds, in ladder order — a root may be any of these. */
const ROOT_KINDS = Object.values(OBJECT_KINDS).filter((k) => k.scope);

/** Fields the form never shows (kept in the descriptor for validation, but
 *  not authored here — quests are unused right now). */
const HIDDEN_FIELDS = new Set(["questCount"]);

/** Space-time compression (`session.scale`) — a FORM-ONLY descriptor; the real
 *  gate is `parseWorldScaleSpec`, run by boot. */
const SCALE_FIELDS: GroupSpec = {
  fields: [
    { key: "rotation", kind: "number", min: 1, max: 86_400, default: 360, label: "Rotation (× real spin)" },
    { key: "revolution", kind: "number", min: 1, max: 10_000_000, default: 1, label: "Revolution (× real orbit)" },
    { key: "sleep_fraction", kind: "number", min: 0, max: 0.9, default: 0.05, label: "Sleep fraction" },
    { key: "construction", kind: "number", min: 0.01, max: 100_000, default: 180, label: "Construction (s)" },
    { key: "planet_compression", kind: "number", min: 1, max: 10_000, default: 1, label: "Planet compression" },
    { key: "metabolism", kind: "number", min: 0.01, max: 10_000, default: 1, label: "Metabolism (× real)" },
    { key: "locomotion", kind: "number", min: 0.01, max: 1_000, default: 1, label: "Locomotion (× real gait)" },
    { key: "generation", kind: "number", min: 0.01, max: 100_000, default: 1, label: "Generation (× real life)" },
    { key: "lean_fraction", kind: "number", min: 0, max: 0.9, default: 0.4, label: "Lean season fraction" },
    { key: "growth_fraction", kind: "number", min: 0, max: 0.9, default: 18 / 70, label: "Growth stage fraction" },
  ],
};

const isObj = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}
function row(parent: HTMLElement, label: string, control: HTMLElement, help?: string): void {
  const r = el("label", "sf-row", parent);
  const cap = el("span", "sf-label", r);
  cap.textContent = label;
  if (help) cap.title = help;
  r.appendChild(control);
}

// ── one control per descriptor field, writing into target[field.key] ─────────
function control(field: FieldSpec, target: Dict, onChange: () => void): HTMLElement {
  const label = field.label ?? field.key;
  const present = field.key in target;
  const initial = present ? target[field.key] : field.default;

  switch (field.kind) {
    case "number": case "int": case "floor": {
      const wrap = el("span", "sf-num");
      const inp = el("input", "sf-ctl", wrap);
      inp.type = "number";
      if (field.min !== undefined) inp.min = String(field.min);
      if (field.max !== undefined) inp.max = String(field.max);
      inp.step = field.kind === "number" ? "any" : "1";
      if (typeof initial === "number") inp.value = String(initial);
      const commit = () => {
        if (inp.value === "") { if (!field.required) delete target[field.key]; }
        else target[field.key] = inp.valueAsNumber;
        onChange();
      };
      inp.addEventListener("input", commit);
      if (field.ui === "seed") {
        const dice = el("button", "sf-dice", wrap);
        dice.type = "button"; dice.textContent = "🎲"; dice.title = "Randomize seed";
        dice.addEventListener("click", () => { inp.value = String(Math.floor(Math.random() * 1e9)); commit(); });
      }
      return wrap;
    }
    case "boolean": {
      const inp = el("input", "sf-ctl"); inp.type = "checkbox";
      inp.checked = initial === true;
      if (!present && field.default !== undefined) target[field.key] = field.default;
      inp.addEventListener("change", () => { target[field.key] = inp.checked; onChange(); });
      return inp;
    }
    case "enum": {
      const sel = el("select", "sf-ctl");
      if (!field.required) { const o = el("option", "", sel); o.value = ""; o.textContent = "— (default)"; }
      for (const opt of field.options ?? []) { const o = el("option", "", sel); o.value = opt.value; o.textContent = opt.label; }
      sel.value = typeof initial === "string" ? initial : "";
      sel.addEventListener("change", () => {
        if (sel.value === "") delete target[field.key]; else target[field.key] = sel.value;
        onChange();
      });
      return sel;
    }
    case "string": {
      const inp = el("input", "sf-ctl"); inp.type = "text";
      if (typeof initial === "string") inp.value = initial;
      inp.addEventListener("input", () => {
        if (inp.value === "") { if (!field.required) delete target[field.key]; } else target[field.key] = inp.value;
        onChange();
      });
      return inp;
    }
    case "literal": {
      target[field.key] = field.constant;
      const span = el("span", "sf-fixed"); span.textContent = String(field.constant);
      return span;
    }
    case "object": {
      const box = el("div", "sf-obj");
      const optional = field.default === undefined;
      let child = isObj(target[field.key]) ? (target[field.key] as Dict) : undefined;
      const body = el("div", "sf-objbody");
      const build = () => { body.replaceChildren(); if (child) renderGroup({ fields: field.fields ?? [] }, child, body, onChange); };
      if (optional) {
        const head = el("label", "sf-objtoggle", box);
        const cb = el("input", "", head); cb.type = "checkbox"; cb.checked = !!child;
        head.appendChild(document.createTextNode(` ${label}`));
        cb.addEventListener("change", () => {
          if (cb.checked) { child = {}; target[field.key] = child; } else { child = undefined; delete target[field.key]; }
          build(); onChange();
        });
      } else {
        if (!child) { child = {}; target[field.key] = child; }
        const lg = el("div", "sf-objlabel", box); lg.textContent = label;
      }
      box.appendChild(body); build();
      return box;
    }
    case "list": case "custom": {
      const ta = el("textarea", "sf-json"); ta.spellcheck = false; ta.rows = 3;
      ta.value = present ? JSON.stringify(target[field.key]) : "";
      ta.addEventListener("input", () => {
        if (ta.value.trim() === "") { delete target[field.key]; ta.classList.remove("sf-bad"); onChange(); return; }
        try { target[field.key] = JSON.parse(ta.value); ta.classList.remove("sf-bad"); onChange(); }
        catch { ta.classList.add("sf-bad"); }
      });
      return ta;
    }
  }
}

/** Render every (non-hidden) field of a group into `parent`, writing to `target`. */
function renderGroup(group: GroupSpec, target: Dict, parent: HTMLElement, onChange: () => void): void {
  for (const f of group.fields) {
    if (HIDDEN_FIELDS.has(f.key)) continue;
    const c = control(f, target, onChange);
    if (f.kind === "object") parent.appendChild(c);
    else row(parent, f.label ?? f.key, c, f.description);
  }
}

// ── ObjectDef helpers ────────────────────────────────────────────────────────

/** A fresh node of `kind` with the minimal params it needs (a ROOT seeds its
 *  required BOUNDARY fields — the vacuum; a contained node inherits them). */
function freshNode(kind: string, root = false): ObjectDef {
  const spec = OBJECT_KINDS[kind];
  const params: Dict = {};
  for (const f of spec.paramFields.fields) {
    const need = f.required && (root || f.facet !== "boundary");
    if (!need) continue;
    if (f.kind === "int" || f.kind === "number" || f.kind === "floor") params[f.key] = f.default ?? (f.ui === "seed" ? 1 : f.min ?? 0);
    else if (f.kind === "enum") params[f.key] = f.default ?? f.options?.[0]?.value ?? "";
    else if (f.kind === "boolean") params[f.key] = f.default ?? false;
    // required strings (e.g. a glyph) start empty — the author fills them.
  }
  return { kind, params };
}

function clearFocus(node: ObjectDef): void {
  delete node.focus;
  for (const c of node.contains ?? []) clearFocus(c);
}

// ── the controller ───────────────────────────────────────────────────────────
export interface SpecFormController {
  setDocument(world: TreeWorld): void;
  getDocument(): unknown;
}

export function mountSpecForm(container: HTMLElement, onChange: () => void = () => {}): SpecFormController {
  let tree: ObjectDef = freshNode("town", true);
  let session: Dict = {};

  function renderSession(parent: HTMLElement): void {
    const sec = el("div", "sf-section", parent);
    const h = el("h3", "sf-h", sec); h.textContent = "Session";

    const av = el("select", "sf-ctl");
    for (const [v, t] of [["none", "None (overview)"], ["walker", "Walker"], ["spirit", "Spirit"]] as const) {
      const o = el("option", "", av); o.value = v; o.textContent = t;
    }
    av.value = session.avatar === "spirit" ? "spirit" : session.avatar === true ? "walker" : "none";
    av.addEventListener("change", () => {
      if (av.value === "walker") session.avatar = true;
      else if (av.value === "spirit") session.avatar = "spirit";
      else delete session.avatar;
      onChange();
    });
    row(sec, "Avatar", av, "How you inhabit the world.");

    const fly = el("input", "sf-ctl"); fly.type = "checkbox"; fly.checked = session.can_fly === true;
    fly.addEventListener("change", () => { if (fly.checked) session.can_fly = true; else delete session.can_fly; onChange(); });
    row(sec, "Can fly", fly);

    const sp = el("input", "sf-ctl"); sp.type = "text"; sp.placeholder = "human_cute";
    if (typeof session.avatar_species === "string") sp.value = session.avatar_species;
    sp.addEventListener("input", () => { if (sp.value) session.avatar_species = sp.value; else delete session.avatar_species; onChange(); });
    row(sec, "Avatar species", sp);

    // scale toggle
    const scHead = el("label", "sf-objtoggle", sec);
    const scCb = el("input", "", scHead); scCb.type = "checkbox"; scCb.checked = isObj(session.scale);
    scHead.appendChild(document.createTextNode(" Declare space-time scale"));
    const scBody = el("div", "sf-objbody", sec);
    const buildScale = () => { scBody.replaceChildren(); if (isObj(session.scale)) renderGroup(SCALE_FIELDS, session.scale as Dict, scBody, onChange); };
    scCb.addEventListener("change", () => {
      if (scCb.checked) session.scale = validateFields({}, SCALE_FIELDS, "scale"); else delete session.scale;
      buildScale(); onChange();
    });
    buildScale();

    // culture (universal taboos + dress palette)
    const curCulture = isObj(session.culture) ? (session.culture as Dict) : {};
    const curDress = isObj(curCulture.dress) ? (curCulture.dress as Dict) : {};
    const commas = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
    const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

    const cul = el("input", "sf-ctl"); cul.type = "text"; cul.placeholder = "fight, steal…";
    cul.value = commas(curCulture.absolutes);
    const dressPal = el("input", "sf-ctl"); dressPal.type = "text"; dressPal.placeholder = "color_red, color_pink…";
    dressPal.value = commas(curDress.palette);
    const dressKinds = el("input", "sf-ctl"); dressKinds.type = "text"; dressKinds.placeholder = "shirt, dress";
    dressKinds.value = commas(curDress.kinds);

    const syncCulture = () => {
      const c: Dict = {};
      const abs = list(cul.value);
      if (abs.length) c.absolutes = abs;
      const dress: Dict = {};
      const pal = list(dressPal.value);
      const kinds = list(dressKinds.value);
      if (pal.length) dress.palette = pal;
      if (kinds.length) dress.kinds = kinds;
      if (Object.keys(dress).length) c.dress = dress;
      if (Object.keys(c).length) session.culture = c; else delete session.culture;
      onChange();
    };
    for (const inp of [cul, dressPal, dressKinds]) inp.addEventListener("input", syncCulture);
    row(sec, "Taboos", cul, "Universal absolute taboos (parental controls).");
    row(sec, "Dress palette", dressPal, "Colours residents wear (color_* glyphs) — the town's culture.");
    row(sec, "Dress kinds", dressKinds, "Garment kinds worn: shirt, dress (blank = both).");
  }

  function renderNode(node: ObjectDef, parent: HTMLElement, isRoot: boolean, onRemove?: () => void): void {
    const spec = OBJECT_KINDS[node.kind];
    const box = el("div", isRoot ? "sf-node sf-root" : "sf-node", parent);
    const head = el("div", "sf-nodehead", box);

    if (isRoot) {
      const sel = el("select", "sf-ctl sf-kind", head);
      for (const k of ROOT_KINDS) { const o = el("option", "", sel); o.value = k.kind; o.textContent = k.label; }
      sel.value = node.kind;
      sel.addEventListener("change", () => { tree = freshNode(sel.value, true); render(); onChange(); });
    } else {
      const title = el("span", "sf-nodetitle", head); title.textContent = spec.label;
      const rm = el("button", "sf-rm", head); rm.type = "button"; rm.textContent = "✕"; rm.title = "Remove";
      rm.addEventListener("click", () => { onRemove?.(); onChange(); });
    }

    const fl = el("label", "sf-focus", head);
    const fr = el("input", "", fl); fr.type = "checkbox"; fr.checked = !!node.focus;
    fl.appendChild(document.createTextNode(" focus"));
    fr.addEventListener("change", () => {
      const on = fr.checked; clearFocus(tree); if (on) node.focus = true; render(); onChange();
    });

    // params
    const params = isObj(node.params) ? node.params : (node.params = {});
    renderGroup(spec.paramFields, params, box, onChange);

    // child groups
    for (const childKind of spec.childKinds) {
      const ck = OBJECT_KINDS[childKind];
      const grp = el("div", "sf-childgroup", box);
      const gh = el("div", "sf-grouphead", grp);
      const add = el("button", "sf-add", gh); add.type = "button"; add.textContent = `+ ${ck.label}`;
      add.addEventListener("click", () => {
        node.contains = [...(node.contains ?? []), freshNode(childKind)]; render(); onChange();
      });
      const exL = el("label", "sf-exh", gh);
      const ex = el("input", "", exL); ex.type = "checkbox";
      ex.checked = node.exhaustive?.includes(childKind) ?? false;
      exL.appendChild(document.createTextNode(" exhaustive"));
      exL.title = `Only these ${ck.label.toLowerCase()}s exist (the parent generates no others)`;
      ex.addEventListener("change", () => {
        const set = new Set(node.exhaustive ?? []);
        if (ex.checked) set.add(childKind); else set.delete(childKind);
        node.exhaustive = set.size ? [...set] : undefined;
        onChange();
      });
      for (const child of (node.contains ?? []).filter((c) => c.kind === childKind)) {
        renderNode(child, grp, false, () => { node.contains = (node.contains ?? []).filter((c) => c !== child); render(); });
      }
    }
  }

  function render(): void {
    container.replaceChildren();
    renderSession(container);
    const treeSec = el("div", "sf-section", container);
    const h = el("h3", "sf-h", treeSec); h.textContent = "World";
    renderNode(tree, treeSec, true);
  }

  render();

  return {
    setDocument(world: TreeWorld): void {
      tree = structuredClone(world.tree);
      session = world.session ? structuredClone(world.session) : {};
      render();
    },
    getDocument(): unknown {
      const doc = lowerObjectDef(tree) as Dict;
      const g = doc.game as Dict;
      if (session.avatar !== undefined) g.avatar = session.avatar;
      if (session.can_fly) g.can_fly = true;
      if (typeof session.avatar_species === "string") g.avatar_species = session.avatar_species;
      if (isObj(session.scale)) g.scale = session.scale;
      if (isObj(session.culture)) g.culture = session.culture;
      return doc;
    },
  };
}
