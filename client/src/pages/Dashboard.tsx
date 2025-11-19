import { useState } from "react";
import { LeftSidebar } from "@/components/LeftSidebar";
import { TopHeader } from "@/components/TopHeader";
import { MainCanvas } from "@/components/MainCanvas";
import { InteractionBar } from "@/components/InteractionBar";

export default function Dashboard() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <LeftSidebar isCollapsed={isSidebarCollapsed} />
      
      <div 
        className={`flex-1 flex flex-col transition-all duration-300 ${
          isSidebarCollapsed ? "ml-20" : "ml-80"
        }`}
      >
        <TopHeader onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)} />
        <MainCanvas />
        <InteractionBar />
      </div>
    </div>
  );
}
