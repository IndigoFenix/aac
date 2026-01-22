import { useState, useEffect, useRef } from "react";
import { useTwoHandedObjectDetection } from "./useTwoHandedObjectDetection";

interface DetectedObject {
  id: string;
  label: string;
  emoji: string;
  confidence: number;
  hand: 'left' | 'right';
}

interface Symbol {
  id: string;
  label: string;
  emoji: string;
  confidence: number;
  reasoning: string;
}

interface UseObjectDetectionSymbolsProps {
  isEnabled: boolean;
  contextualSymbols: Symbol[];
  studentId: string | null;
  language?: string;
}

export function useObjectDetectionSymbols({
  isEnabled,
  contextualSymbols,
  studentId,
  language = "en"
}: UseObjectDetectionSymbolsProps) {
  const [detectedSymbols, setDetectedSymbols] = useState<Symbol[]>([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const lastDetectionRef = useRef<any>(null);
  
  const { lastDetection, isDetecting: hookIsDetecting } = useTwoHandedObjectDetection(isEnabled);

  // Convert card numbers to actual numbers when detected
  const processCardNumber = (label: string, emoji: string): { label: string; emoji: string } => {
    // Check if this is a playing card with a number
    const cardMatch = label.toLowerCase().match(/(\d+|ace|king|queen|jack)\s*(?:of\s*(?:hearts?|diamonds?|clubs?|spades?))?/);
    if (cardMatch) {
      const cardValue = cardMatch[1];
      // Convert face cards and ace to numbers/symbols
      if (cardValue === 'ace') return { label: '1', emoji: '1️⃣' };
      if (cardValue === 'jack') return { label: '11', emoji: '🃏' };
      if (cardValue === 'queen') return { label: '12', emoji: '👸' };
      if (cardValue === 'king') return { label: '13', emoji: '👑' };
      
      // For numbered cards, show the number
      const num = parseInt(cardValue);
      if (num >= 1 && num <= 10) {
        const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        return { 
          label: cardValue, 
          emoji: numberEmojis[num - 1] || `${num}️⃣`
        };
      }
    }
    
    return { label, emoji };
  };

  // Convert detected objects to symbols
  const convertDetectedObjectsToSymbols = (result: any): Symbol[] => {
    const symbols: Symbol[] = [];
    
    if (result?.leftHandObject) {
      const left = result.leftHandObject;
      const processed = processCardNumber(left.label, left.emoji);
      symbols.push({
        id: `detected_left_${left.id}`,
        label: processed.label,
        emoji: processed.emoji,
        confidence: left.confidence,
        reasoning: `Detected in left hand: ${left.label}`
      });
    }
    
    if (result?.rightHandObject) {
      const right = result.rightHandObject;
      const processed = processCardNumber(right.label, right.emoji);
      symbols.push({
        id: `detected_right_${right.id}`,
        label: processed.label,
        emoji: processed.emoji,
        confidence: right.confidence,
        reasoning: `Detected in right hand: ${right.label}`
      });
    }
    
    return symbols;
  };

  // Update detected symbols when objects change
  useEffect(() => {
    if (!isEnabled) {
      setDetectedSymbols([]);
      setIsDetecting(false);
      return;
    }

    setIsDetecting(hookIsDetecting);

    if (lastDetection) {
      // Check if detection has changed
      const hasChanged = 
        JSON.stringify(lastDetectionRef.current) !== JSON.stringify(lastDetection);
      
      if (hasChanged) {
        console.log('Object detection changed:', lastDetection);
        lastDetectionRef.current = lastDetection;
        
        // Convert to symbols
        const newSymbols = convertDetectedObjectsToSymbols(lastDetection);
        setDetectedSymbols(newSymbols);
        
        if (newSymbols.length > 0) {
          console.log('Generated object detection symbols:', newSymbols);
        } else {
          console.log('No objects detected, reverting to contextual symbols');
        }
      }
    }
  }, [lastDetection, isEnabled, hookIsDetecting]);

  // Return detected symbols if available, otherwise contextual symbols
  const finalSymbols = isEnabled && detectedSymbols.length > 0 
    ? detectedSymbols 
    : contextualSymbols;

  return {
    symbols: finalSymbols,
    isDetecting,
    hasDetectedObjects: detectedSymbols.length > 0,
    detectedObjects: detectedSymbols
  };
}