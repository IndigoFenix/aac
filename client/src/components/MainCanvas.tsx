// src/components/MainCanvas.tsx
import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Plus, Settings2, Mic, Grid3x3, MessageCircle, FileText } from "lucide-react";
import { CommuniAACteFeature } from "@/features/CommuniAACteFeatureWrapper";
import { SyntAACxFeature } from "@/features/SyntAACxFeature";
import { useLocation, useNavigate } from "react-router-dom";
import { CliniAACianFeature } from "@/features/CliniAACianFeature";

type FeatureId = "boards" | "interpret" | "docuslp" | null;

export function MainCanvas() {
  const [prompt, setPrompt] = useState("");
  const [selectedTool, setSelectedTool] = useState("boards");
  const [isRecording, setIsRecording] = useState(false);
  // const [activeFeature, setActiveFeature] = useState<FeatureId>(null);

  const location = useLocation();
  const navigate = useNavigate();

  // Derive the active feature from the URL:
  // /dashboard                → null  (welcome)
  // /dashboard/boards       → "boards"
  // /dashboard/interpret    → "interpret"
  // /dashboard/interpret/xx → "interpret"
  // /dashboard/docuslp        → "docuslp"
  const getActiveFeatureFromPath = (): FeatureId => {
    const segments = location.pathname.split("/").filter(Boolean);
    // segments[0] = "dashboard"; segments[1] = feature slug (if present)
    const featureSlug = segments[0];

    console.log(location.pathname, "Feature slug from path:", featureSlug);

    switch (featureSlug) {
      case "boards":
        return "boards";
      case "interpret":
        return "interpret";
      case "docuslp":
        return "docuslp";
      default:
        return null;
    }
  };

  const activeFeature = getActiveFeatureFromPath();

  return (
    <div className="flex-1 min-w-0 min-h-0">
      {activeFeature === "boards" ? (
        // SyntAACx gets a fixed-height region (no outer scroll)
        <div className="h-full">
          <div className="h-full">
            <SyntAACxFeature />
          </div>
        </div>
      ) : (
        // Other features keep the ScrollArea
        <ScrollArea className="h-full px-6">
          <div className="py-6">
            {activeFeature === null && <CliniAACianFeature />}

            {activeFeature === "interpret" && <CommuniAACteFeature />}

            {activeFeature === "docuslp" && (
              <div className="max-w-3xl mx-auto text-center text-muted-foreground py-24">
                <p>Coming soon: DocuSLP drafting</p>
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
