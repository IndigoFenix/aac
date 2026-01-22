import { motion } from "framer-motion";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";

interface DynamicBoardProps {
  board: ParsedBoardData | null;
  onButtonClick: (button: BoardButton, spokenText: string) => void;
  language?: string;
}

// Map label to emoji
function getEmojiForLabel(label: string): string {
  const emojiMap: { [key: string]: string } = {
    "hello": "👋", "hi": "👋", "hey": "👋",
    "yes": "✅", "no": "❌", "maybe": "🤔",
    "help": "🆘", "please": "🙏", "thank you": "🙏", "thanks": "🙏",
    "more": "➕", "less": "➖", "stop": "🛑",
    "eat": "🍽️", "food": "🍽️", "hungry": "🍽️",
    "drink": "🥤", "water": "💧", "thirsty": "💧",
    "happy": "😊", "sad": "😢", "angry": "😠", "tired": "😴",
    "play": "🎮", "game": "🎮", "fun": "🎉",
    "home": "🏠", "school": "🏫", "outside": "🌳",
    "mom": "👩", "dad": "👨", "family": "👨‍👩‍👧",
    "love": "❤️", "like": "👍", "want": "👆",
    "go": "🚶", "come": "👋", "wait": "⏳",
    "bath": "🛁", "toilet": "🚽", "sleep": "😴",
  };

  const lowerLabel = label.toLowerCase();
  for (const [key, emoji] of Object.entries(emojiMap)) {
    if (lowerLabel.includes(key)) {
      return emoji;
    }
  }
  return "💬";
}

// Get button background color
function getButtonColor(color?: string): string {
  const colorMap: { [key: string]: string } = {
    "yellow": "#FEF3C7",
    "blue": "#DBEAFE",
    "green": "#D1FAE5",
    "red": "#FEE2E2",
    "orange": "#FFEDD5",
    "purple": "#EDE9FE",
    "pink": "#FCE7F3",
    "white": "#FFFFFF",
    "gray": "#F3F4F6",
  };
  return colorMap[color?.toLowerCase() || "white"] || color || "#FFFFFF";
}

export default function DynamicBoard({ board, onButtonClick, language = "en" }: DynamicBoardProps) {
  const { speak } = useTextToSpeech();

  if (!board || !board.pages || board.pages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <p className="text-sm">AI suggestions will appear here</p>
      </div>
    );
  }

  const currentPage = board.pages[0];
  const buttons = currentPage.buttons || [];

  const handleButtonClick = (button: BoardButton) => {
    const textToSpeak = button.spokenText || button.label;
    speak(textToSpeak, language);
    onButtonClick(button, textToSpeak);
  };

  return (
    <div className="flex flex-wrap gap-2 p-2 justify-center items-start content-start h-full overflow-y-auto">
      {buttons.map((button) => (
        <motion.button
          key={button.id}
          onClick={() => handleButtonClick(button)}
          className="flex flex-col items-center justify-center p-3 rounded-xl shadow-sm border border-gray-200 min-w-[80px] max-w-[100px]"
          style={{ backgroundColor: getButtonColor(button.color) }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          {button.symbolPath ? (
            <img
              src={button.symbolPath}
              alt={button.label}
              className="w-10 h-10 object-contain mb-1"
            />
          ) : button.iconRef ? (
            <i className={`${button.iconRef} text-2xl mb-1`} />
          ) : (
            <span className="text-2xl mb-1">
              {getEmojiForLabel(button.label)}
            </span>
          )}
          <span className="text-xs font-medium text-center text-gray-800 leading-tight">
            {button.label}
          </span>
        </motion.button>
      ))}
    </div>
  );
}
