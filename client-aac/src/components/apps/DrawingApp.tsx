// client-aac/src/components/apps/DrawingApp.tsx
// Full-screen drawing canvas overlay with large color buttons

import { useEffect, useRef, useState, useCallback } from "react";
import { X, Eraser, Trash2, Pencil } from "lucide-react";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { useLanguage } from "@/contexts/LanguageContext";

const COLORS = [
  { name: "Black", hex: "#222222" },
  { name: "Red", hex: "#EF4444" },
  { name: "Orange", hex: "#F97316" },
  { name: "Yellow", hex: "#EAB308" },
  { name: "Green", hex: "#22C55E" },
  { name: "Blue", hex: "#3B82F6" },
  { name: "Purple", hex: "#A855F7" },
  { name: "Pink", hex: "#EC4899" },
];

const BRUSH_SIZE = 12;
const ERASER_SIZE = 32;

// Eyegaze speed-based drawing constants.
// In eyegaze mode the pen follows the gaze and draws only while the gaze glides
// SLOWLY. Holding still or flicking across the canvas quickly does NOT draw — so
// the student controls the pen purely with how fast they move their eyes, with
// no dwell/toggle to fight jitter.
const DRAW_MIN_SPEED = 60;    // px/s — at or below this the gaze is "holding still" → no draw
const DRAW_MAX_SPEED = 700;   // px/s — at or above this the gaze is "moving fast" → no draw
const SPEED_SMOOTHING = 0.5;  // 0..1 weight on the previous speed sample (EMA to damp gaze jitter)
// Before a stroke "takes", the gaze must travel this far while in the slow-draw
// band. This rejects the brief pass through the band as a fast flick decelerates
// (which otherwise dropped a stray dot right where the gaze came to rest).
const DRAW_COMMIT_DISTANCE = 24; // px

interface DrawingAppProps {
  onClose: () => void;
  /** Register canvas capture function for detection integration */
  onRegisterCapture?: (fn: (() => Promise<Blob | null>) | null) => void;
}

