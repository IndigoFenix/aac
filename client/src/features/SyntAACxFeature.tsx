// src/components/syntAACx/SyntAACxFeature.tsx

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { ChevronDown, Cloud } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { PromptPane } from "@/components/syntAACx/prompt-pane";
import { BoardCanvas } from "@/components/syntAACx/board-canvas";
import { ButtonInspector } from "@/components/syntAACx/button-inspector";
import { useBoardStore } from "@/store/board-store";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";

export function SyntAACxFeature() {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  
  const { user } = useAuth();
  const { board, validation, isEditMode } = useBoardStore();
  const { toast } = useToast();

  // Check Dropbox connection status
  const { data: dropboxConnection } = useQuery<{ connected: boolean }>({
    queryKey: ["/api/integrations/dropbox/status"],
    enabled: !!user,
  });

  // Helper function to convert blob to base64
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        const base64Data = base64.split(",")[1];
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Export handlers
  const handleExportGridset = async () => {
    if (!board) return;
    const { GridsetPackager, downloadFile } = await import("@/lib/packagers");
    try {
      const blob = await GridsetPackager.package(board);
      const filename = `${board.name.replace(/[<>:"/\|?*]/g, "_")}.gridset`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error("Export failed:", error);
    }
  };

  const handleExportSnappkg = async () => {
    if (!board) return;
    const { SnappkgPackager, downloadFile } = await import("@/lib/packagers");
    try {
      const blob = await SnappkgPackager.package(board);
      const filename = `${board.name.replace(/[<>:"/\|?*]/g, "_")}.snappkg`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error("Export failed:", error);
    }
  };

  const handleExportTouchChat = async () => {
    if (!board) return;
    const { TouchChatPackager, downloadFile } = await import("@/lib/packagers");
    try {
      const blob = await TouchChatPackager.package(board);
      const filename = `${board.name.replace(/[<>:"/\|?*]/g, "_")}.touchchat`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error("Export failed:", error);
    }
  };

  const handleExportOBZ = async () => {
    if (!board) return;
    const { OBZPackager, downloadFile } = await import("@/lib/packagers");
    try {
      const blob = await OBZPackager.package(board);
      const filename = `${board.name.replace(/[<>:"/\|?*]/g, "_")}.obz`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error("OBZ export failed:", error);
    }
  };

  // Beta export functions
  const handleExportBetaGrid3 = async () => {
    if (!board) return;
    try {
      const { BetaGrid3Packager, downloadFile } = await import(
        "@/lib/beta-packagers"
      );
      const blob = await BetaGrid3Packager.package(board);
      const filename = `${board.name.replace(/[<>:"/\|?*]/g, "_")}_beta.gridset`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error("Beta Grid3 export failed:", error);
    }
  };

  const handleExportBetaTDSnap = async () => {
    if (!board) return;
    try {
      const { BetaTDSnapPackager, downloadFile } = await import(
        "@/lib/beta-packagers"
      );
      const blob = await BetaTDSnapPackager.package(board);
      const filename = `${board.name.replace(/[<>:"/\|?*]/g, "_")}_beta.snappkg`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error("Beta TD Snap export failed:", error);
    }
  };

  // Upload handlers
  const uploadToDropbox = useMutation({
    mutationFn: async ({
      fileType,
      fileData,
      fileName,
    }: {
      fileType: string;
      fileData: string;
      fileName: string;
    }) => {
      if (!board) throw new Error("No board available");

      const response = await apiRequest("POST", "/api/integrations/dropbox/upload", {
        boardId: board.name,
        fileType,
        fileName,
        fileData,
      });
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: t("export.uploadSuccess"),
        description: t("export.uploadSuccessDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("export.uploadFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleUploadGridset = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { GridsetPackager } = await import("@/lib/packagers");
      const blob = await GridsetPackager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\|?*]/g, "_")}.gridset`;
      uploadToDropbox.mutate({ fileType: "gridset", fileData, fileName });
    } catch (error) {
      console.error("Upload failed:", error);
    }
  };

  const handleUploadSnappkg = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { SnappkgPackager } = await import("@/lib/packagers");
      const blob = await SnappkgPackager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\|?*]/g, "_")}.snappkg`;
      uploadToDropbox.mutate({ fileType: "snappkg", fileData, fileName });
    } catch (error) {
      console.error("Upload failed:", error);
    }
  };

  const handleUploadTouchChat = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { TouchChatPackager } = await import("@/lib/packagers");
      const blob = await TouchChatPackager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\|?*]/g, "_")}.touchchat`;
      uploadToDropbox.mutate({ fileType: "touchchat", fileData, fileName });
    } catch (error) {
      console.error("Upload failed:", error);
    }
  };

  const handleUploadOBZ = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { OBZPackager } = await import("@/lib/packagers");
      const blob = await OBZPackager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\|?*]/g, "_")}.obz`;
      uploadToDropbox.mutate({ fileType: "obz", fileData, fileName });
    } catch (error) {
      console.error("Upload failed:", error);
    }
  };

  const handleUploadBetaGrid3 = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { BetaGrid3Packager } = await import("@/lib/beta-packagers");
      const blob = await BetaGrid3Packager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\|?*]/g, "_")}_beta.gridset`;
      uploadToDropbox.mutate({ fileType: "gridset", fileData, fileName });
    } catch (error) {
      console.error("Upload failed:", error);
    }
  };

  const handleUploadBetaTDSnap = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { BetaTDSnapPackager } = await import("@/lib/beta-packagers");
      const blob = await BetaTDSnapPackager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\|?*]/g, "_")}_beta.snappkg`;
      uploadToDropbox.mutate({ fileType: "snappkg", fileData, fileName });
    } catch (error) {
      console.error("Upload failed:", error);
    }
  };

  return (
    <div className={cn(
      "flex flex-col h-full min-h-0",
      isDark ? "bg-slate-950" : "bg-gray-50"
    )}>
      {/* Main Content */}
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className={cn("flex h-full", isRTL && "flex-row-reverse")}>
          {/* Left Pane - Prompt Panel */}
          <PromptPane />

          {/* Center Pane - Canvas */}
          <BoardCanvas />

          {/* Right Pane - Button Inspector (only in edit mode) */}
          <ButtonInspector />
        </div>
      </div>

      {/* Footer - Export Bar */}
      <footer
        className={cn(
          "border-t px-4 py-3 flex items-center justify-between",
          isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
          !isEditMode && "opacity-90"
        )}
      >
        {/* Status */}
        <div className={cn("flex items-center gap-4", isRTL && "flex-row-reverse")}>
          <div className={cn("flex items-center gap-2", isRTL && "flex-row-reverse")}>
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                validation.isValid ? "bg-emerald-500" : "bg-red-500"
              )}
            />
            <span className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {validation.isValid ? t("board.valid") : t("board.hasErrors")}
            </span>
          </div>

          <div className={cn(
            "text-xs",
            isDark ? "text-slate-500" : "text-gray-500"
          )}>
            {board?.pages.length || 0} {t("board.pages")} •{" "}
            {board?.pages.reduce(
              (total: number, page: any) => total + page.buttons.length,
              0
            ) || 0}{" "}
            {t("board.buttons")}
          </div>
        </div>

        {/* Copyright */}
        <div className={cn(
          "text-[10px] hidden md:block",
          isDark ? "text-slate-600" : "text-gray-400"
        )}>
          © 2025 SyntAACx by Xahaph AI
        </div>

        {/* Export Buttons */}
        <div className={cn("flex items-center gap-2", isRTL && "flex-row-reverse")}>
          {/* Grid3 */}
          <div className={cn("flex items-center gap-0.5", isRTL && "flex-row-reverse")}>
            <Button
              onClick={handleExportGridset}
              disabled={!board || !validation.isValid}
              size="sm"
              className="h-7 text-xs bg-blue-600 hover:bg-blue-700"
            >
              .gridset
            </Button>
            {dropboxConnection?.connected && (
              <Button
                onClick={handleUploadGridset}
                disabled={!board || !validation.isValid || uploadToDropbox.isPending}
                size="icon"
                variant="outline"
                className={cn(
                  "h-7 w-7",
                  isDark 
                    ? "border-slate-700 text-slate-400 hover:bg-slate-800"
                    : "border-gray-300 text-gray-500 hover:bg-gray-100"
                )}
              >
                <Cloud size={12} />
              </Button>
            )}
          </div>

          {/* TD Snap */}
          <div className={cn("flex items-center gap-0.5", isRTL && "flex-row-reverse")}>
            <Button
              onClick={handleExportSnappkg}
              disabled={!board || !validation.isValid}
              size="sm"
              className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
            >
              .snappkg
            </Button>
            {dropboxConnection?.connected && (
              <Button
                onClick={handleUploadSnappkg}
                disabled={!board || !validation.isValid || uploadToDropbox.isPending}
                size="icon"
                variant="outline"
                className={cn(
                  "h-7 w-7",
                  isDark 
                    ? "border-slate-700 text-slate-400 hover:bg-slate-800"
                    : "border-gray-300 text-gray-500 hover:bg-gray-100"
                )}
              >
                <Cloud size={12} />
              </Button>
            )}
          </div>

          {/* TouchChat */}
          <div className={cn("flex items-center gap-0.5", isRTL && "flex-row-reverse")}>
            <Button
              onClick={handleExportTouchChat}
              disabled={!board || !validation.isValid}
              size="sm"
              className="h-7 text-xs bg-purple-600 hover:bg-purple-700"
            >
              .touchchat
            </Button>
            {dropboxConnection?.connected && (
              <Button
                onClick={handleUploadTouchChat}
                disabled={!board || !validation.isValid || uploadToDropbox.isPending}
                size="icon"
                variant="outline"
                className={cn(
                  "h-7 w-7",
                  isDark 
                    ? "border-slate-700 text-slate-400 hover:bg-slate-800"
                    : "border-gray-300 text-gray-500 hover:bg-gray-100"
                )}
              >
                <Cloud size={12} />
              </Button>
            )}
          </div>

          {/* OBZ */}
          <div className={cn("flex items-center gap-0.5", isRTL && "flex-row-reverse")}>
            <Button
              onClick={handleExportOBZ}
              disabled={!board || !validation.isValid}
              size="sm"
              className="h-7 text-xs bg-orange-600 hover:bg-orange-700"
            >
              .obz
            </Button>
            {dropboxConnection?.connected && (
              <Button
                onClick={handleUploadOBZ}
                disabled={!board || !validation.isValid || uploadToDropbox.isPending}
                size="icon"
                variant="outline"
                className={cn(
                  "h-7 w-7",
                  isDark 
                    ? "border-slate-700 text-slate-400 hover:bg-slate-800"
                    : "border-gray-300 text-gray-500 hover:bg-gray-100"
                )}
              >
                <Cloud size={12} />
              </Button>
            )}
          </div>

          {/* Beta Exports */}
          <div className={cn(
            "border-l pl-2 ml-1 flex items-center gap-2",
            isDark ? "border-slate-700" : "border-gray-300",
            isRTL && "border-l-0 border-r pr-2 mr-1 pl-0 ml-0 flex-row-reverse"
          )}>
            <span className={cn(
              "text-[9px] uppercase tracking-wider",
              isDark ? "text-slate-500" : "text-gray-400"
            )}>
              Beta
            </span>
            <div className={cn("flex items-center gap-0.5", isRTL && "flex-row-reverse")}>
              <Button
                onClick={handleExportBetaTDSnap}
                disabled={!board || !validation.isValid}
                size="sm"
                className="h-6 text-[10px] bg-teal-600 hover:bg-teal-700"
              >
                TD Snap
              </Button>
              {dropboxConnection?.connected && (
                <Button
                  onClick={handleUploadBetaTDSnap}
                  disabled={
                    !board || !validation.isValid || uploadToDropbox.isPending
                  }
                  size="icon"
                  variant="outline"
                  className={cn(
                    "h-6 w-6",
                    isDark 
                      ? "border-slate-700 text-slate-400 hover:bg-slate-800"
                      : "border-gray-300 text-gray-500 hover:bg-gray-100"
                  )}
                >
                  <Cloud size={10} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}