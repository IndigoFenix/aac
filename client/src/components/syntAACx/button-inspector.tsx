// src/components/syntAACx/button-inspector.tsx

import { useState } from "react";
import { useBoardStore, useSelectedButton } from "@/store/board-store";
import { apiUrl } from "@/lib/queryClient";
import { useStudent } from "@/hooks/useStudent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Copy, Trash2, Image, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { ActionLinkIR } from "@/types/board-ir";
import { Glyph } from "@/components/Glyph";
import { BoardButtonVisual } from "@client-shared/board/BoardButtonVisual";
import { useClinicianBoardDeps, irToButtonInput } from "./use-clinician-board-deps";
import { mapColorToHex, type ColorToken } from "@shared/button-color";
import { GlyphBuilder } from "./glyph-builder";

// Named color tokens offered as overrides, in display order. The system
// auto-colors buttons by default ("Auto"); these map to the same pastel hexes
// the AAC renders (shared/button-color COLOR_MAP).
const COLOR_SWATCHES: ColorToken[] = ["yellow", "blue", "green", "red", "orange", "purple", "pink", "white", "gray"];

export function ButtonInspector() {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const {
    board,
    updateButton,
    duplicateButton,
    deleteButton,
    setCurrentPage,
    isEditMode,
    selectButton,
  } = useBoardStore();

  const selectedBtn = useSelectedButton();
  const [isJumpDialogOpen, setIsJumpDialogOpen] = useState(false);
  const [isGlyphBuilderOpen, setIsGlyphBuilderOpen] = useState(false);
  const { student } = useStudent();

  // Shared clinician render deps (same as the board canvas) so the inspector
  // preview matches the canvas + the AAC exactly.
  const clinicianDeps = useClinicianBoardDeps();

  // Don't show in preview mode
  if (!isEditMode) {
    return null;
  }

  // When no button is selected, show board-level properties
  if (!selectedBtn) {
    const coverImage = board?.coverImage;
    return (
      <div className={cn(
        "p-4 rounded-xl border shadow-sm space-y-4",
        isDark ? "bg-slate-900 border-slate-700" : "bg-white border-gray-200"
      )}>
        <h3 className={cn(
          "text-sm font-semibold",
          isDark ? "text-slate-200" : "text-gray-800"
        )}>
          {t("board.properties") || "Board Properties"}
        </h3>

        {/* Cover Image */}
        <div className="space-y-2">
          <Label className={cn(
            "text-xs font-medium",
            isDark ? "text-slate-400" : "text-gray-600"
          )}>
            {t("board.coverImage") || "Cover Image"}
          </Label>
          <div className="flex items-center gap-2">
            {/* Preview */}
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center border"
              style={{ backgroundColor: coverImage?.backgroundColor || '#FFFFFFFF' }}
            >
              {coverImage?.symbolPath && (coverImage.symbolPath.startsWith("/api/") || coverImage.symbolPath.startsWith("http")) ? (
                <img
                  src={coverImage.symbolPath.startsWith("/api/") ? apiUrl(coverImage.symbolPath) : coverImage.symbolPath}
                  alt="Cover"
                  className="w-8 h-8 object-contain"
                />
              ) : coverImage?.iconRef ? (
                <span className="text-xl leading-none">{coverImage.iconRef}</span>
              ) : (
                <Image className="w-5 h-5 text-gray-400" />
              )}
            </div>
            {/* Icon input */}
            <Input
              className={cn(
                "h-8 text-sm flex-1",
                isDark ? "bg-slate-800 border-slate-700 text-slate-200" : "bg-white border-gray-300"
              )}
              placeholder={t("board.coverIconPlaceholder") || "Emoji (e.g. 🏠)"}
              value={coverImage?.iconRef || ""}
              onChange={(e) => {
                if (!board) return;
                const updated = { ...board, coverImage: { ...board.coverImage, iconRef: e.target.value } };
                useBoardStore.getState().updateBoard(updated);
              }}
            />
          </div>
          {/* Image Key */}
          <Input
            className={cn(
              "h-8 text-sm",
              isDark ? "bg-slate-800 border-slate-700 text-slate-200" : "bg-white border-gray-300"
            )}
            placeholder={t("board.coverImageKeyPlaceholder") || "Image key (e.g. communication_board)"}
            value={coverImage?.imageKey || ""}
            onChange={(e) => {
              if (!board) return;
              const updated = { ...board, coverImage: { ...board.coverImage, imageKey: e.target.value } };
              useBoardStore.getState().updateBoard(updated);
            }}
          />
          {/* Background Color */}
          <div className="flex items-center gap-2">
            <Label htmlFor="cover-background-color" className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("board.coverBackground") || "Background"}
            </Label>
            <input
              id="cover-background-color"
              type="color"
              className="w-8 h-8 rounded border-0 cursor-pointer"
              value={(coverImage?.backgroundColor || "#ffffff").slice(0, 7)}
              onChange={(e) => {
                if (!board) return;
                const color = e.target.value.toUpperCase() + "FF";
                const updated = { ...board, coverImage: { ...board.coverImage, backgroundColor: color } };
                useBoardStore.getState().updateBoard(updated);
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  const handleUpdate = (field: string, value: any) => {
    updateButton(selectedBtn.id, { [field]: value });
  };

  const handleActionUpdate = (field: string, value: any) => {
    let newAction =
      selectedBtn.action ||
      ({ type: "speak", text: selectedBtn.spokenText || selectedBtn.label } as any);

    if (field === "type") {
      switch (value) {
        case "speak":
          newAction = {
            type: "speak",
            text: selectedBtn.spokenText || selectedBtn.label,
          };
          break;
        case "back":
          newAction = { type: "back" };
          break;
        case "link":
          newAction = { type: "link", toPageId: "" };
          break;
        case "bookmark":
          newAction = { type: "bookmark" };
          break;
        case "home":
          newAction = { type: "home" };
          break;
        case "youtube":
          newAction = { type: "youtube", videoId: "", title: "" };
          break;
        case "open_website":
          newAction = { type: "open_website", url: "", label: selectedBtn.label };
          break;
        default:
          newAction = { ...newAction, type: value };
      }
    } else {
      newAction = { ...newAction, [field]: value };
    }

    updateButton(selectedBtn.id, { action: newAction });
  };

  const handlePositionUpdate = (field: string, value: number) => {
    updateButton(selectedBtn.id, { [field]: Math.max(0, value) });
  };

  const handleClose = () => {
    selectButton(null);
  };

  return (
    <div className={cn(
      "w-72 shrink-0 border-l flex flex-col min-h-0",
      isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
      isRTL && "border-l-0 border-r"
    )}>
      {/* Header */}
      <div className={cn(
        "px-4 py-3 border-b flex items-center justify-between",
        isDark ? "border-slate-800" : "border-gray-200"
      )}>
        <div>
          <h2 className={cn(
            "text-sm font-semibold",
            isDark ? "text-slate-200" : "text-gray-800"
          )}>
            {t("button.editor")}
          </h2>
          <p className={cn(
            "text-[10px] mt-0.5",
            isDark ? "text-slate-500" : "text-gray-500"
          )}>
            {t("button.editProperties")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7",
            isDark
              ? "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
          )}
          onClick={handleClose}
          aria-label={t("common.close")}
        >
          <X size={14} />
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {/* Preview — shared renderer, identical to the canvas + the AAC. */}
          <div className="flex justify-center">
            <div className="w-20 h-20">
              <BoardButtonVisual
                variant="board"
                interactive={false}
                button={irToButtonInput(selectedBtn)}
                deps={clinicianDeps}
                textFontSize="0.625rem"
              />
            </div>
          </div>

          {/* Label */}
          <div className="space-y-1.5">
            <Label htmlFor="label" className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.label")}
            </Label>
            <Input
              id="label"
              value={selectedBtn.label}
              onChange={(e) => handleUpdate("label", e.target.value)}
              placeholder={t("button.labelPlaceholder")}
              className={cn(
                "h-8 text-sm",
                isDark 
                  ? "bg-slate-800 border-slate-700 text-slate-200"
                  : "bg-white border-gray-300 text-gray-800"
              )}
            />
          </div>

          {/* Spoken Text */}
          <div className="space-y-1.5">
            <Label htmlFor="spokenText" className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.spokenText")}
            </Label>
            <Input
              id="spokenText"
              value={selectedBtn.spokenText || ""}
              onChange={(e) => handleUpdate("spokenText", e.target.value)}
              placeholder={t("button.spokenTextPlaceholder")}
              className={cn(
                "h-8 text-sm",
                isDark 
                  ? "bg-slate-800 border-slate-700 text-slate-200"
                  : "bg-white border-gray-300 text-gray-800"
              )}
            />
          </div>

          {/* Color — "Auto" (the system auto-colors: yes→green, no→red, etc.)
              or an explicit named override. Auto is the real default; leaving a
              button on Auto stores no `color`. */}
          <div className="space-y-1.5">
            <Label className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.color")}
            </Label>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => handleUpdate("color", undefined)}
                className={cn(
                  "h-6 px-2 rounded-md text-[11px] border transition-colors",
                  !selectedBtn.color
                    ? "border-blue-500 ring-1 ring-blue-400 " + (isDark ? "bg-slate-700 text-slate-100" : "bg-blue-50 text-blue-700")
                    : (isDark ? "border-slate-700 text-slate-400 hover:bg-slate-800" : "border-gray-300 text-gray-600 hover:bg-gray-100")
                )}
              >
                {t("button.colorAuto")}
              </button>
              <div className="flex flex-wrap gap-1">
                {COLOR_SWATCHES.map((token) => {
                  const isSel = selectedBtn.color?.toLowerCase() === token;
                  return (
                    <button
                      key={token}
                      type="button"
                      title={token}
                      onClick={() => handleUpdate("color", token)}
                      className={cn(
                        "w-6 h-6 rounded-md border transition-transform",
                        isSel
                          ? "ring-2 ring-blue-500 scale-105 border-blue-500"
                          : (isDark ? "border-slate-600" : "border-gray-300")
                      )}
                      style={{ backgroundColor: mapColorToHex(token) }}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* Visual — the button’s glyph, composed in the glyph builder. */}
          <div className="space-y-1.5">
            <Label className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.visual") || "Visual"}
            </Label>
            <div className={cn(
              "flex items-center gap-2 rounded-md border p-2",
              isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-gray-50"
            )}>
              <div className="w-16 h-16 shrink-0 flex items-center justify-center">
                {selectedBtn.glyph
                  ? <Glyph glyph={selectedBtn.glyph} fallback={selectedBtn.glyphFallback} ariaLabel={selectedBtn.label} />
                  : <span className="text-3xl opacity-40">＋</span>}
              </div>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "flex-1 h-8 text-xs",
                  isDark
                    ? "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
                    : "bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
                )}
                onClick={() => setIsGlyphBuilderOpen(true)}
              >
                {t("button.editVisual") || "Edit visual"}
              </Button>
            </div>
          </div>

          <GlyphBuilder
            value={selectedBtn.glyph}
            onChange={(g) => handleUpdate("glyph", g || undefined)}
            studentId={student?.id}
            open={isGlyphBuilderOpen}
            onOpenChange={setIsGlyphBuilderOpen}
          />

          {/* Action */}
          <div className="space-y-1.5">
            <Label className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.action")}
            </Label>
            <Select
              value={selectedBtn.action?.type || "speak"}
              onValueChange={(value) => handleActionUpdate("type", value)}
            >
              <SelectTrigger className={cn(
                "h-8 text-sm",
                isDark 
                  ? "bg-slate-800 border-slate-700 text-slate-200"
                  : "bg-white border-gray-300 text-gray-800"
              )}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={isDark ? "bg-slate-800 border-slate-700" : "bg-white border-gray-200"}>
                <SelectItem value="speak" className={isDark ? "text-slate-200" : "text-gray-800"}>
                  {t("button.actionSpeak")}
                </SelectItem>
                <SelectItem value="link" className={isDark ? "text-slate-200" : "text-gray-800"}>
                  {t("button.actionJump")}
                </SelectItem>
                <SelectItem value="back" className={isDark ? "text-slate-200" : "text-gray-800"}>
                  {t("button.actionBack")}
                </SelectItem>
                <SelectItem value="home" className={isDark ? "text-slate-200" : "text-gray-800"}>
                  {t("button.actionHome")}
                </SelectItem>
                <SelectItem value="youtube" className={isDark ? "text-slate-200" : "text-gray-800"}>
                  {t("button.actionYoutube")}
                </SelectItem>
                <SelectItem value="open_website" className={isDark ? "text-slate-200" : "text-gray-800"}>
                  {t("button.actionOpenWebsite")}
                </SelectItem>
                <SelectItem value="exit" className={isDark ? "text-slate-200" : "text-gray-800"}>
                  {t("button.actionExit")}
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Action-specific fields */}
            {selectedBtn.action?.type === "speak" && (
              <Input
                value={selectedBtn.action.text || ""}
                onChange={(e) => handleActionUpdate("text", e.target.value)}
                placeholder={t("button.textToSpeak")}
                className={cn(
                  "h-8 text-sm",
                  isDark 
                    ? "bg-slate-800 border-slate-700 text-slate-200"
                    : "bg-white border-gray-300 text-gray-800"
                )}
              />
            )}

            {selectedBtn.action?.type === "youtube" && (
              <div className="space-y-2">
                <Input
                  value={selectedBtn.action.videoId || ""}
                  onChange={(e) => handleActionUpdate("videoId", e.target.value)}
                  placeholder={t("button.videoId")}
                  className={cn(
                    "h-8 text-xs",
                    isDark
                      ? "bg-slate-800 border-slate-700 text-slate-200"
                      : "bg-white border-gray-300 text-gray-800"
                  )}
                />
                <Input
                  value={selectedBtn.action.title || ""}
                  onChange={(e) => handleActionUpdate("title", e.target.value)}
                  placeholder={t("button.videoTitle")}
                  className={cn(
                    "h-8 text-xs",
                    isDark
                      ? "bg-slate-800 border-slate-700 text-slate-200"
                      : "bg-white border-gray-300 text-gray-800"
                  )}
                />
              </div>
            )}

            {selectedBtn.action?.type === "open_website" && (
              <div className="space-y-2">
                <Input
                  value={selectedBtn.action.url || ""}
                  onChange={(e) => handleActionUpdate("url", e.target.value)}
                  placeholder="https://example.com/"
                  className={cn(
                    "h-8 text-xs font-mono",
                    isDark
                      ? "bg-slate-800 border-slate-700 text-slate-200"
                      : "bg-white border-gray-300 text-gray-800",
                  )}
                />
                <Input
                  value={selectedBtn.action.label || ""}
                  onChange={(e) => handleActionUpdate("label", e.target.value)}
                  placeholder={t("button.websiteLabelPlaceholder")}
                  className={cn(
                    "h-8 text-xs",
                    isDark
                      ? "bg-slate-800 border-slate-700 text-slate-200"
                      : "bg-white border-gray-300 text-gray-800",
                  )}
                />
                <p className={cn(
                  "text-[10px]",
                  isDark ? "text-slate-500" : "text-gray-500",
                )}>
                  {t("button.websiteHint")}
                </p>
              </div>
            )}

            {selectedBtn.action?.type === "link" && (
              <div className={cn(
                "space-y-2 rounded-lg border border-dashed p-2",
                isDark ? "border-slate-700 bg-slate-800/30" : "border-gray-300 bg-gray-50"
              )}>
                <div className={cn(
                  "text-[10px]",
                  isDark ? "text-slate-500" : "text-gray-500"
                )}>
                  {t("button.target")}:{" "}
                  <span className={isDark ? "text-slate-300" : "text-gray-700"}>
                    {(() => {
                      if (!board) return t("button.noBoard");
                      const targetPage = board.pages.find(
                        (p: any) => p.id === (selectedBtn.action as ActionLinkIR)?.toPageId
                      );
                      return targetPage ? targetPage.name : t("button.notSet");
                    })()}
                  </span>
                </div>

                <div className="flex gap-2">
                  <Dialog open={isJumpDialogOpen} onOpenChange={setIsJumpDialogOpen}>
                    <DialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn(
                          "h-7 text-xs",
                          isDark 
                            ? "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
                            : "bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
                        )}
                      >
                        {t("button.choosePage")}
                      </Button>
                    </DialogTrigger>
                    <DialogContent className={cn(
                      "max-w-sm",
                      isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200"
                    )}>
                      <DialogHeader>
                        <DialogTitle className={isDark ? "text-slate-100" : "text-gray-900"}>
                          {t("button.chooseTargetPage")}
                        </DialogTitle>
                        <DialogDescription className={isDark ? "text-slate-400" : "text-gray-500"}>
                          {t("button.selectPageToJump")}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
                        {board?.pages.map((page: any) => (
                          <Button
                            key={page.id}
                            size="sm"
                            variant={
                              (selectedBtn.action as ActionLinkIR)?.toPageId === page.id
                                ? "default"
                                : "ghost"
                            }
                            className={cn(
                              "w-full justify-start text-xs",
                              (selectedBtn.action as ActionLinkIR)?.toPageId === page.id
                                ? "bg-blue-600"
                                : isDark 
                                  ? "text-slate-300 hover:bg-slate-800"
                                  : "text-gray-700 hover:bg-gray-100"
                            )}
                            onClick={() => {
                              handleActionUpdate("toPageId", page.id);
                              setIsJumpDialogOpen(false);
                            }}
                          >
                            {page.name}
                            {board.pages[0]?.id === page.id && (
                              <span className={cn(
                                "text-[9px]",
                                isRTL ? "mr-2" : "ml-2",
                                isDark ? "text-slate-400" : "text-gray-500"
                              )}>
                                {t("board.home")}
                              </span>
                            )}
                          </Button>
                        ))}
                      </div>
                    </DialogContent>
                  </Dialog>

                  {selectedBtn.action.toPageId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className={cn(
                        "h-7 text-xs",
                        isDark 
                          ? "text-slate-400 hover:text-slate-200"
                          : "text-gray-500 hover:text-gray-700"
                      )}
                      onClick={() => setCurrentPage((selectedBtn.action as ActionLinkIR)!.toPageId!)}
                    >
                      {t("button.goToPage")}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {selectedBtn.action?.type === "back" && (
              <p className={cn(
                "text-[10px]",
                isDark ? "text-slate-500" : "text-gray-500"
              )}>
                {t("button.backDescription")}
              </p>
            )}

            {selectedBtn.action?.type === "home" && (
              <p className={cn(
                "text-[10px]",
                isDark ? "text-slate-500" : "text-gray-500"
              )}>
                {t("button.homeDescription")}
              </p>
            )}
          </div>

          {/* Self-closing */}
          <div className="flex items-center justify-between">
            <div>
              <Label className={cn(
                "text-xs",
                isDark ? "text-slate-400" : "text-gray-600"
              )}>
                {t("button.selfClosing")}
              </Label>
              <p className={cn(
                "text-[10px] mt-0.5",
                isDark ? "text-slate-500" : "text-gray-500"
              )}>
                {t("button.selfClosingDescription")}
              </p>
            </div>
            <Switch
              checked={!!(selectedBtn as any).selfClosing}
              onCheckedChange={(checked) => handleUpdate("selfClosing", checked)}
            />
          </div>

          {/* Exit Board */}
          <div className="flex items-center justify-between">
            <div>
              <Label className={cn(
                "text-xs",
                isDark ? "text-slate-400" : "text-gray-600"
              )}>
                {t("button.exitBoard")}
              </Label>
              <p className={cn(
                "text-[10px] mt-0.5",
                isDark ? "text-slate-500" : "text-gray-500"
              )}>
                {t("button.exitBoardDescription")}
              </p>
            </div>
            <Switch
              checked={!!(selectedBtn as any).exitBoard}
              onCheckedChange={(checked) => handleUpdate("exitBoard", checked)}
            />
          </div>

          {/* Position */}
          <div className="space-y-1.5">
            <Label className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.position")}
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className={cn(
                  "text-[10px]",
                  isDark ? "text-slate-500" : "text-gray-500"
                )}>
                  {t("button.row")}
                </Label>
                <Input
                  type="number"
                  min="0"
                  value={selectedBtn.row}
                  onChange={(e) =>
                    handlePositionUpdate("row", parseInt(e.target.value, 10) || 0)
                  }
                  className={cn(
                    "h-8 text-sm",
                    isDark
                      ? "bg-slate-800 border-slate-700 text-slate-200"
                      : "bg-white border-gray-300 text-gray-800"
                  )}
                />
              </div>
              <div>
                <Label className={cn(
                  "text-[10px]",
                  isDark ? "text-slate-500" : "text-gray-500"
                )}>
                  {t("button.column")}
                </Label>
                <Input
                  type="number"
                  min="0"
                  value={selectedBtn.col}
                  onChange={(e) =>
                    handlePositionUpdate("col", parseInt(e.target.value, 10) || 0)
                  }
                  className={cn(
                    "h-8 text-sm",
                    isDark
                      ? "bg-slate-800 border-slate-700 text-slate-200"
                      : "bg-white border-gray-300 text-gray-800"
                  )}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className={cn(
                  "text-[10px]",
                  isDark ? "text-slate-500" : "text-gray-500"
                )}>
                  {t("button.rowSpan")}
                </Label>
                <Input
                  type="number"
                  min="1"
                  value={(selectedBtn as any).rowSpan ?? 1}
                  onChange={(e) =>
                    handleUpdate("rowSpan", Math.max(1, parseInt(e.target.value, 10) || 1))
                  }
                  className={cn(
                    "h-8 text-sm",
                    isDark
                      ? "bg-slate-800 border-slate-700 text-slate-200"
                      : "bg-white border-gray-300 text-gray-800"
                  )}
                />
              </div>
              <div>
                <Label className={cn(
                  "text-[10px]",
                  isDark ? "text-slate-500" : "text-gray-500"
                )}>
                  {t("button.colSpan")}
                </Label>
                <Input
                  type="number"
                  min="1"
                  value={(selectedBtn as any).colSpan ?? 1}
                  onChange={(e) =>
                    handleUpdate("colSpan", Math.max(1, parseInt(e.target.value, 10) || 1))
                  }
                  className={cn(
                    "h-8 text-sm",
                    isDark
                      ? "bg-slate-800 border-slate-700 text-slate-200"
                      : "bg-white border-gray-300 text-gray-800"
                  )}
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className={cn(
            "pt-3 border-t space-y-2",
            isDark ? "border-slate-800" : "border-gray-200"
          )}>
            <Button
              onClick={() => duplicateButton(selectedBtn.id)}
              variant="outline"
              size="sm"
              className={cn(
                "w-full h-8 text-xs",
                isDark 
                  ? "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
                  : "bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
              )}
            >
              <Copy size={12} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
              {t("button.duplicate")}
            </Button>

            <Button
              onClick={() => deleteButton(selectedBtn.id)}
              variant="destructive"
              size="sm"
              className="w-full h-8 text-xs"
            >
              <Trash2 size={12} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
              {t("button.delete")}
            </Button>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}