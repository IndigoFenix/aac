// client-aac/src/components/SocialDebugDialog.tsx
//
// DEBUG-only inspector for the social-trainer peer. Shows the live director
// internals (refreshed every turn via `social_peer_debug`) and lets a tester
// fully reconfigure every parameter that feeds the game and restart the
// director (`social_peer_reconfigure`). Gated behind debugMode by the caller.

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { COMPETENCY_LABEL } from "@shared/social-bot/state";
import type {
  SocialPeerDebugSnapshot,
  SocialPeerParams,
} from "@shared/social-bot/debug";

const GENOME_TRAITS: Array<{ key: keyof SocialPeerParams["genome"]; label: string }> = [
  { key: "warmth", label: "Warmth" },
  { key: "expressiveness", label: "Expressiveness" },
  { key: "stability", label: "Stability" },
  { key: "openness", label: "Openness" },
  { key: "assertiveness", label: "Assertiveness" },
  { key: "patience", label: "Patience" },
];
const ARCHETYPES = ["random", "sunny_extrovert", "anxious_pleaser", "gruff_softie", "aloof_intellectual", "even_keel"];
const HUMOR_STYLES = ["silly", "dry", "teasing", "wry"];
const LANGUAGE_LEVELS = ["1 single words", "2 short phrases", "3 simple sentences", "4 full sentences", "5 complex"];
const ALL_SKILLS = Object.keys(COMPETENCY_LABEL);

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 text-gray-300">{props.label}</span>
      <input
        type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="flex-1 accent-yellow-400"
      />
      <span className="w-10 text-right tabular-nums text-gray-100">{props.value.toFixed(2)}</span>
    </label>
  );
}

