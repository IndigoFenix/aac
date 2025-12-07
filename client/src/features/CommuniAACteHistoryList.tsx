// CommuniAACteHistoryList.tsx
import { useNavigate } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { History, Plus, Minus, Trash2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Interpretation } from "@shared/schema";
import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";

type Props = {
  t: (k: string) => string;
  isRTL: boolean;
  language: string;
};

export function CommuniAACteHistoryList({ t, isRTL, language }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedImageData, setSelectedImageData] = useState<string | null>(
    null,
  );
  const [selectedImageInterpretation, setSelectedImageInterpretation] =
    useState<Interpretation | null>(null);
  const [isHistoryCollapsed, setIsHistoryCollapsed] = useState(false);
  const [showImagePopup, setShowImagePopup] = useState(false);

  // Fetch recent interpretations (copy from CommuniAACteFeature)
  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ["/api/interpretations"],
    queryFn: async () => {
      const res = await fetch("/api/interpretations?limit=50");
      return res.json();
    },
  });

  const deleteInterpretationMutation = useMutation({
    mutationFn: async (id: number | string) => {
      const res = await apiRequest("DELETE", `/api/interpretations/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/interpretations"] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsHistoryCollapsed(!isHistoryCollapsed)}
            className="p-1 h-auto"
            data-testid="toggle-history"
          >
            {isHistoryCollapsed ? (
              <Plus className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Minus className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>
          <div
            className={`flex items-center gap-2 ${
              isRTL ? "flex-row-reverse justify-end ml-auto" : ""
            }`}
          >
            <History className="text-muted-foreground" />
            <span className={isRTL ? "text-right" : ""}>
              {t("history.title")}
            </span>
          </div>
        </CardTitle>
      </CardHeader>

      {!isHistoryCollapsed && (
        <CardContent>
          {historyLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : historyData?.interpretations?.length > 0 ? (
            <div className="space-y-3">
              {historyData.interpretations.map(
                (interpretation: Interpretation) => (
                  <div
                    key={interpretation.id}
                    className="border border-border rounded-lg p-3 hover:bg-muted transition-colors cursor-pointer"
                    onClick={() =>
                      navigate(`/communiacte/history/${interpretation.id}`)
                    } // <-- URL for specific conversation
                  >
                  <div className="flex justify-between items-start mb-2 gap-2">
                    <div className="flex flex-col gap-1 shrink-0">
                      <Badge variant="secondary" className="text-xs">
                        {(() => {
                          const date = new Date(
                            interpretation.createdAt,
                          );
                          const locale =
                            language === "he" ? "he-IL" : "en-US";
                          return `${date.toLocaleDateString(locale)} ${date.toLocaleTimeString(
                            locale,
                            {
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: language !== "he",
                            },
                          )}`;
                        })()}
                      </Badge>
                      {interpretation.aacUserAlias && (
                        <Badge variant="outline" className="text-xs">
                          {language === "he" ? "עבור" : "For"}:{" "}
                          {interpretation.aacUserAlias}
                        </Badge>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteInterpretationMutation.mutate(
                          interpretation.id,
                        );
                      }}
                      className="text-destructive hover:text-destructive p-1 h-auto shrink-0"
                    >
                      <Trash2 className="w-3 h-3 sm:w-4 sm:h-4" />
                    </Button>
                  </div>
                  <div className="text-xs sm:text-sm space-y-1">
                    {interpretation.inputType === "image" &&
                    interpretation.imageData ? (
                      <div className="flex items-center gap-2">
                        <strong className="text-muted-foreground">
                          {language === "he"
                            ? "תמונת תת״ח"
                            : "AAC Image"}
                          :
                        </strong>
                        <img
                          src={`data:image/jpeg;base64,${interpretation.imageData}`}
                          alt={
                            language === "he"
                              ? "תמונת תקשורת תת״ח"
                              : "AAC Communication Image"
                          }
                          className="w-16 h-16 object-cover rounded-lg border border-border cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedImageData(
                              interpretation.imageData,
                            );
                            setSelectedImageInterpretation(
                              interpretation,
                            );
                            setShowImagePopup(true);
                          }}
                          data-testid={`thumbnail-image-${interpretation.id}`}
                        />
                        <p className="text-muted-foreground line-clamp-2 flex-1">
                          <strong>
                            {language === "he"
                              ? "טקסט מזוהה"
                              : "Extracted text"}
                            :
                          </strong>{" "}
                          {interpretation.originalInput}
                        </p>
                      </div>
                    ) : (
                      <p className="text-muted-foreground line-clamp-2">
                        <strong>
                          {language === "he" ? "טקסט תת״ח" : "AAC text"}
                          :
                        </strong>{" "}
                        {interpretation.originalInput}
                      </p>
                    )}
                    <p className="text-foreground line-clamp-3">
                      <strong>
                        {language === "he" ? "פרשנות" : "Meaning"}:
                      </strong>{" "}
                      {interpretation.interpretedMeaning}
                    </p>
                  </div>
                  </div>
                ),
              )}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {language === "he"
                  ? "אין פרשנויות עדיין. נסה לפרש תקשורת תת״ח!"
                  : "No interpretations yet. Try interpreting some AAC communication!"}
              </p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
