import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Settings, ImageIcon } from "lucide-react";
import { useBoardStore } from "@/store/board-store";
import { BoardIR } from "@/types/board-ir";

const COMMON_COVER_SYMBOLS = [
  { name: "SyntAACx", path: "syntaacx_logo", color: "#FFFFFFFF" }, // White background
  { name: "Communication", path: "[widgit]widgit rebus\\c\\communicate.emf", color: "#D6FFF6FF" },
  { name: "Activities", path: "[sstix#]50026.emf", color: "#FFE5D9FF" },
  { name: "Food", path: "[widgit]widgit rebus\\f\\food.emf", color: "#E5FFEEFF" },
  { name: "Family", path: "[widgit]widgit rebus\\f\\family.emf", color: "#FFEAF5FF" },
  { name: "Emotions", path: "[widgit]widgit rebus\\h\\happy.emf", color: "#FFFACDFF" },
  { name: "School", path: "[sstix#]1157.emf", color: "#E0F4FFFF" },
  { name: "Home", path: "[widgit]widgit rebus\\h\\home.emf", color: "#F0FFE0FF" },
  { name: "Play", path: "[widgit]widgit rebus\\p\\play.emf", color: "#FFE0E0FF" },
];

export function CoverImageSelector() {
  const { board, updateBoard } = useBoardStore();
  const [isOpen, setIsOpen] = useState(false);

  const handleCoverImageChange = (symbolPath: string) => {
    if (!board) return;
    
    const selectedSymbol = COMMON_COVER_SYMBOLS.find(s => s.path === symbolPath);
    
    const updatedBoard: BoardIR = {
      ...board,
      coverImage: {
        symbolPath,
        backgroundColor: selectedSymbol?.color || "#D6FFF6FF"
      }
    };
    
    updateBoard(updatedBoard);
  };

  const handleBackgroundColorChange = (backgroundColor: string) => {
    if (!board) return;
    
    const updatedBoard: BoardIR = {
      ...board,
      coverImage: {
        symbolPath: board.coverImage?.symbolPath || COMMON_COVER_SYMBOLS[0].path,
        backgroundColor
      }
    };
    
    updateBoard(updatedBoard);
  };

  if (!board) return null;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-xs">
          <ImageIcon size={14} className="mr-1" />
          Cover
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Board Cover Image</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-700 mb-2 block">
              Cover Symbol
            </label>
            <Select 
              value={board.coverImage?.symbolPath || ""} 
              onValueChange={handleCoverImageChange}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a cover symbol" />
              </SelectTrigger>
              <SelectContent>
                {COMMON_COVER_SYMBOLS.map((symbol) => (
                  <SelectItem key={symbol.path} value={symbol.path}>
                    {symbol.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <div>
            <label className="text-sm font-medium text-slate-700 mb-2 block">
              Background Color
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[
                "#D6FFF6FF", "#FFE5D9FF", "#E5FFEEFF", "#FFEAF5FF", 
                "#FFFACDFF", "#E0F4FFFF", "#F0FFE0FF", "#FFE0E0FF"
              ].map((color) => (
                <button
                  key={color}
                  className={`w-12 h-12 rounded border-2 ${
                    board.coverImage?.backgroundColor === color 
                      ? 'border-blue-500' 
                      : 'border-gray-300'
                  }`}
                  style={{ backgroundColor: color.replace('FF', '') }}
                  onClick={() => handleBackgroundColorChange(color)}
                />
              ))}
            </div>
          </div>
          
          <div className="text-xs text-slate-500">
            The cover image will appear as the thumbnail for this board set in Grid3.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}