import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { X, Play, Pause, Volume2, VolumeX, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface YouTubePlayerProps {
  videoId: string;
  title?: string;
  onClose: () => void;
}

export function YouTubePlayer({ videoId, title = 'Video', onClose }: YouTubePlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const youtubeEmbedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=${isPlaying ? 1 : 0}&mute=${isMuted ? 1 : 0}&controls=1&rel=0`;

  const handlePlayPause = () => {
    setIsPlaying(!isPlaying);
  };

  const handleMuteToggle = () => {
    setIsMuted(!isMuted);
  };

  const handleRestart = () => {
    setIsPlaying(false);
    // Small delay to allow the iframe to reset
    setTimeout(() => setIsPlaying(true), 100);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50" data-testid="youtube-player-modal">
      <div className="bg-white rounded-lg shadow-2xl w-[90vw] max-w-4xl h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-800" data-testid="video-title">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            data-testid="button-close-player"
          >
            <X size={20} />
          </Button>
        </div>

        {/* Video Player */}
        <div className="flex-1 p-4">
          <div className="w-full h-full bg-black rounded-lg overflow-hidden">
            <iframe
              src={youtubeEmbedUrl}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              data-testid="youtube-iframe"
            />
          </div>
        </div>

        {/* Controls */}
        <div className="p-4 border-t border-gray-200 bg-gray-50">
          <div className="flex items-center justify-center space-x-4">
            <Button
              onClick={handlePlayPause}
              className={cn(
                "px-6 py-3 text-lg",
                isPlaying 
                  ? "bg-red-500 hover:bg-red-600 text-white" 
                  : "bg-green-500 hover:bg-green-600 text-white"
              )}
              data-testid={isPlaying ? "button-pause" : "button-play"}
            >
              {isPlaying ? (
                <>
                  <Pause size={20} className="mr-2" />
                  Pause Video
                </>
              ) : (
                <>
                  <Play size={20} className="mr-2" />
                  Play Video
                </>
              )}
            </Button>

            <Button
              onClick={handleMuteToggle}
              variant="outline"
              className="px-4 py-3"
              data-testid={isMuted ? "button-unmute" : "button-mute"}
            >
              {isMuted ? (
                <>
                  <VolumeX size={20} className="mr-2" />
                  Unmute
                </>
              ) : (
                <>
                  <Volume2 size={20} className="mr-2" />
                  Mute
                </>
              )}
            </Button>

            <Button
              onClick={handleRestart}
              variant="outline"
              className="px-4 py-3"
              data-testid="button-restart"
            >
              <RotateCcw size={20} className="mr-2" />
              Restart
            </Button>
          </div>

          {/* AAC Controls */}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
            <Button
              variant="outline"
              className="text-center py-2"
              onClick={() => setIsPlaying(true)}
              data-testid="button-i-want-watch"
            >
              <div className="text-sm">
                <div>▶️</div>
                <div>I want to watch</div>
              </div>
            </Button>

            <Button
              variant="outline"
              className="text-center py-2"
              onClick={() => setIsPlaying(false)}
              data-testid="button-stop-video"
            >
              <div className="text-sm">
                <div>⏹️</div>
                <div>Stop video</div>
              </div>
            </Button>

            <Button
              variant="outline"
              className="text-center py-2"
              onClick={handleMuteToggle}
              data-testid="button-too-loud"
            >
              <div className="text-sm">
                <div>{isMuted ? "🔊" : "🔇"}</div>
                <div>{isMuted ? "Turn on sound" : "Too loud"}</div>
              </div>
            </Button>

            <Button
              variant="outline"
              className="text-center py-2"
              onClick={onClose}
              data-testid="button-all-done"
            >
              <div className="text-sm">
                <div>✅</div>
                <div>All done</div>
              </div>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}