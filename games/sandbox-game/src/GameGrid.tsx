// Sandbox Game — Grid renderer

import { memo, useCallback } from 'react';
import type { GameState, ToolId } from './types';
import { getElement } from './elements';

interface GameGridProps {
  gameState: GameState;
  selectedTool: ToolId | null;
  onCellClick: (x: number, y: number) => void;
  canPlace: (x: number, y: number, toolId: ToolId) => boolean;
}

const GameGrid = memo(function GameGrid({ gameState, selectedTool, onCellClick, canPlace }: GameGridProps) {
  const { grid, width, height } = gameState;

  return (
    <div
      className="grid gap-[2px] w-full h-full"
      style={{
        gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${height}, minmax(0, 1fr))`,
      }}
    >
      {Array.from({ length: height * width }, (_, index) => {
        const y = Math.floor(index / width);
        const x = index % width;
        return (
          <GridCell
            key={`${x}-${y}`}
            x={x}
            y={y}
            cell={grid[y][x]}
            selectedTool={selectedTool}
            canPlace={canPlace}
            onClick={onCellClick}
          />
        );
      })}
    </div>
  );
});

export default GameGrid;

interface GridCellProps {
  x: number;
  y: number;
  cell: { type: string; state: number; energy: number };
  selectedTool: ToolId | null;
  canPlace: (x: number, y: number, toolId: ToolId) => boolean;
  onClick: (x: number, y: number) => void;
}

const GridCell = memo(function GridCell({ x, y, cell, selectedTool, canPlace, onClick }: GridCellProps) {
  const element = getElement(cell.type as any);
  const color = element.colors[cell.state] ?? element.colors[0];
  const icon = element.icons[cell.state] ?? element.icons[0];
  const placeable = selectedTool ? canPlace(x, y, selectedTool) : false;

  const handleClick = useCallback(() => {
    onClick(x, y);
  }, [x, y, onClick]);

  return (
    <button
      data-dwell
      onClick={handleClick}
      className="relative flex items-center justify-center rounded-sm transition-all duration-150 select-none touch-none text-xs sm:text-sm"
      style={{
        backgroundColor: color,
        opacity: selectedTool && !placeable ? 0.6 : 1,
        outline: selectedTool && placeable ? '2px solid #fbbf24' : 'none',
        outlineOffset: '-1px',
      }}
      aria-label={`${element.label}${element.states.length > 1 ? ` (${element.states[cell.state]})` : ''} at ${x},${y}`}
    >
      <span className="leading-none pointer-events-none">{icon}</span>
      {/* Energy indicator for non-empty cells */}
      {cell.type !== 'empty' && cell.energy > 0 && (
        <span
          className="absolute bottom-0 left-0 right-0 h-[2px] rounded-b-sm"
          style={{
            backgroundColor: '#22c55e',
            width: `${Math.min(100, (cell.energy / element.defaultEnergy) * 100)}%`,
          }}
        />
      )}
    </button>
  );
});
