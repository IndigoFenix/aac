// shared/social-world/WorldDebugPanel.tsx
//
// A throwaway tuning panel for the eye-gaze movement + camera system. It edits a
// WorldTunables live and pushes every change straight into the running host
// (main thread OR the render worker), so you can feel the camera/gaze feel change
// as you drag. This is a DEBUG affordance — a per-student settings surface
// replaces it later (the WorldTunables shape is the forward contract), so it is
// deliberately unstyled-by-design and NOT translated (debug-only, per CLAUDE.md).

import type { CSSProperties } from "react";
import { DEFAULT_WORLD_TUNABLES, cloneWorldTunables, type WorldTunables } from "../world-engine/world-tunables.js";

interface Field {
  label: string;
  min: number;
  max: number;
  step: number;
  get: (t: WorldTunables) => number;
  set: (t: WorldTunables, v: number) => void;
}

interface Group {
  title: string;
  /** Only relevant to the 3D camera — dimmed/labelled when running 2D. */
  cam3dOnly?: boolean;
  fields: Field[];
}

const poseFields = (which: "overhead" | "shoulder"): Field[] => [
  { label: "height", min: 4, max: 50, step: 0.5, get: (t) => t.camera[which].height, set: (t, v) => (t.camera[which].height = v) },
  { label: "back", min: 0, max: 25, step: 0.5, get: (t) => t.camera[which].back, set: (t, v) => (t.camera[which].back = v) },
  { label: "lookAhead", min: 0, max: 25, step: 0.5, get: (t) => t.camera[which].lookAhead, set: (t, v) => (t.camera[which].lookAhead = v) },
  { label: "lookHeight", min: 0, max: 5, step: 0.1, get: (t) => t.camera[which].lookHeight, set: (t, v) => (t.camera[which].lookHeight = v) },
  { label: "fov", min: 30, max: 90, step: 1, get: (t) => t.camera[which].fov, set: (t, v) => (t.camera[which].fov = v) },
];

const GROUPS: Group[] = [
  {
    title: "Gaze interpreter",
    fields: [
      { label: "saccadeSpeedPx", min: 200, max: 6000, step: 50, get: (t) => t.gaze.saccadeSpeedPx, set: (t, v) => (t.gaze.saccadeSpeedPx = v) },
      { label: "settleMs", min: 0, max: 400, step: 5, get: (t) => t.gaze.settleMs, set: (t, v) => (t.gaze.settleMs = v) },
      { label: "commitEase", min: 2, max: 40, step: 1, get: (t) => t.gaze.commitEase, set: (t, v) => (t.gaze.commitEase = v) },
      { label: "unsettleEase", min: 2, max: 40, step: 1, get: (t) => t.gaze.unsettleEase, set: (t, v) => (t.gaze.unsettleEase = v) },
      { label: "weakenStrength", min: 0, max: 1, step: 0.05, get: (t) => t.gaze.weakenStrength, set: (t, v) => (t.gaze.weakenStrength = v) },
      { label: "sitGazeRadius", min: 0.5, max: 8, step: 0.25, get: (t) => t.gaze.sitGazeRadius, set: (t, v) => (t.gaze.sitGazeRadius = v) },
      { label: "idleSitMs", min: 500, max: 8000, step: 100, get: (t) => t.gaze.idleSitMs, set: (t, v) => (t.gaze.idleSitMs = v) },
    ],
  },
  {
    title: "Camera — turn + mode",
    cam3dOnly: true,
    fields: [
      { label: "follow", min: 1, max: 15, step: 0.5, get: (t) => t.camera.follow, set: (t, v) => (t.camera.follow = v) },
      { label: "yawStiffness", min: 0.5, max: 8, step: 0.1, get: (t) => t.camera.yawStiffness, set: (t, v) => (t.camera.yawStiffness = v) },
      { label: "yawDistGain", min: 0.5, max: 15, step: 0.25, get: (t) => t.camera.yawDistGain, set: (t, v) => (t.camera.yawDistGain = v) },
      { label: "yawDistMin", min: 0.5, max: 8, step: 0.25, get: (t) => t.camera.yawDistMin, set: (t, v) => (t.camera.yawDistMin = v) },
      { label: "moveThreshold", min: 0, max: 3, step: 0.05, get: (t) => t.camera.moveThreshold, set: (t, v) => (t.camera.moveThreshold = v) },
      { label: "travelEnterDist", min: 2, max: 25, step: 0.5, get: (t) => t.camera.travelEnterDist, set: (t, v) => (t.camera.travelEnterDist = v) },
      { label: "travelExitDist", min: 1, max: 20, step: 0.5, get: (t) => t.camera.travelExitDist, set: (t, v) => (t.camera.travelExitDist = v) },
      { label: "travelAheadEnter", min: -1, max: 1, step: 0.05, get: (t) => t.camera.travelAheadEnter, set: (t, v) => (t.camera.travelAheadEnter = v) },
      { label: "travelAheadExit", min: -1, max: 1, step: 0.05, get: (t) => t.camera.travelAheadExit, set: (t, v) => (t.camera.travelAheadExit = v) },
      { label: "travelEase", min: 0.25, max: 6, step: 0.25, get: (t) => t.camera.travelEase, set: (t, v) => (t.camera.travelEase = v) },
    ],
  },
  {
    title: "Interact",
    fields: [
      { label: "toyPickRadius", min: 0.5, max: 5, step: 0.1, get: (t) => t.interact.toyPickRadius, set: (t, v) => (t.interact.toyPickRadius = v) },
      { label: "avatarPickRadius", min: 0.5, max: 5, step: 0.1, get: (t) => t.interact.avatarPickRadius, set: (t, v) => (t.interact.avatarPickRadius = v) },
      { label: "npcStopDistance", min: 0.5, max: 6, step: 0.1, get: (t) => t.interact.npcStopDistance, set: (t, v) => (t.interact.npcStopDistance = v) },
    ],
  },
  { title: "Camera — overhead pose", cam3dOnly: true, fields: poseFields("overhead") },
  { title: "Camera — shoulder pose", cam3dOnly: true, fields: poseFields("shoulder") },
  {
    title: "Comfort",
    cam3dOnly: true,
    fields: [
      { label: "maxVignette", min: 0, max: 1, step: 0.05, get: (t) => t.comfort.maxVignette, set: (t, v) => (t.comfort.maxVignette = v) },
      { label: "vignetteInner", min: 0, max: 1, step: 0.05, get: (t) => t.comfort.vignetteInner, set: (t, v) => (t.comfort.vignetteInner = v) },
      { label: "refSpeed", min: 1, max: 15, step: 0.5, get: (t) => t.comfort.refSpeed, set: (t, v) => (t.comfort.refSpeed = v) },
      { label: "refYaw", min: 0.1, max: 3, step: 0.05, get: (t) => t.comfort.refYaw, set: (t, v) => (t.comfort.refYaw = v) },
      { label: "maxYawSpeed", min: 0.1, max: 4, step: 0.05, get: (t) => t.comfort.maxYawSpeed, set: (t, v) => (t.comfort.maxYawSpeed = v) },
      { label: "yawDeadband", min: 0, max: 0.5, step: 0.01, get: (t) => t.comfort.yawDeadband, set: (t, v) => (t.comfort.yawDeadband = v) },
      { label: "vignetteEase", min: 1, max: 15, step: 0.5, get: (t) => t.comfort.vignetteEase, set: (t, v) => (t.comfort.vignetteEase = v) },
    ],
  },
];

