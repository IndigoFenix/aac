import { useState } from "react";
import { LeftSidebar } from "@/components/LeftSidebar";
import { TopHeader } from "@/components/TopHeader";
import { MainCanvas } from "@/components/MainCanvas";
import { GlobalAuthModals } from "@/components/GlobalAuthModals";

export default function Dashboard() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <LeftSidebar isCollapsed={isSidebarCollapsed} />
      
      <div 
        className={`flex-1 min-w-0 min-h-0 flex flex-col transition-all duration-300 ${
          isSidebarCollapsed ? "ml-20" : "ml-80"
        }`}
      >
        <TopHeader onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)} />
        <MainCanvas />
        <GlobalAuthModals />
      </div>
    </div>
  );
}
