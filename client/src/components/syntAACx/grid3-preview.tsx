import { useBoardStore } from "@/store/board-store";
import { cn } from "@/lib/utils";
import { Monitor } from "lucide-react";
import { useState } from "react";
import { YouTubePlayer } from "./youtube-player";

export function Grid3Preview() {
  const { board, currentPageId, selectedButtonId, selectButton } = useBoardStore();
  const [activeVideo, setActiveVideo] = useState<{ videoId: string; title: string } | null>(null);

  if (!board) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ backgroundColor: '#f0f0f0' }}>
        <div className="text-center text-gray-600">
          <Monitor className="w-16 h-16 mx-auto mb-4" style={{ color: '#666' }} />
          <h3 className="text-lg font-medium mb-2">Grid3 Preview</h3>
          <p className="text-sm">Generate a board to see Grid3 preview</p>
        </div>
      </div>
    );
  }

  const currentPage = board.pages.find((p: any) => p.id === currentPageId) || board.pages[0];

  const getButtonColor = (color?: string) => {
    // Authentic Grid3 colors - more muted and realistic
    const colorMap: { [key: string]: string } = {
      '#3B82F6': '#3b7dd8', // Blue - more muted
      '#10B981': '#52c41a', // Green 
      '#F59E0B': '#fa8c16', // Orange/Yellow
      '#EF4444': '#ff4d4f', // Red
      '#8B5CF6': '#722ed1', // Purple
      '#F97316': '#fa8c16', // Orange
      '#06B6D4': '#13c2c2', // Cyan
      '#84CC16': '#7cb305', // Lime
    };
    return colorMap[color || '#3b7dd8'] || color || '#3b7dd8';
  };

  const handleButtonClick = (button: any) => {
    // If button has YouTube action, show video player
    if (button.action?.type === 'youtube') {
      setActiveVideo({
        videoId: button.action.videoId,
        title: button.action.title || button.label
      });
      return;
    }
    
    // Otherwise, select the button for editing (though in Grid3 preview we might want to speak instead)
    selectButton(button.id);
  };

  const handleCloseVideo = () => {
    setActiveVideo(null);
  };

  return (
    <div className="flex-1 flex flex-col" style={{ backgroundColor: '#f0f0f0' }}>
      {/* Authentic Grid3 Header Bar */}
      <div className="px-4 py-2 border-b" style={{ backgroundColor: '#ffffff', borderColor: '#d9d9d9' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="text-base font-medium" style={{ color: '#333' }}>
              {board.name}
            </div>
          </div>
          <div className="text-sm" style={{ color: '#666' }}>
            Page {board.pages.findIndex((p: any) => p.id === currentPageId) + 1} of {board.pages.length}
          </div>
        </div>
      </div>

      {/* Grid3 Canvas Area */}
      <div className="flex-1 p-4 overflow-auto" style={{ backgroundColor: '#f0f0f0' }}>
        <div className="max-w-4xl mx-auto">
          {/* Authentic Grid3 Grid Container */}
          <div className="rounded border" style={{ backgroundColor: '#ffffff', borderColor: '#d9d9d9' }}>
            <div className="p-4">
              <div 
                className="grid mx-auto"
                style={{ 
                  gridTemplateColumns: `repeat(${board.grid.cols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${board.grid.rows}, minmax(0, 1fr))`,
                  gap: '4px',
                  maxWidth: '800px',
                  aspectRatio: board.grid.cols > board.grid.rows ? `${board.grid.cols * 1.2}/${board.grid.rows}` : `${board.grid.cols}/${board.grid.rows * 0.9}`
                }}
              >
                {Array.from({ length: board.grid.rows * board.grid.cols }, (_, index) => {
                  const row = Math.floor(index / board.grid.cols);
                  const col = index % board.grid.cols;
                  
                  // Check for video player first
                  const videoPlayer = currentPage.videoPlayers?.find((vp: any) => 
                    row >= vp.row && row < vp.row + vp.rowSpan &&
                    col >= vp.col && col < vp.col + vp.colSpan
                  );
                  
                  // Only render video player in its top-left cell
                  if (videoPlayer && row === videoPlayer.row && col === videoPlayer.col) {
                    return (
                      <div
                        key={videoPlayer.id}
                        className="rounded overflow-hidden"
                        style={{
                          gridColumn: `span ${videoPlayer.colSpan}`,
                          gridRow: `span ${videoPlayer.rowSpan}`,
                          backgroundColor: '#1f2937',
                          border: '1px solid rgba(0,0,0,0.1)',
                          aspectRatio: '16/9',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.1)'
                        }}
                        data-testid={`video-player-${videoPlayer.videoId}`}
                      >
                        <iframe
                          src={`https://www.youtube.com/embed/${videoPlayer.videoId}?controls=1&rel=0&modestbranding=1`}
                          title={videoPlayer.title}
                          className="w-full h-full"
                          frameBorder="0"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                      </div>
                    );
                  }
                  
                  // Skip rendering for cells occupied by video player (except top-left)
                  if (videoPlayer) {
                    return null;
                  }
                  
                  // Check for button
                  const button = currentPage.buttons.find((b: any) => b.row === row && b.col === col);
                  
                  if (button) {
                    return (
                      <button
                        key={button.id}
                        onClick={() => handleButtonClick(button)}
                        data-testid={`button-${button.label.toLowerCase().replace(/\s+/g, '-')}`}
                        className={cn(
                          "aspect-square rounded flex flex-col items-center justify-center p-1 transition-all relative overflow-hidden cursor-pointer",
                          selectedButtonId === button.id 
                            ? "ring-2 ring-blue-500 z-10" 
                            : ""
                        )}
                        style={{ 
                          backgroundColor: getButtonColor(button.color),
                          border: selectedButtonId === button.id ? '2px solid #1890ff' : '1px solid rgba(0,0,0,0.1)',
                          minHeight: '80px',
                          fontSize: '11px',
                          color: 'white',
                          fontWeight: '600',
                          textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                          boxShadow: selectedButtonId === button.id 
                            ? '0 0 0 2px #1890ff, 0 2px 4px rgba(0,0,0,0.1)' 
                            : '0 1px 3px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.3)'
                        }}
                      >
                        {/* Authentic Grid3 button styling */}
                        <div className="absolute inset-0 rounded" style={{
                          background: `linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 50%, rgba(0,0,0,0.1) 100%)`
                        }}></div>
                        
                        <div className="relative z-10 flex flex-col items-center justify-center h-full text-center">
                          {/* Icon or Symbol */}
                          <div className="mb-1">
                            {button.symbolPath ? (
                              <img 
                                src={button.symbolPath}
                                alt={button.label}
                                className="w-6 h-6 object-contain"
                                style={{ 
                                  filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.8)) brightness(1.1)',
                                  maxWidth: '24px',
                                  maxHeight: '24px'
                                }}
                                onError={(e) => {
                                  // Fallback to FontAwesome icon if SVG fails to load
                                  const target = e.target as HTMLImageElement;
                                  target.style.display = 'none';
                                  const fallbackIcon = target.nextElementSibling as HTMLElement;
                                  if (fallbackIcon) fallbackIcon.style.display = 'inline-block';
                                }}
                              />
                            ) : (
                              <i 
                                className={`${button.iconRef || 'fas fa-square'} text-base`}
                                style={{ textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}
                              ></i>
                            )}
                            {/* Fallback icon (hidden by default) */}
                            {button.symbolPath && (
                              <i 
                                className={`${button.iconRef || 'fas fa-square'} text-base`}
                                style={{ 
                                  textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                                  display: 'none'
                                }}
                              ></i>
                            )}
                          </div>
                          
                          {/* Text */}
                          <div 
                            className="leading-tight break-words max-w-full"
                            style={{ 
                              textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                              fontSize: button.label.length > 10 ? '9px' : button.label.length > 6 ? '10px' : '11px',
                              lineHeight: '1.1'
                            }}
                          >
                            {button.label}
                          </div>
                        </div>
                      </button>
                    );
                  }
                  
                  return (
                    <div
                      key={`empty-${index}`}
                      className="aspect-square rounded flex items-center justify-center transition-colors"
                      style={{
                        backgroundColor: '#fafafa',
                        border: '1px dashed #d9d9d9',
                        minHeight: '80px'
                      }}
                    >
                      <div style={{ color: '#ccc', fontSize: '20px' }}>+</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Grid3 Status Bar */}
      <div className="px-4 py-2 border-t text-sm" style={{ backgroundColor: '#fafafa', borderColor: '#d9d9d9', color: '#666' }}>
        <div className="flex justify-between items-center">
          <span>Smartbox Grid 3 - Communication Grid</span>
          <span>{currentPage.buttons.length} cells used • {board.grid.rows}×{board.grid.cols} grid</span>
        </div>
      </div>
      
      {/* YouTube Video Player Modal */}
      {activeVideo && (
        <YouTubePlayer
          videoId={activeVideo.videoId}
          title={activeVideo.title}
          onClose={handleCloseVideo}
        />
      )}
    </div>
  );
}