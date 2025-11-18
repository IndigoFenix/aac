import { ThemeProvider } from '../ThemeProvider';
import { MainCanvas } from '../MainCanvas';

export default function MainCanvasExample() {
  const mockMessages = [
    {
      id: "1",
      role: "assistant" as const,
      content: "Hello! I'm here to help you with AAC board generation and documentation.",
      timestamp: "10:30 AM"
    },
    {
      id: "2",
      role: "user" as const,
      content: "Can you help me create a communication board for Sarah?",
      timestamp: "10:31 AM"
    },
    {
      id: "3",
      role: "assistant" as const,
      content: "Of course! I can help you generate a customized AAC board for Sarah. What topics or vocabulary categories would you like to include?",
      timestamp: "10:31 AM"
    }
  ];

  return (
    <ThemeProvider>
      <div className="h-screen bg-background">
        <MainCanvas messages={mockMessages} />
      </div>
    </ThemeProvider>
  );
}
