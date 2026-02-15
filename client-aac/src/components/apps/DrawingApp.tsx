// client-aac/src/components/apps/DrawingApp.tsx
// Full-screen drawing canvas overlay with large color buttons

import { useEffect, useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { X, Eraser, Trash2 } from "lucide-react";

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

interface DrawingAppProps {
  onClose: () => void;
  /** Register canvas capture function for detection integration */
  onRegisterCapture?: (fn: (() => Promise<Blob | null>) | null) => void;
}

export default function DrawingApp({ onClose, onRegisterCapture }: DrawingAppProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeColor, setActiveColor] = useState(COLORS[0].hex);
  const [isEraser, setIsEraser] = useState(false);
  const drawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

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

  const btnBase = "flex items-center justify-center rounded-2xl font-bold shadow-lg active:scale-95 transition-transform select-none touch-none";

  return (
    <motion.div
      className="fixed inset-0 z-50 bg-gray-100 flex flex-col"
      data-dwell-trap
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
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
      </div>

      {/* Controls bar */}
      <div className="flex items-center justify-center gap-3 px-4 py-4 bg-white border-t border-gray-200 flex-wrap">
        {/* Color buttons */}
        {COLORS.map((c) => (
          <button
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
        <button
          data-dwell
          onClick={() => setIsEraser(true)}
          className={`${btnBase} w-14 h-14 bg-gray-200 ${isEraser ? "ring-4 ring-gray-800 scale-110" : ""}`}
          aria-label="Eraser"
        >
          <Eraser size={28} className="text-gray-700" />
        </button>

        {/* Clear */}
        <button
          data-dwell
          onClick={clearCanvas}
          className={`${btnBase} w-14 h-14 bg-yellow-100`}
          aria-label="Clear"
        >
          <Trash2 size={28} className="text-yellow-700" />
        </button>

        {/* Close */}
        <button
          data-dwell
          onClick={onClose}
          className={`${btnBase} w-14 h-14 bg-red-500 text-white`}
          aria-label="Close"
        >
          <X size={28} />
        </button>
      </div>
    </motion.div>
  );
}
