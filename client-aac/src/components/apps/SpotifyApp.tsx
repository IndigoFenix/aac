// client-aac/src/components/apps/SpotifyApp.tsx
// Full-screen Spotify embed overlay with accessible close button

import { motion } from "framer-motion";
import { X } from "lucide-react";

interface SpotifyAppProps {
  trackId: string;
  title: string;
  artist: string;
  onClose: () => void;
}

export default function SpotifyApp({ trackId, title, artist, onClose }: SpotifyAppProps) {
  const embedUrl = `https://open.spotify.com/embed/track/${trackId}?utm_source=generator&theme=0`;

  const btnBase = "flex items-center justify-center rounded-2xl font-bold shadow-lg active:scale-95 transition-transform select-none";

  return (
    <motion.div
      className="fixed inset-0 z-50 bg-gradient-to-b from-gray-900 to-black flex flex-col"
      data-dwell-trap
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
    >
      {/* Header */}
      <div className="relative z-10 flex items-center gap-3 px-4 py-3">
        <span className="text-4xl">🎧</span>
        <div className="flex-1 min-w-0">
          <p className="text-white text-lg font-semibold truncate">{title}</p>
          {artist && <p className="text-gray-400 text-sm truncate">{artist}</p>}
        </div>
      </div>

      {/* Spotify Embed — fills remaining space */}
      <div className="flex-1 flex items-center justify-center px-4">
        <iframe
          src={embedUrl}
          width="100%"
          height="352"
          frameBorder="0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
          style={{ borderRadius: "12px", maxWidth: "600px" }}
          title={`Spotify: ${title}`}
        />
      </div>

      {/* Close button at bottom — large and visible */}
      <div className="px-3 pb-4">
        <button
          data-dwell
          onClick={onClose}
          className={`${btnBase} w-full h-14 bg-red-500 text-white text-lg gap-2`}
          aria-label="Close Spotify"
        >
          <X size={24} />
          Close
        </button>
      </div>
    </motion.div>
  );
}
