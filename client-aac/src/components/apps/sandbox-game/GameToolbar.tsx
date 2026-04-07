// Sandbox Game — Tool selection sidebar

import { memo } from 'react';
import type { ToolId } from './types';
import { PLACEABLE_TOOLS, SPECIAL_TOOLS } from './elements';

interface GameToolbarProps {
  selectedTool: ToolId | null;
  onSelectTool: (tool: ToolId | null) => void;
  playerEnergy: number;
  maxPlayerEnergy: number;
  harvested: number;
}

const GameToolbar = memo(function GameToolbar({
  selectedTool,
  onSelectTool,
  playerEnergy,
  maxPlayerEnergy,
  harvested,
}: GameToolbarProps) {
  return (
    <div className="flex flex-col gap-2 p-2 overflow-y-auto">
      {/* Energy bar */}
      <div className="text-center text-xs font-bold text-white mb-1">
        <div className="flex items-center gap-1 justify-center">
          <span>⚡</span>
          <span>{playerEnergy}/{maxPlayerEnergy}</span>
        </div>
        <div className="w-full h-2 bg-gray-700 rounded-full mt-1">
          <div
            className="h-full bg-yellow-400 rounded-full transition-all duration-300"
            style={{ width: `${(playerEnergy / maxPlayerEnergy) * 100}%` }}
          />
        </div>
      </div>

      {/* Score */}
      <div className="text-center text-xs font-bold text-amber-300 mb-1">
        🧺 {harvested}
      </div>

      <div className="border-t border-gray-600 my-1" />

      {/* Placeable elements */}
      {PLACEABLE_TOOLS.map((element) => (
        <button
          data-dwell
          key={element.type}
          onClick={() => onSelectTool(selectedTool === element.type ? null : element.type)}
          className={`flex flex-col items-center justify-center p-1.5 rounded-xl font-bold text-xs transition-all select-none touch-none ${
            selectedTool === element.type
              ? 'bg-yellow-400 text-gray-900 scale-105 shadow-lg'
              : 'bg-gray-700 text-white hover:bg-gray-600 active:scale-95'
          }`}
          aria-label={`Select ${element.label} tool`}
        >
          <span className="text-lg leading-none">{element.icons[0]}</span>
          <span className="mt-0.5 leading-tight">{element.label}</span>
          <span className="text-[10px] opacity-60">⚡{element.placeCost}</span>
        </button>
      ))}

      <div className="border-t border-gray-600 my-1" />

      {/* Special tools */}
      {SPECIAL_TOOLS.map((tool) => (
        <button
          data-dwell
          key={tool.id}
          onClick={() => onSelectTool(selectedTool === tool.id ? null : tool.id)}
          className={`flex flex-col items-center justify-center p-1.5 rounded-xl font-bold text-xs transition-all select-none touch-none ${
            selectedTool === tool.id
              ? 'bg-yellow-400 text-gray-900 scale-105 shadow-lg'
              : 'bg-gray-700 text-white hover:bg-gray-600 active:scale-95'
          }`}
          aria-label={`Select ${tool.label} tool`}
        >
          <span className="text-lg leading-none">{tool.icon}</span>
          <span className="mt-0.5 leading-tight">{tool.label}</span>
          <span className="text-[10px] opacity-60">⚡{tool.cost}</span>
        </button>
      ))}
    </div>
  );
});

export default GameToolbar;
