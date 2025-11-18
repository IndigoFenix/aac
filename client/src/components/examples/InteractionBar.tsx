import { ThemeProvider } from '../ThemeProvider';
import { InteractionBar } from '../InteractionBar';

export default function InteractionBarExample() {
  return (
    <ThemeProvider>
      <div className="bg-background">
        <InteractionBar />
      </div>
    </ThemeProvider>
  );
}