function SkillChips(props: { selected: string[]; onToggle: (k: string) => void; activeClass: string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ALL_SKILLS.map((k) => {
        const on = props.selected.includes(k);
        return (
          <button
            key={k} type="button" onClick={() => props.onToggle(k)}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${on ? props.activeClass : "border-white/20 text-gray-400"}`}
            title={COMPETENCY_LABEL[k as keyof typeof COMPETENCY_LABEL]}
          >
            {k}
          </button>
        );
      })}
    </div>
  );
}

export function SocialDebugDialog(props: {
  snapshot: SocialPeerDebugSnapshot | null;
  onApply: (params: SocialPeerParams) => void;
  /** Effective peer voice-pitch shift (semitones) currently applied. */
  voicePitch: number;
  /** Live client-side override — takes effect immediately, no peer restart. */
  onVoicePitchChange: (semitones: number) => void;
  /** Effective peer formant shift (semitones) currently applied. */
  voiceFormant: number;
  /** Live client-side override of the formant shift. */
  onVoiceFormantChange: (semitones: number) => void;
  onClose: () => void;
}) {
  const { snapshot } = props;
  const [draft, setDraft] = useState<SocialPeerParams | null>(null);
  const [interestsText, setInterestsText] = useState("");
  const [stancesText, setStancesText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Seed the editable draft once data arrives; thereafter only "Reset to current"
  // re-pulls (so live per-turn updates don't clobber in-progress edits).
  const seed = (p: SocialPeerParams) => {
    setDraft(structuredClone(p));
    setInterestsText(JSON.stringify(p.interests, null, 2));
    setStancesText(JSON.stringify(p.stances, null, 2));
    setJsonError(null);
  };
  useEffect(() => { if (!draft && snapshot) seed(snapshot.params); }, [snapshot, draft]);

  const set = <K extends keyof SocialPeerParams>(k: K, v: SocialPeerParams[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setGenome = (k: keyof SocialPeerParams["genome"], v: number) =>
    setDraft((d) => (d ? { ...d, genome: { ...d.genome, [k]: v } } : d));
  const setSlp = <K extends keyof SocialPeerParams["slp"]>(k: K, v: SocialPeerParams["slp"][K]) =>
    setDraft((d) => (d ? { ...d, slp: { ...d.slp, [k]: v } } : d));
  const toggleSkill = (field: "goalDimensions" | "lockedDimensions", k: string) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = d.slp[field] as string[];
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      return { ...d, slp: { ...d.slp, [field]: next as any } };
    });

  const apply = () => {
    if (!draft) return;
    let interests: Record<string, number>;
    let stances: Record<string, { position: number; conviction: number }>;
    try { interests = JSON.parse(interestsText); } catch { setJsonError("Interests is not valid JSON"); return; }
    try { stances = JSON.parse(stancesText); } catch { setJsonError("Stances is not valid JSON"); return; }
    setJsonError(null);
    props.onApply({ ...draft, interests, stances });
  };

  const live = snapshot?.live;
  const skillsSorted = useMemo(
    () => (live ? [...live.skills].sort((a, b) => a.value - b.value) : []),
    [live],
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-stretch justify-end bg-black/40" onClick={props.onClose}>
      <div
        className="w-full max-w-md h-full overflow-y-auto bg-gray-900 text-gray-100 border-l border-white/10 p-4 space-y-4"
        dir="ltr"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between sticky top-0 bg-gray-900 pb-2 -mt-1">
          <h2 className="text-sm font-semibold">Social Trainer — Debug</h2>
          <div className="flex gap-2">
            {snapshot && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => seed(snapshot.params)}>Reset</Button>}
            <Button size="sm" className="h-7 text-xs bg-yellow-500 hover:bg-yellow-400 text-black" onClick={apply} disabled={!draft}>Apply &amp; restart</Button>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={props.onClose}><X className="w-4 h-4" /></Button>
          </div>
        </div>

        {/* Voice — live client-side shifts, apply immediately (no restart). */}
        <section className="space-y-1">
          <h3 className="text-xs font-semibold text-yellow-300 uppercase tracking-wide">Voice (live)</h3>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 text-gray-300">Pitch (semitones)</span>
            <input
              type="range" min={-6} max={12} step={1} value={props.voicePitch}
              onChange={(e) => props.onVoicePitchChange(Number(e.target.value))}
              className="flex-1 accent-yellow-400"
            />
            <span className="w-10 text-right tabular-nums text-gray-100">
              {props.voicePitch > 0 ? `+${props.voicePitch}` : props.voicePitch}
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 text-gray-300">Formant (semitones)</span>
            <input
              type="range" min={-6} max={12} step={1} value={props.voiceFormant}
              onChange={(e) => props.onVoiceFormantChange(Number(e.target.value))}
              className="flex-1 accent-yellow-400"
            />
            <span className="w-10 text-right tabular-nums text-gray-100">
              {props.voiceFormant > 0 ? `+${props.voiceFormant}` : props.voiceFormant}
            </span>
          </label>
          <p className="text-[10px] text-gray-500">Both seed from the student's age. Formant (vocal-tract) is the main "younger" cue — keep it above pitch; pitch alone just sounds higher.</p>
        </section>

        {!snapshot && <p className="text-xs text-gray-400">Waiting for session data…</p>}

        {draft && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-yellow-300 uppercase tracking-wide">Parameters</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="flex flex-col gap-0.5">Name
                <input className="bg-gray-800 rounded px-1 py-0.5" value={draft.name} onChange={(e) => set("name", e.target.value)} />
              </label>
              <label className="flex flex-col gap-0.5">Gender
                <select className="bg-gray-800 rounded px-1 py-0.5" value={draft.gender} onChange={(e) => set("gender", e.target.value as any)}>
                  <option value="male">male</option><option value="female">female</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">Archetype
                <select className="bg-gray-800 rounded px-1 py-0.5" value={draft.archetype} onChange={(e) => set("archetype", e.target.value)}>
                  {ARCHETYPES.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-0.5">Humor
                <select className="bg-gray-800 rounded px-1 py-0.5" value={draft.humorStyle} onChange={(e) => set("humorStyle", e.target.value)}>
                  {HUMOR_STYLES.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-0.5 col-span-2">Model
                <input className="bg-gray-800 rounded px-1 py-0.5" value={draft.model} onChange={(e) => set("model", e.target.value)} />
              </label>
            </div>

            <div className="space-y-1 pt-1">
              <h4 className="text-[11px] text-gray-400">Genome</h4>
              {GENOME_TRAITS.map((t) => (
                <Slider key={t.key} label={t.label} value={draft.genome[t.key]} min={0} max={1} step={0.01} onChange={(v) => setGenome(t.key, v)} />
              ))}
            </div>

            <div className="space-y-1 pt-1">
              <Slider label="Difficulty" value={draft.difficulty} min={0} max={1} step={0.01} onChange={(v) => set("difficulty", v)} />
              <label className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 text-gray-300">Language level</span>
                <select className="bg-gray-800 rounded px-1 py-0.5 flex-1" value={draft.languageLevelInt} onChange={(e) => set("languageLevelInt", Number(e.target.value))}>
                  {LANGUAGE_LEVELS.map((l, i) => <option key={i} value={i + 1}>{l}</option>)}
                </select>
              </label>
              <Slider label="Challenge ceiling" value={draft.slp.maxChallengeIntensity} min={0} max={1} step={0.05} onChange={(v) => setSlp("maxChallengeIntensity", v)} />
              <Slider label="Challenge ratio" value={draft.slp.challengeRatio} min={0} max={1} step={0.05} onChange={(v) => setSlp("challengeRatio", v)} />
            </div>

            <div className="space-y-1 pt-1">
              <h4 className="text-[11px] text-gray-400">Goal skills</h4>
              <SkillChips selected={draft.slp.goalDimensions} onToggle={(k) => toggleSkill("goalDimensions", k)} activeClass="border-emerald-400 text-emerald-300 bg-emerald-400/10" />
              <h4 className="text-[11px] text-gray-400 pt-1">Locked skills</h4>
              <SkillChips selected={draft.slp.lockedDimensions} onToggle={(k) => toggleSkill("lockedDimensions", k)} activeClass="border-red-400 text-red-300 bg-red-400/10" />
            </div>

            <div className="space-y-1 pt-1">
              <h4 className="text-[11px] text-gray-400">Interests (topic → −1..1)</h4>
              <textarea className="w-full h-20 bg-gray-800 rounded p-1 font-mono text-[10px]" value={interestsText} onChange={(e) => setInterestsText(e.target.value)} />
              <h4 className="text-[11px] text-gray-400">Stances (prop → {`{position, conviction}`})</h4>
              <textarea className="w-full h-20 bg-gray-800 rounded p-1 font-mono text-[10px]" value={stancesText} onChange={(e) => setStancesText(e.target.value)} />
              {jsonError && <p className="text-[10px] text-red-400">{jsonError}</p>}
            </div>
          </section>
        )}

        {live && (
          <section className="space-y-2 border-t border-white/10 pt-3">
            <h3 className="text-xs font-semibold text-yellow-300 uppercase tracking-wide">Live internals — turn {live.turnIndex}</h3>
            <div className="grid grid-cols-3 gap-1 text-[11px] font-mono">
              <div>mode: {live.mode}</div>
              <div>scaffold: {live.scaffolding.toFixed(2)}</div>
              <div>askShare: {live.askShare.toFixed(2)}</div>
              <div>val: {live.vector.valence.toFixed(2)}</div>
              <div>aro: {live.vector.arousal.toFixed(2)}</div>
              <div>rap: {live.vector.rapport.toFixed(2)}</div>
            </div>
            <div className="text-[11px] font-mono text-gray-300">
              directive: {live.directive.tone} / {live.directive.pragmaticMove} / energy {live.directive.energy.toFixed(2)} / len {live.directive.lengthHint}
              {live.directive.identityMove ? ` / move ${live.directive.identityMove}` : ""}
              {live.directive.probe ? ` / probe ${live.directive.probe}` : ""}
            </div>
            <div className="text-[11px] font-mono text-gray-300">
              challenge: {live.lastChallenge.probe}{live.lastChallenge.dim ? ` (${live.lastChallenge.dim} @ ${live.lastChallenge.intensity.toFixed(2)})` : ""}
            </div>
            <div>
              <h4 className="text-[11px] text-gray-400">Skills (weakest first, sampled)</h4>
              <div className="text-[10px] font-mono space-y-0.5 max-h-32 overflow-y-auto">
                {skillsSorted.filter((s) => s.samples > 0).map((s) => (
                  <div key={s.competency} className="flex justify-between">
                    <span>{s.competency}</span><span>{s.value.toFixed(2)} ({s.samples})</span>
                  </div>
                ))}
              </div>
            </div>
            {live.moments.length > 0 && (
              <div className="text-[10px] text-gray-400">
                moments: {live.moments.map((m) => `${m.kind}`).join(", ")}
              </div>
            )}
            <details className="text-[10px]">
              <summary className="cursor-pointer text-gray-400">engine params + user model (raw)</summary>
              <pre className="whitespace-pre-wrap break-all bg-gray-800 rounded p-1 mt-1">{JSON.stringify({ engineParams: live.engineParams, userModel: live.userModel }, null, 2)}</pre>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}
