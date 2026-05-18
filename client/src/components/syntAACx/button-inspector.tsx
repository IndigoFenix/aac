// src/components/syntAACx/button-inspector.tsx

import { useState, useEffect } from "react";
import { useBoardStore, useSelectedButton } from "@/store/board-store";
import { apiRequest, apiUrl } from "@/lib/queryClient";
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
import { Copy, Trash2, Upload, Image, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { ActionLinkIR } from "@/types/board-ir";
import { Glyph } from "@/components/Glyph";

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
  const [isSymbolDialogOpen, setIsSymbolDialogOpen] = useState(false);
  const { student } = useStudent();
  const [availableSymbols, setAvailableSymbols] = useState<Array<{ id: string; key: string | null; description: string | null }>>([]);
  const [symbolSearch, setSymbolSearch] = useState('');
  const [symbolSearchResults, setSymbolSearchResults] = useState<Array<{ id: string; key: string | null; description: string | null }>>([]);

  useEffect(() => {
    if (isSymbolDialogOpen && student?.id) {
      apiRequest('GET', `/api/custom-symbols/available/${student.id}`)
        .then(r => r.json())
        .then(setAvailableSymbols)
        .catch(() => {});
    }
  }, [isSymbolDialogOpen, student?.id]);

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
          {/* Preview */}
          <div className="flex justify-center">
            <div
              className="w-20 h-20 rounded-xl flex flex-col items-center justify-center p-2 shadow-lg"
              style={{ backgroundColor: selectedBtn.color || "#3B82F6" }}
            >
              {selectedBtn.symbolPath ? (
                <img
                  src={selectedBtn.symbolPath.startsWith("/api/") ? apiUrl(selectedBtn.symbolPath) : selectedBtn.symbolPath}
                  alt={selectedBtn.label}
                  className="w-8 h-8 object-contain mb-1"
                />
              ) : selectedBtn.iconRef && (([...selectedBtn.iconRef].length === 1 && !selectedBtn.iconRef.startsWith("fa")) || /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F900}-\u{1F9FF}]/u.test(selectedBtn.iconRef)) ? (
                <span className="text-2xl mb-1 leading-none">{selectedBtn.iconRef}</span>
              ) : (
                <i
                  className={`${selectedBtn.iconRef || "fas fa-square"} text-xl mb-1 text-white`}
                />
              )}
              <span className="text-[10px] text-white text-center leading-tight truncate w-full">
                {selectedBtn.label}
              </span>
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

          {/* Color */}
          <div className="space-y-1.5">
            <Label htmlFor="button-inspector-color" className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.color")}
            </Label>
            <div className="flex items-center gap-2">
              <input
                id="button-inspector-color"
                type="color"
                value={selectedBtn.color || "#3B82F6"}
                onChange={(e) => handleUpdate("color", e.target.value)}
                className={cn(
                  "w-10 h-8 border rounded-lg cursor-pointer bg-transparent",
                  isDark ? "border-slate-700" : "border-gray-300"
                )}
              />
              <Input
                value={selectedBtn.color || "#3B82F6"}
                onChange={(e) => handleUpdate("color", e.target.value)}
                className={cn(
                  "flex-1 h-8 text-xs font-mono",
                  isDark 
                    ? "bg-slate-800 border-slate-700 text-slate-200"
                    : "bg-white border-gray-300 text-gray-800"
                )}
              />
            </div>
          </div>

          {/* Icon */}
          <div className="space-y-1.5">
            <Label className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.icon")}
            </Label>
            {selectedBtn.symbolPath ? (
              /* Custom symbol is active — show preview + remove */
              <div className={cn(
                "flex items-center gap-2 rounded-md border p-1.5",
                isDark ? "border-slate-700 bg-slate-800" : "border-gray-300 bg-gray-50"
              )}>
                <img
                  src={selectedBtn.symbolPath.startsWith("/api/") ? apiUrl(selectedBtn.symbolPath) : selectedBtn.symbolPath}
                  alt="Custom symbol"
                  className="w-8 h-8 object-contain rounded"
                />
                <span className={cn(
                  "flex-1 text-xs truncate",
                  isDark ? "text-slate-300" : "text-gray-700"
                )}>
                  {(selectedBtn as any).imageKey || "Custom symbol"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => {
                    handleUpdate("symbolPath", null);
                    handleUpdate("iconRef", "🔲");
                  }}
                  title="Remove custom symbol"
                >
                  <X size={14} />
                </Button>
              </div>
            ) : (
              /* No custom symbol — show emoji input */
              <Input
                value={selectedBtn.iconRef || ""}
                onChange={(e) => handleUpdate("iconRef", e.target.value)}
                placeholder={t("button.iconPlaceholder")}
                className={cn(
                  "h-8 text-xs font-mono",
                  isDark
                    ? "bg-slate-800 border-slate-700 text-slate-200"
                    : "bg-white border-gray-300 text-gray-800"
                )}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "w-full h-7 text-xs",
                isDark
                  ? "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
                  : "bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
              )}
              onClick={() => setIsSymbolDialogOpen(true)}
            >
              <Image size={12} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
              {selectedBtn.symbolPath ? t("button.changeSymbol") : t("button.chooseIcon")}
            </Button>
          </div>

          {/* Rebus Key (Grid3 export) */}
          <div className="space-y-1.5">
            <Label htmlFor="rebusKey" className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.rebusKey")}
            </Label>
            <Input
              id="rebusKey"
              value={(selectedBtn as any).rebusKey || ""}
              onChange={(e) => handleUpdate("rebusKey", e.target.value || undefined)}
              placeholder={t("button.rebusKeyPlaceholder")}
              className={cn(
                "h-8 text-xs font-mono",
                isDark
                  ? "bg-slate-800 border-slate-700 text-slate-200"
                  : "bg-white border-gray-300 text-gray-800"
              )}
            />
            <p className={cn(
              "text-[10px]",
              isDark ? "text-slate-500" : "text-gray-500"
            )}>
              {t("button.rebusKeyHint")}
            </p>
          </div>

          {/* Image Key (auto-generated symbol) */}
          <div className="space-y-1.5">
            <Label htmlFor="imageKey" className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.imageKey")}
            </Label>
            <Input
              id="imageKey"
              value={(selectedBtn as any).imageKey || ""}
              onChange={(e) => handleUpdate("imageKey", e.target.value || undefined)}
              placeholder={t("button.imageKeyPlaceholder")}
              className={cn(
                "h-8 text-xs font-mono",
                isDark
                  ? "bg-slate-800 border-slate-700 text-slate-200"
                  : "bg-white border-gray-300 text-gray-800"
              )}
            />
            <p className={cn(
              "text-[10px]",
              isDark ? "text-slate-500" : "text-gray-500"
            )}>
              {t("button.imageKeyHint")}
            </p>
          </div>

          {/* Glyph + Fallback — composed multi-image button. When `glyph` is
              set the board preview uses it instead of the single iconRef /
              symbolPath / imageKey chain. Fallback renders while imageKey
              parts of the glyph are still generating. Syntax:
              slot1+slot2+slot3, with modifiers via `.modifier` and
              composable payloads via `host(payload)`. */}
          <div className="space-y-1.5">
            <Label htmlFor="glyph" className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.glyph")}
            </Label>
            <Input
              id="glyph"
              value={(selectedBtn as any).glyph || ""}
              onChange={(e) => handleUpdate("glyph", e.target.value || undefined)}
              placeholder="i_me+want+water"
              className={cn(
                "h-8 text-xs font-mono",
                isDark
                  ? "bg-slate-800 border-slate-700 text-slate-200"
                  : "bg-white border-gray-300 text-gray-800"
              )}
            />
            <p className={cn(
              "text-[10px] leading-tight",
              isDark ? "text-slate-500" : "text-gray-500"
            )}>
              {t("button.glyphHint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="glyphFallback" className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.glyphFallback")}
            </Label>
            <Input
              id="glyphFallback"
              value={(selectedBtn as any).glyphFallback || ""}
              onChange={(e) => handleUpdate("glyphFallback", e.target.value || undefined)}
              placeholder="👤+🤲+💧"
              className={cn(
                "h-8 text-xs font-mono",
                isDark
                  ? "bg-slate-800 border-slate-700 text-slate-200"
                  : "bg-white border-gray-300 text-gray-800"
              )}
            />
            <p className={cn(
              "text-[10px] leading-tight",
              isDark ? "text-slate-500" : "text-gray-500"
            )}>
              {t("button.glyphFallbackHint")}
            </p>
          </div>

          {/* Live glyph preview — only when one is set. */}
          {((selectedBtn as any).glyph || (selectedBtn as any).glyphFallback) && (
            <div className={cn(
              "rounded-md border p-2",
              isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-gray-50"
            )}>
              <div className="text-[10px] text-gray-500 mb-1">{t("button.glyphPreview")}</div>
              <div className="h-16 flex items-center justify-center">
                <Glyph
                  glyph={(selectedBtn as any).glyph}
                  fallback={(selectedBtn as any).glyphFallback}
                  ariaLabel={selectedBtn.label}
                />
              </div>
            </div>
          )}

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

      {/* Symbol Selector Dialog */}
      <Dialog open={isSymbolDialogOpen} onOpenChange={setIsSymbolDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Choose Symbol</DialogTitle>
            <DialogDescription>Select a custom symbol icon for this button</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 mb-3">
            <Input
              value={symbolSearch}
              onChange={e => setSymbolSearch(e.target.value)}
              placeholder="Search symbols..."
              className="text-sm"
              onKeyDown={e => {
                if (e.key === 'Enter' && symbolSearch.trim()) {
                  apiRequest('GET', `/api/custom-symbols/search?q=${encodeURIComponent(symbolSearch)}`)
                    .then(r => r.json())
                    .then(setSymbolSearchResults)
                    .catch(() => {});
                }
              }}
            />
          </div>
          <ScrollArea className="max-h-[300px]">
            <div className="grid grid-cols-4 gap-2">
              {(symbolSearch && symbolSearchResults.length > 0 ? symbolSearchResults : availableSymbols).map(s => (
                <button type="button"
                  key={s.id}
                  className="border rounded-lg p-2 flex flex-col items-center gap-1 hover:bg-blue-50 transition-colors cursor-pointer"
                  onClick={() => {
                    handleUpdate("symbolPath", apiUrl(`/api/custom-symbols/${s.id}/image`));
                    handleUpdate("iconRef", "🖼️");
                    setIsSymbolDialogOpen(false);
                    // Auto-associate with student if not already
                    if (student?.id) {
                      apiRequest('POST', `/api/custom-symbols/${s.id}/student-associate`, { studentId: student.id }).catch(() => {});
                    }
                  }}
                >
                  <img
                    src={apiUrl(`/api/custom-symbols/${s.id}/image`)}
                    alt={s.key || 'Symbol'}
                    className="w-10 h-10 object-contain"
                    loading="lazy"
                  />
                  <span className="text-[10px] text-center truncate w-full">{s.key || '...'}</span>
                </button>
              ))}
              {availableSymbols.length === 0 && !symbolSearch && (
                <div className="col-span-4 text-center text-sm text-gray-500 py-4">
                  No symbols available. Create some in the Symbols panel.
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}