import { useState } from "react";
import { LeftSidebar } from "@/components/LeftSidebar";
import { TopHeader } from "@/components/TopHeader";
import { MainCanvas } from "@/components/MainCanvas";
import { InteractionBar } from "@/components/InteractionBar";

export default function Dashboard() {
  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <LeftSidebar />
      
      <div className="flex-1 ml-80 flex flex-col">
        <TopHeader />
        <MainCanvas />
        <InteractionBar />
      </div>
    </div>
  );
}
