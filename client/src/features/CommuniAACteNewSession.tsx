// CommuniAACteNewSession.tsx
// src/features/CommuniAACteFeature.tsx
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  MessageCircle,
  Edit3,
  Image,
  Brain,
  Lightbulb,
  CheckCircle,
  Save,
  Share,
  X,
  History,
  Trash2,
  Upload,
  Eye,
  AlertTriangle,
  Crop as CropIcon,
  Share2,
  Copy,
  MessageSquare,
  Mail,
  MapPin,
  Clock,
  FileText,
  ArrowRight,
  ArrowLeft,
  Camera,
  FolderOpen,
  ChevronUp,
  Settings,
  User,
  Plus,
  Edit,
  Shield,
  Users,
  Minus,
  Calendar,
  Moon,
  Sun,
  LogOut,
  LogIn,
} from "lucide-react";
import cameraIcon from "@assets/image_icon_36x36_rounded_1757619072314.png";
import appLogo from "@assets/CommuniAACte Logo NEW 1_1757674447962.png";
import creditIcon from "@assets/credit_icon_1757751437047.png";
import ReactCrop, { Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { LanguageSelector } from "@/components/LanguageSelector";
import { ScheduleManager } from "@/components/ScheduleManager";
import { useAuth } from "@/hooks/useAuth";
import type {
  Interpretation,
  InsertInviteCode,
  RedeemInviteCode,
} from "@shared/schema";
import { insertInviteCodeSchema, redeemInviteCodeSchema } from "@shared/schema";

interface InterpretationResponse {
  success: boolean;
  interpretation: Interpretation;
  interpretedMeaning: string;
  analysis: string[];
  confidence: number;
  suggestedResponse: string;
}

type Props = {
  isLoading: boolean;
  inputText: string;
  setInputText: (v: string) => void;
  croppedImageBlob: Blob | null;
  imagePreview: string | null;
  handleTextInterpret: () => void;
  handleImageInterpret: () => void;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleCameraCapture: () => void;
  handleGallerySelect: () => void;
  handleClear: () => void;
  currentInterpretation: InterpretationResponse | null;
  t: (k: string) => string;
  isRTL: boolean;
  language: string;
  setShowImageMenu: (v: boolean) => void;
  showImageMenu: boolean;
    loadingHistoricalSuggestions: boolean;
    showHistoricalSuggestions: boolean;
    historicalSuggestions: {
      pattern: string;
      interpretation: string;
      confidence: number;
      frequency: number;
    }[];
    handleSuggestionSelect: (suggestion: {
      pattern: string;
      interpretation: string;
      confidence: number;
      frequency: number;
    }) => void;
    setShowCropDialog: (v: boolean) => void;
    contextInfo: {
      selectedAacUserId: string | null;
    };
    shareInterpretation: (method: "whatsapp" | "copy" | "email") => void;

};

export function CommuniAACteNewSession(props: Props) {
  const {
    isLoading,
    inputText,
    setInputText,
    croppedImageBlob,
    imagePreview,
    handleTextInterpret,
    handleImageInterpret,
    handleFileChange,
    handleCameraCapture,
    handleGallerySelect,
    handleClear,
    currentInterpretation,
    t,
    isRTL,
    language,
    setShowImageMenu,
    showImageMenu,
    loadingHistoricalSuggestions,
    showHistoricalSuggestions,
    historicalSuggestions,
    handleSuggestionSelect,
    setShowCropDialog,
    contextInfo,
    shareInterpretation,
  } = props;
  
  const {
    user,
    isAuthenticated,
    isLoading: authLoading,
    logout,
    login,
    refetchUser,
  } = useAuth();

  return (
    <>
        {/* Input Section */}
        
        <Card>
          <CardHeader>
            <CardTitle
              className={`flex items-center gap-2 ${isRTL ? "w-full justify-end flex-row-reverse text-right" : ""}`}
            >
              <Edit3 className="text-primary" />
              {user && user.firstName 
                ? language === "he" 
                  ? `שלום, ${user.firstName}, מה תרצה לפרש?`
                  : `Hi ${user.firstName}, what would you like to interpret?`
                : t("input.textAnalysis")
              }
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Text Input with Camera Icon */}
            <div className="space-y-4">
              <div className="relative">
                <div className="relative">
                  <Textarea
                    id="aac-text"
                    rows={4}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder={t("input.textPlaceholder")}
                    className="resize-none pl-12"
                  />
                  {/* Camera Icon in Left Bottom Corner */}
                  <div
                    className="absolute"
                    style={{ bottom: "4px", left: "8px" }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowImageMenu(!showImageMenu)}
                      className="w-6 h-6 p-0 hover:bg-primary/10"
                    >
                      <img src={cameraIcon} alt="Camera" className="w-6 h-6" />
                    </Button>

                    {/* Image Menu Dropdown */}
                    {showImageMenu && (
                      <div className="absolute bottom-full left-0 mb-1 bg-background border border-border rounded-lg shadow-lg py-2 min-w-[150px] z-50">
                        <button
                          onClick={handleCameraCapture}
                          className="w-full px-3 py-2 text-sm text-left hover:bg-muted flex items-center gap-2"
                        >
                          <Camera className="w-4 h-4" />
                          {language === "he" ? "צלם תמונה" : "Take Photo"}
                        </button>
                        <button
                          onClick={handleGallerySelect}
                          className="w-full px-3 py-2 text-sm text-left hover:bg-muted flex items-center gap-2"
                        >
                          <FolderOpen className="w-4 h-4" />
                          {language === "he" ? "בחר מגלריה" : "From Gallery"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Historical Suggestions */}
                {(showHistoricalSuggestions || loadingHistoricalSuggestions) &&
                  contextInfo.selectedAacUserId &&
                  inputText.trim().length >= 2 && (
                    <div className="mt-2 border border-primary/20 rounded-lg bg-primary/5 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Brain className="w-4 h-4 text-primary" />
                        <h4 className="text-sm font-medium text-primary">
                          {language === "he"
                            ? "הצעות מההיסטוריה"
                            : "Historical Suggestions"}
                        </h4>
                        {loadingHistoricalSuggestions && (
                          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary"></div>
                        )}
                      </div>

                      {loadingHistoricalSuggestions ? (
                        <p className="text-sm text-muted-foreground text-center py-2">
                          {language === "he"
                            ? "מחפש דפוסים בהיסטוריה..."
                            : "Searching for patterns in history..."}
                        </p>
                      ) : historicalSuggestions.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-2">
                          {language === "he"
                            ? "אין דפוסים תואמים בהיסטוריה שלך"
                            : "No matching patterns in your history"}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {historicalSuggestions
                            .slice(0, 3)
                            .map((suggestion, index) => (
                              <div
                                key={index}
                                onClick={() =>
                                  handleSuggestionSelect(suggestion)
                                }
                                className="cursor-pointer bg-background hover:bg-muted border border-border rounded p-2 transition-colors"
                                data-testid={`historical-suggestion-${index}`}
                              >
                                <div className="flex justify-between items-start gap-2">
                                  <div className="flex-1">
                                    <p className="text-sm text-foreground font-medium">
                                      {suggestion.interpretation}
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-1">
                                      {language === "he"
                                        ? "דפוס מקורי"
                                        : "Original pattern"}
                                      : "{suggestion.pattern}"
                                    </p>
                                  </div>
                                  <div className="flex flex-col items-end gap-1 shrink-0">
                                    <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                                      {Math.round(suggestion.confidence * 100)}%
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {language === "he" ? "תדירות" : "Used"}:{" "}
                                      {suggestion.frequency}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            ))}
                          {historicalSuggestions.length > 3 && (
                            <p className="text-xs text-muted-foreground text-center mt-2">
                              {language === "he"
                                ? `ועוד ${historicalSuggestions.length - 3} הצעות...`
                                : `And ${historicalSuggestions.length - 3} more suggestions...`}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                {/* Hidden File Inputs */}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleFileChange}
                  className="hidden"
                  id="camera-input"
                />
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                  id="gallery-input"
                />

                {/* Image Preview */}
                {croppedImageBlob && imagePreview && (
                  <div className="mt-4 space-y-2">
                    <p className="text-sm text-foreground font-medium">
                      {t("input.imageCropped")}
                    </p>
                    <div className="relative inline-block">
                      <img
                        src={URL.createObjectURL(croppedImageBlob)}
                        alt="Cropped preview"
                        className="max-w-full max-h-32 rounded border border-border"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowCropDialog(true)}
                        className="absolute top-1 right-1 p-1 h-auto bg-background/80 backdrop-blur"
                      >
                        <CropIcon className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <Button
                onClick={
                  croppedImageBlob ? handleImageInterpret : handleTextInterpret
                }
                disabled={isLoading}
                className="w-full bg-primary hover:bg-primary-dark text-primary-foreground py-3 sm:py-2"
              >
                {isLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    <span className="text-sm sm:text-base">
                      {t("button.processing")}
                    </span>
                  </>
                ) : (
                  <span className="text-sm sm:text-base">
                    {t("button.start")}
                  </span>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>


        {currentInterpretation && (
          <Card>
            <CardHeader>
              <CardTitle
                className={`flex items-center gap-2 ${isRTL ? "w-full justify-end flex-row-reverse text-right" : ""}`}
              >
                <Lightbulb className="text-secondary" />
                {t("result.interpretation")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Original Input Display */}
              <div>
                <h3 className="text-sm font-medium text-foreground mb-2">
                  {t("result.aacText")}:
                </h3>
                <div className="bg-muted p-3 rounded-lg border">
                  <span className="text-foreground font-mono">
                    {currentInterpretation.interpretation.originalInput}
                  </span>
                </div>
              </div>

              {/* Interpreted Meaning */}
              <div>
                <h3 className="text-sm font-medium text-foreground mb-2">
                  {t("result.meaningShort")}:
                </h3>
                <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg">
                  <div className="flex items-start gap-3">
                    <MessageCircle className="text-primary text-lg mt-1 flex-shrink-0" />
                    <div>
                      <p className="text-foreground text-base leading-relaxed">
                        "{currentInterpretation.interpretedMeaning}"
                      </p>
                      <Separator className="my-3 border-t-blue-200" />
                      <h4 className="text-sm font-medium text-foreground mb-2">
                        {t("result.analysis")}:
                      </h4>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        {currentInterpretation.analysis.map((point, index) => (
                          <li key={index}>• {point}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              {/* Share Section */}
              <div className="bg-muted/50 border border-border p-4 rounded-lg">
                <h4 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                  <Share2 className="text-secondary" />
                  {t("share.title")}
                </h4>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => shareInterpretation("whatsapp")}
                    className="flex items-center gap-2"
                  >
                    <MessageSquare className="h-4 w-4" />
                    {t("share.whatsapp")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => shareInterpretation("copy")}
                    className="flex items-center gap-2"
                  >
                    <Copy className="h-4 w-4" />
                    {t("share.copy")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => shareInterpretation("email")}
                    className="flex items-center gap-2"
                  >
                    <Mail className="h-4 w-4" />
                    {t("share.email")}
                  </Button>
                </div>
              </div>

              {/* Confidence & Suggestions */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="bg-green-50 border border-green-200 p-4 rounded-lg">
                  <h4 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
                    <CheckCircle className="text-secondary" />
                    {t("result.confidence")}
                  </h4>
                  <div className="flex items-center gap-2">
                    <Progress
                      value={currentInterpretation.confidence * 100}
                      className="flex-1"
                    />
                    <span className="text-sm font-medium text-foreground">
                      {Math.round(currentInterpretation.confidence * 100)}%
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {currentInterpretation.confidence > 0.8
                      ? t("result.confidenceHigh")
                      : currentInterpretation.confidence > 0.6
                        ? t("result.confidenceMedium")
                        : t("result.confidenceLow")}
                  </p>
                </div>

                <div className="bg-orange-50 border border-orange-200 p-4 rounded-lg">
                  <h4 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
                    <Lightbulb className="text-orange-500" />
                    {t("result.suggestedResponse")}
                  </h4>
                  <p className="text-sm text-foreground">
                    "{currentInterpretation.suggestedResponse}"
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap gap-2 sm:gap-3 pt-4 border-t border-border">
                <Button
                  variant="outline"
                  onClick={handleClear}
                  className="flex items-center gap-2 text-sm"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

      {/* Result Section – copy your existing {currentInterpretation && <Card>... */}
      {currentInterpretation && (
        <Card>
          <CardHeader>
            <CardTitle
              className={`flex items-center gap-2 ${
                isRTL ? "w-full justify-end flex-row-reverse text-right" : ""
              }`}
            >
              <Lightbulb className="text-secondary" />
              {t("result.interpretation")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* copy the rest of your result markup exactly, but using currentInterpretation from props */}
            {/* e.g. original input block, analysis list, confidence bar, suggested response, share buttons */}
          </CardContent>
        </Card>
      )}
    </>
  );
}