interface Props {
  tunables: WorldTunables;
  onChange: (t: WorldTunables) => void;
  renderer: "2d" | "3d";
  onClose?: () => void;
}

export default function WorldDebugPanel({ tunables, onChange, renderer, onClose }: Props) {
  const apply = (mut: (t: WorldTunables) => void): void => {
    const next = cloneWorldTunables(tunables);
    mut(next);
    onChange(next);
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 52,
        right: 8,
        width: 280,
        maxHeight: "calc(100% - 64px)",
        overflowY: "auto",
        background: "rgba(15,23,42,0.92)",
        border: "1px solid rgba(148,163,184,0.4)",
        borderRadius: 10,
        padding: 10,
        color: "#e2e8f0",
        font: "11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
        pointerEvents: "auto",
        zIndex: 20,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: 12 }}>World tuning</strong>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={() => onChange(cloneWorldTunables(DEFAULT_WORLD_TUNABLES))} style={btnStyle}>
            Reset
          </button>
          {onClose && (
            <button type="button" onClick={onClose} style={btnStyle} aria-label="Close debug panel">
              ✕
            </button>
          )}
        </div>
      </div>

      {renderer === "2d" && (
        <div style={{ marginBottom: 8, color: "#fbbf24" }}>
          2D view — only the gaze group affects it (the camera is a fixed follow).
        </div>
      )}

      {GROUPS.map((group) => (
        <div key={group.title} style={{ marginBottom: 10, opacity: group.cam3dOnly && renderer === "2d" ? 0.4 : 1 }}>
          <div style={{ color: "#94a3b8", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>
            {group.title}
          </div>
          {group.fields.map((f) => {
            const v = f.get(tunables);
            return (
              <label key={f.label} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                <span style={{ flex: "0 0 108px", overflow: "hidden", textOverflow: "ellipsis" }}>{f.label}</span>
                <input
                  type="range"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={v}
                  onChange={(e) => {
                    const nv = Number(e.target.value);
                    apply((t) => f.set(t, nv));
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <span style={{ flex: "0 0 44px", textAlign: "right", color: "#cbd5e1" }}>
                  {Number.isInteger(f.step) ? v.toFixed(0) : v.toFixed(2)}
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: "rgba(148,163,184,0.25)",
  color: "#e2e8f0",
  border: "1px solid rgba(148,163,184,0.4)",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
};