export default function DrawingApp({ onClose, onRegisterCapture }: DrawingAppProps) {
  const { t } = useLanguage();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeColor, setActiveColor] = useState(COLORS[0].hex);
  const [isEraser, setIsEraser] = useState(false);
  const drawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  // ── Eyegaze state ──
  const { gazePosition, mode: dwellMode } = useEyeTrackingDwell();
  const [gazeDrawing, setGazeDrawing] = useState(false);
  const gazeDrawingRef = useRef(false);
  const [gazeCanvasPos, setGazeCanvasPos] = useState<{ x: number; y: number } | null>(null);
  const gazeLastCanvasPosRef = useRef<{ x: number; y: number } | null>(null);
  // Pending-stroke accumulation: where the slow-draw band was entered, the last
  // sample, and the distance travelled so far — a stroke only commits once this
  // distance passes DRAW_COMMIT_DISTANCE.
  const pendingStartRef = useRef<{ x: number; y: number } | null>(null);
  const pendingLastRef = useRef<{ x: number; y: number } | null>(null);
  const pendingDistRef = useRef(0);
  // Previous gaze sample in screen space (+ timestamp) and the smoothed speed,
  // used to decide "slow enough to draw".
  const gazeLastScreenRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const speedEmaRef = useRef(0);
  const gazePosRef = useRef(gazePosition);
  gazePosRef.current = gazePosition;

  // Register canvas capture function for detection
  useEffect(() => {
    if (!onRegisterCapture) return;

    const capture = async (): Promise<Blob | null> => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/png");
      });
    };

    onRegisterCapture(capture);
    return () => onRegisterCapture(null);
  }, [onRegisterCapture]);

  // Initialize canvas with white background
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const getPos = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const draw = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = isEraser ? "#FFFFFF" : activeColor;
    ctx.lineWidth = isEraser ? ERASER_SIZE : BRUSH_SIZE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }, [activeColor, isEraser]);

  // Stable ref for draw so the eyegaze interval doesn't restart on color/eraser changes
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    const pos = getPos(e);
    lastPosRef.current = pos;
    // Draw a dot
    draw(pos, pos);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [getPos, draw]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !lastPosRef.current) return;
    const pos = getPos(e);
    draw(lastPosRef.current, pos);
    lastPosRef.current = pos;
  }, [getPos, draw]);

  const handlePointerUp = useCallback(() => {
    drawingRef.current = false;
    lastPosRef.current = null;
  }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  // ── Eyegaze speed-based drawing interval ──
  // The pen tracks the gaze and lays down ink only while the gaze moves slowly.
  // Moving fast (a saccade to look elsewhere) or holding still both lift the pen,
  // so drawing is controlled entirely by gaze speed — no dwell/toggle.
  useEffect(() => {
    const stopDrawing = () => {
      gazeLastCanvasPosRef.current = null;
      pendingStartRef.current = null;
      pendingLastRef.current = null;
      pendingDistRef.current = 0;
      if (gazeDrawingRef.current) {
        gazeDrawingRef.current = false;
        setGazeDrawing(false);
      }
    };

    if (dwellMode === "off") {
      setGazeCanvasPos(null);
      gazeLastScreenRef.current = null;
      speedEmaRef.current = 0;
      stopDrawing();
      return;
    }

    const interval = setInterval(() => {
      const gaze = gazePosRef.current;
      if (!gaze) {
        setGazeCanvasPos(null);
        gazeLastScreenRef.current = null;
        speedEmaRef.current = 0;
        stopDrawing();
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();

      // Gaze speed in screen space (px/s), smoothed to tame tracker jitter.
      const now = Date.now();
      const prev = gazeLastScreenRef.current;
      let speed = 0;
      if (prev) {
        const dt = Math.max(1, now - prev.t);
        const dist = Math.hypot(gaze.x - prev.x, gaze.y - prev.y);
        speed = dist / (dt / 1000);
        speedEmaRef.current = speedEmaRef.current * SPEED_SMOOTHING + speed * (1 - SPEED_SMOOTHING);
      } else {
        speedEmaRef.current = 0;
      }
      gazeLastScreenRef.current = { x: gaze.x, y: gaze.y, t: now };
      const smoothed = speedEmaRef.current;

      const isOverCanvas =
        gaze.x >= rect.left && gaze.x <= rect.right &&
        gaze.y >= rect.top && gaze.y <= rect.bottom;

      if (!isOverCanvas) {
        setGazeCanvasPos(null);
        stopDrawing();
        return;
      }

      const canvasPos = { x: gaze.x - rect.left, y: gaze.y - rect.top };
      setGazeCanvasPos(canvasPos);

      // Draw only in the "slow glide" band: not (nearly) still, not fast.
      const shouldDraw =
        prev !== null && smoothed >= DRAW_MIN_SPEED && smoothed <= DRAW_MAX_SPEED;

      if (shouldDraw) {
        if (gazeDrawingRef.current) {
          // Committed stroke — keep laying down ink along the gaze path.
          if (gazeLastCanvasPosRef.current) {
            drawRef.current(gazeLastCanvasPosRef.current, canvasPos);
          }
          gazeLastCanvasPosRef.current = canvasPos;
        } else if (!pendingStartRef.current) {
          // Just entered the slow band — start accumulating, but draw nothing yet.
          pendingStartRef.current = canvasPos;
          pendingLastRef.current = canvasPos;
          pendingDistRef.current = 0;
        } else {
          const last = pendingLastRef.current ?? canvasPos;
          pendingDistRef.current += Math.hypot(canvasPos.x - last.x, canvasPos.y - last.y);
          pendingLastRef.current = canvasPos;
          if (pendingDistRef.current >= DRAW_COMMIT_DISTANCE) {
            // The stroke has "taken": commit it, inking from where the slow
            // movement began through to here (so the lead-in isn't lost).
            drawRef.current(pendingStartRef.current, canvasPos);
            gazeLastCanvasPosRef.current = canvasPos;
            pendingStartRef.current = null;
            pendingLastRef.current = null;
            pendingDistRef.current = 0;
            gazeDrawingRef.current = true;
            setGazeDrawing(true);
          }
        }
      } else {
        stopDrawing();
      }
    }, 50);

    return () => clearInterval(interval);
  }, [dwellMode]);

  const btnBase = "flex items-center justify-center rounded-2xl font-bold shadow-lg active:scale-95 transition-transform select-none touch-none";

  return (
    <div
      className="h-full bg-gray-100 flex flex-col"
    >
      {/* Canvas area */}
      <div className="flex-1 relative overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          style={{ cursor: isEraser ? "cell" : "crosshair" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />

        {/* Eyegaze: idle brush ring at gaze position (pen up — move slowly to draw) */}
        {!gazeDrawing && gazeCanvasPos && dwellMode !== "off" && (
          <svg
            className="absolute pointer-events-none"
            style={{
              left: gazeCanvasPos.x - 20,
              top: gazeCanvasPos.y - 20,
              width: 40,
              height: 40,
            }}
          >
            <circle
              cx={20}
              cy={20}
              r={16}
              fill="none"
              stroke={isEraser ? "#9CA3AF" : activeColor}
              strokeWidth={2}
              strokeDasharray="3 4"
              opacity={0.5}
            />
          </svg>
        )}

        {/* Eyegaze: active brush ring at gaze position */}
        {gazeDrawing && gazeCanvasPos && dwellMode !== "off" && (
          <svg
            className="absolute pointer-events-none"
            style={{
              left: gazeCanvasPos.x - 20,
              top: gazeCanvasPos.y - 20,
              width: 40,
              height: 40,
            }}
          >
            <circle
              cx={20}
              cy={20}
              r={16}
              fill="none"
              stroke={isEraser ? "#9CA3AF" : activeColor}
              strokeWidth={3}
              opacity={0.6}
            />
          </svg>
        )}

        {/* Eyegaze: pen-down indicator badge */}
        {gazeDrawing && dwellMode !== "off" && (
          <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-white/90 rounded-full px-2.5 py-1.5 shadow-md pointer-events-none">
            <Pencil size={16} style={{ color: isEraser ? "#6B7280" : activeColor }} />
            <span className="text-xs font-medium text-gray-600">{t("appsBoard.appNames.drawing")}</span>
          </div>
        )}
      </div>

      {/* Controls bar */}
      <div className="flex items-center justify-center gap-3 px-4 py-4 bg-white border-t border-gray-200 flex-wrap">
        {/* Color buttons */}
        {COLORS.map((c) => (
          <button type="button"
            data-dwell
            key={c.hex}
            onClick={() => { setActiveColor(c.hex); setIsEraser(false); }}
            className={`${btnBase} w-14 h-14 border-4 ${
              !isEraser && activeColor === c.hex ? "border-gray-800 scale-110" : "border-transparent"
            }`}
            style={{ backgroundColor: c.hex }}
            aria-label={c.name}
          />
        ))}

        {/* Separator */}
        <div className="w-px h-12 bg-gray-300 mx-1" />

        {/* Eraser */}
        <button type="button"
          data-dwell
          onClick={() => setIsEraser(true)}
          className={`${btnBase} w-14 h-14 bg-gray-200 ${isEraser ? "ring-4 ring-gray-800 scale-110" : ""}`}
          aria-label={t("apps.drawing.eraser")}
        >
          <Eraser size={28} className="text-gray-700" />
        </button>

        {/* Clear */}
        <button type="button"
          data-dwell
          onClick={clearCanvas}
          className={`${btnBase} w-14 h-14 bg-yellow-100`}
          aria-label={t("apps.drawing.clear")}
        >
          <Trash2 size={28} className="text-yellow-700" />
        </button>

        {/* Close */}
        <button type="button"
          data-dwell
          onClick={onClose}
          className={`${btnBase} w-14 h-14 bg-red-500 text-white`}
          aria-label={t("common.close")}
        >
          <X size={28} />
        </button>
      </div>
    </div>
  );
}
