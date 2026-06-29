// client-aac/src/components/EnergyBar.tsx
//
// A slim vertical "energy" gauge shown beside the cave in the AAC header. It
// reflects the AAC token-budget meter's binding (tightest) window — i.e. how
// much AI budget is left before the cost throttle kicks in. The fill rises from
// the bottom and is colored by band (green / yellow / red), on a white track.
// Value is approximate (server pushes the integer % as it changes); the bar
// transitions smoothly between pushes.

interface EnergyBarProps {
  /** 0–100 remaining budget on the binding window. */
  percent: number;
  /** Coarse band driving the fill color. */
  band: "high" | "moderate" | "low";
  /** Localized accessible/tooltip label, e.g. "AI energy: 95%". */
  label: string;
}

const BAND_COLOR: Record<EnergyBarProps["band"], string> = {
  high: "#22c55e",     // green-500
  moderate: "#f59e0b", // amber-500
  low: "#ef4444",      // red-500
};

export function EnergyBar({ percent, band, label }: EnergyBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className="self-stretch flex items-center shrink-0"
      title={label}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="relative h-full min-h-[44px] w-2.5 overflow-hidden rounded-full border border-black/10 bg-white shadow-inner">
        <div
          className="absolute inset-x-0 bottom-0 rounded-full transition-[height,background-color] duration-700 ease-out"
          style={{ height: `${pct}%`, backgroundColor: BAND_COLOR[band] }}
        />
      </div>
    </div>
  );
}
