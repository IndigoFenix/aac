// src/components/syntAACx/button-inspector.tsx

import { useState } from "react";
import { useBoardStore, useSelectedButton } from "@/store/board-store";
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

  // Don't show in preview mode
  if (!isEditMode) {
    return null;
  }

  // Don't show if no button selected
  if (!selectedBtn) {
    return null;
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
                  src={selectedBtn.symbolPath}
                  alt={selectedBtn.label}
                  className="w-8 h-8 object-contain mb-1"
                />
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
            <Label className={cn(
              "text-xs",
              isDark ? "text-slate-400" : "text-gray-600"
            )}>
              {t("button.color")}
            </Label>
            <div className="flex items-center gap-2">
              <input
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
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "flex-1 h-7 text-xs",
                  isDark 
                    ? "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
                    : "bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
                )}
              >
                <Image size={12} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
                {t("button.chooseIcon")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "flex-1 h-7 text-xs",
                  isDark 
                    ? "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
                    : "bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
                )}
              >
                <Upload size={12} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
                {t("button.upload")}
              </Button>
            </div>
          </div>

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