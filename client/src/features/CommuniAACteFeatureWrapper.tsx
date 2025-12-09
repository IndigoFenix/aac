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

// Tiny hook we’ll add in step C to wire shell header buttons to these dialogs
import { useUIEvent } from "@/lib/uiEvents";
import { CommuniAACteNewSession } from "./CommuniAACteNewSession";
import { Outlet, useLocation } from "react-router-dom";

interface InterpretationResponse {
  success: boolean;
  interpretation: Interpretation;
  interpretedMeaning: string;
  analysis: string[];
  confidence: number;
  suggestedResponse: string;
}

export function CommuniAACteFeature() {
  // ⬇ paste ALL the state and handlers from Home() here — unchanged.
  // const [inputMethod, setInputMethod] = useState<...>();
  // const textInterpretMutation = useMutation(...);
  // const imageInterpretMutation = useMutation(...);
  // const ... (everything you have in Home)  const [inputMethod, setInputMethod] = useState<"text" | "image">("text");
  const [inputText, setInputText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [showCropDialog, setShowCropDialog] = useState(false);
  const [crop, setCrop] = useState<Crop>();
  const [croppedImageBlob, setCroppedImageBlob] = useState<Blob | null>(null);
  const [currentInterpretation, setCurrentInterpretation] =
    useState<InterpretationResponse | null>(null);
  const [showContextDialog, setShowContextDialog] = useState(false);
  const [showImageMenu, setShowImageMenu] = useState(false);
  const [contextInfo, setContextInfo] = useState({
    selectedStudentId: "" as string, // Mandatory AAC user selection
    location: "",
    locationOption: "" as string, // 'בית', 'בית ספר', 'גן', 'נסיעה', 'custom', or ''
    locationAlias: "" as string, // User-defined alias for GPS locations
    timeContext: "",
    background: "",
    previousEvents: "",
    futureEvents: "",
    useCurrentTime: false,
    useCurrentLocation: false,
  });
  const [pendingInterpretation, setPendingInterpretation] = useState<
    "text" | "image" | null
  >(null);
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  const [showRegisterDialog, setShowRegisterDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [showPrivacyDialog, setShowPrivacyDialog] = useState(false);
  const [showTermsDialog, setShowTermsDialog] = useState(false);
  // Image popup states for history thumbnails
  const [showImagePopup, setShowImagePopup] = useState(false);
  const [selectedImageData, setSelectedImageData] = useState<string | null>(
    null,
  );
  const [selectedImageInterpretation, setSelectedImageInterpretation] =
    useState<Interpretation | null>(null);
  const [isHistoryCollapsed, setIsHistoryCollapsed] = useState(false);

  // Historical suggestions state
  const [historicalSuggestions, setHistoricalSuggestions] = useState<
    Array<{
      interpretation: string;
      confidence: number;
      frequency: number;
      pattern: string;
    }>
  >([]);
  const [showHistoricalSuggestions, setShowHistoricalSuggestions] =
    useState(false);
  const [loadingHistoricalSuggestions, setLoadingHistoricalSuggestions] =
    useState(false);

  const [studentForm, setStudentForm] = useState({
    alias: "",
    gender: "",
    age: "",
    diagnosis: "",
  });
  const [editingStudent, setEditingStudent] = useState<any>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [registerData, setRegisterData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirmPassword: "",
    userType: "Caregiver" as
      | "admin"
      | "Teacher"
      | "Caregiver"
      | "SLP"
      | "Parent",
  });
  const [isRegistering, setIsRegistering] = useState(false);
  const [profileForm, setProfileForm] = useState({
    firstName: "",
    lastName: "",
  });
  const [profileImageFile, setProfileImageFile] = useState<File | null>(null);
  const [profileImagePreview, setProfileImagePreview] = useState<string | null>(
    null,
  );
  // Invite code states
  const [showActiveInviteCodes, setShowActiveInviteCodes] = useState(false);

  // Schedule manager state
  const [scheduleManagerOpen, setScheduleManagerOpen] = useState(false);
  const [scheduleStudent, setScheduleStudent] = useState<{
    studentId: string;
    alias: string;
  } | null>(null);

  // Invite code forms
  const createInviteForm = useForm<InsertInviteCode>({
    resolver: zodResolver(insertInviteCodeSchema),
    defaultValues: {
      studentId: undefined,
      redemptionLimit: 1,
      expiresAt: null,
      isActive: true,
    },
  });

  const redeemInviteForm = useForm<RedeemInviteCode>({
    resolver: zodResolver(redeemInviteCodeSchema),
    defaultValues: {
      code: "",
    },
  });
  // Admin authentication now uses regular user system
  const imgRef = useRef<HTMLImageElement>(null);
  const { toast } = useToast();
  const { t, isRTL, language } = useLanguage();
  const { theme } = useTheme();
  const {
    user,
    isAuthenticated,
    isLoading: authLoading,
    logout,
    login,
    refetchUser,
  } = useAuth();

  // Fetch recent interpretations
  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ["/api/interpretations", user?.id],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/interpretations?limit=10`);
      return res.json();
    },
    enabled: isAuthenticated && !!user,
  });

  // Fetch AAC users
  const { data: studentsData, isLoading: studentsLoading } = useQuery({
    queryKey: ["/api/students"],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/students`);
      return res.json();
    },
    enabled: isAuthenticated,
  });

  // Fetch user's invite codes
  const {
    data: inviteCodesData,
    isLoading: inviteCodesLoading,
    error: inviteCodesError,
  } = useQuery({
    queryKey: ["/api/invite-codes"],
    queryFn: async () => {
      const res = await apiRequest('GET', "/api/invite-codes");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  // Fetch user's saved locations
  const { data: savedLocationsData, isLoading: savedLocationsLoading } =
    useQuery({
      queryKey: ["/api/saved-locations"],
      queryFn: async () => {
        const res = await apiRequest('GET', "/api/saved-locations");
        return res.json();
      },
      enabled: isAuthenticated,
    });

  // Function to fetch historical suggestions
  const fetchHistoricalSuggestions = async (
    studentId: string,
    currentInput: string,
  ) => {
    if (!studentId || !currentInput.trim() || currentInput.length < 2) {
      setHistoricalSuggestions([]);
      setShowHistoricalSuggestions(false);
      return;
    }

    setLoadingHistoricalSuggestions(true);
    try {
      const res = await apiRequest("POST", "/api/historical-suggestions", {
        studentId,
        currentInput: currentInput.trim(),
      });
      const data = await res.json();

      if (data.success && data.suggestions.length > 0) {
        setHistoricalSuggestions(data.suggestions);
        setShowHistoricalSuggestions(true);
      } else {
        setHistoricalSuggestions([]);
        setShowHistoricalSuggestions(false);
      }
    } catch (error) {
      console.error("Failed to fetch historical suggestions:", error);
      setHistoricalSuggestions([]);
      setShowHistoricalSuggestions(false);
    } finally {
      setLoadingHistoricalSuggestions(false);
    }
  };

  // Debounced effect to fetch historical suggestions when user types
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (contextInfo.selectedStudentId && inputText.trim().length >= 2) {
        fetchHistoricalSuggestions(contextInfo.selectedStudentId, inputText);
      } else {
        setHistoricalSuggestions([]);
        setShowHistoricalSuggestions(false);
      }
    }, 500); // 500ms debounce

    return () => clearTimeout(timeoutId);
  }, [inputText, contextInfo.selectedStudentId]);

  // Function to handle suggestion selection
  const handleSuggestionSelect = (suggestion: any) => {
    setInputText(suggestion.pattern); // Use the original pattern as input
    setShowHistoricalSuggestions(false);

    // Show toast with suggestion confidence
    toast({
      title:
        language === "he"
          ? "הצעה נבחרה מההיסטוריה"
          : "Historical Suggestion Selected",
      description: `${language === "he" ? "רמת ביטחון" : "Confidence"}: ${Math.round(suggestion.confidence * 100)}%`,
    });
  };

  // Text interpretation mutation
  const textInterpretMutation = useMutation({
    mutationFn: async (interpretationRequest: any) => {
      const res = await apiRequest(
        "POST",
        "/api/interpret",
        interpretationRequest,
      );
      return res.json();
    },
    onSuccess: (data: InterpretationResponse) => {
      setCurrentInterpretation(data);
      queryClient.invalidateQueries({ queryKey: ["/api/interpretations"] });
      queryClient.invalidateQueries({ queryKey: ["/auth/user"] });
      toast({
        title: t("toast.interpretationSuccess"),
        description: t("toast.interpretationSuccessDesc"),
      });
    },
    onError: (error) => {
      // Handle model overloaded error with user-friendly message
      if (error.message === "MODEL_OVERLOADED") {
        toast({
          title: language === "he" ? "השירות עמוס כעת" : "Service Busy",
          description:
            language === "he"
              ? "בבקשה נסו שוב בעוד דקה..."
              : "Please try again in a minute...",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: t("toast.interpretationFailed"),
        description: error.message || t("toast.interpretationFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Image interpretation mutation
  const imageInterpretMutation = useMutation({
    mutationFn: async ({ file, context }: { file: File; context: any }) => {
      const formData = new FormData();
      formData.append("image", file);
      formData.append(
        "input",
        context.input || `AAC screen image: ${file.name}`,
      );
      formData.append("language", language);

      // Add context data to FormData
      if (context.studentId) {
        formData.append("studentId", context.studentId);
      }
      if (context.studentAlias) {
        formData.append("studentAlias", context.studentAlias);
      }
      if (context.timeContext) {
        formData.append("timeContext", context.timeContext);
      }
      if (context.location) {
        formData.append("location", context.location);
      }
      if (context.background) {
        formData.append("background", context.background);
      }
      if (context.previousEvents) {
        formData.append("previousEvents", context.previousEvents);
      }
      if (context.futureEvents) {
        formData.append("futureEvents", context.futureEvents);
      }

      const res = await  await apiRequest('POST', "/api/interpret", formData);

      if (!res.ok) {
        throw new Error("Failed to process image");
      }

      return res.json();
    },
    onSuccess: (data: InterpretationResponse) => {
      setCurrentInterpretation(data);
      queryClient.invalidateQueries({ queryKey: ["/api/interpretations"] });
      queryClient.invalidateQueries({ queryKey: ["/auth/user"] });
      toast({
        title: t("toast.imageProcessed"),
        description: t("toast.imageProcessedDesc"),
      });
    },
    onError: (error) => {
      // Handle model overloaded error with user-friendly message
      if (error.message === "MODEL_OVERLOADED") {
        toast({
          title: language === "he" ? "השירות עמוס כעת" : "Service Busy",
          description:
            language === "he"
              ? "בבקשה נסו שוב בעוד דקה..."
              : "Please try again in a minute...",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: t("toast.imageProcessingFailed"),
        description: error.message || t("toast.imageProcessingFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Delete interpretation mutation
  const deleteInterpretationMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/interpretations/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/interpretations"] });
      toast({
        title: "Interpretation Deleted",
        description: "The interpretation has been removed from history.",
      });
    },
    onError: (error) => {
      toast({
        title: "Deletion Failed",
        description: error.message || "Failed to delete interpretation",
        variant: "destructive",
      });
    },
  });

  // Create AAC user mutation
  const createStudentMutation = useMutation({
    mutationFn: async (studentData: any) => {
      const res = await apiRequest("POST", "/api/students", studentData);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      setStudentForm({
        alias: "",
        gender: "",
        age: "",
        diagnosis: "",
      });
      toast({
        title: t("toast.studentCreated"),
        description: t("toast.studentCreatedDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.studentCreateFailed"),
        description: error.message || t("toast.studentCreateFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Update AAC user mutation
  const updateStudentMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await apiRequest("PATCH", `/api/students/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      setEditingStudent(null);
      setStudentForm({
        alias: "",
        gender: "",
        age: "",
        diagnosis: "",
      });
      toast({
        title: t("toast.studentUpdated"),
        description: t("toast.studentUpdatedDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.studentUpdateFailed"),
        description: error.message || t("toast.studentUpdateFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Delete AAC user mutation
  const deleteStudentMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/students/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      toast({
        title: t("toast.studentDeleted"),
        description: t("toast.studentDeletedDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.studentDeleteFailed"),
        description: error.message || t("toast.studentDeleteFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Profile update mutation
  const updateProfileMutation = useMutation({
    mutationFn: async (profileData: {
      firstName: string;
      lastName: string;
    }) => {
      const res = await apiRequest("PATCH", "/api/profile/update", profileData);
      return res.json();
    },
    onSuccess: (data) => {
      // Update local user state
      queryClient.invalidateQueries({ queryKey: ["/auth/user"] });
      toast({
        title: t("toast.profileUpdated"),
        description: t("toast.profileUpdatedDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.profileUpdateFailed"),
        description: error.message || t("toast.profileUpdateFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Profile image upload mutation
  const uploadProfileImageMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("profileImage", file);

      // Use apiRequest to maintain CSRF protection
      const res = await apiRequest("POST", "/api/profile/upload-image", formData);

      if (!res.ok) {
        const errorData = await res
          .json()
          .catch(() => ({ message: "Upload failed" }));
        throw new Error(errorData.message || "Image upload failed");
      }

      return res.json();
    },
    onSuccess: (data) => {
      // Update local user state
      queryClient.invalidateQueries({ queryKey: ["/auth/user"] });
      setProfileImageFile(null);
      setProfileImagePreview(null);
      toast({
        title: t("toast.imageUploaded"),
        description: t("toast.imageUploadedDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.imageUploadFailed"),
        description: error.message || t("toast.imageUploadFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Create invite code mutation
  const createInviteCodeMutation = useMutation({
    mutationFn: async (data: InsertInviteCode) => {
      const res = await apiRequest("POST", "/api/invite-codes", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/invite-codes"] });
      createInviteForm.reset();
      toast({
        title: t("toast.inviteCreated"),
        description: t("toast.inviteCreatedDesc"),
      });
    },
    onError: (error: any) => {
      let errorMessage = t("toast.inviteCreateFailedDesc");
      try {
        if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        } else if (error?.message) {
          errorMessage = error.message;
        }
      } catch (e) {
        // Use default message
      }
      toast({
        title: t("toast.inviteCreateFailed"),
        description: errorMessage,
        variant: "destructive",
      });
    },
  });

  // Redeem invite code mutation
  const redeemInviteCodeMutation = useMutation({
    mutationFn: async (data: RedeemInviteCode) => {
      const res = await apiRequest("POST", "/api/invite-codes/redeem", data);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invite-codes"] });
      redeemInviteForm.reset();
      toast({
        title: t("toast.inviteRedeemed"),
        description: `${t("label.student")} "${data.studentAlias}" ${language === "he" ? "נוסף בהצלחה" : "has been added successfully"}`,
      });
    },
    onError: (error: any) => {
      let errorMessage = t("toast.inviteRedeemFailedDesc");
      try {
        if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        } else if (error?.message) {
          errorMessage = error.message;
        }
      } catch (e) {
        // Use default message
      }
      toast({
        title: t("toast.inviteRedeemFailed"),
        description: errorMessage,
        variant: "destructive",
      });
    },
  });

  // Delete invite code mutation
  const deleteInviteCodeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/invite-codes/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/invite-codes"] });
      toast({
        title: t("toast.inviteDeleted"),
        description: t("toast.inviteDeletedDesc"),
      });
    },
    onError: (error: any) => {
      let errorMessage = t("toast.inviteDeleteFailedDesc");
      try {
        if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        } else if (error?.message) {
          errorMessage = error.message;
        }
      } catch (e) {
        // Use default message
      }
      toast({
        title: t("toast.inviteDeleteFailed"),
        description: errorMessage,
        variant: "destructive",
      });
    },
  });

  // Create saved location mutation
  const createSavedLocationMutation = useMutation({
    mutationFn: async (locationData: {
      alias: string;
      locationType: string;
      locationName: string;
      latitude?: number | null;
      longitude?: number | null;
    }) => {
      const res = await apiRequest(
        "POST",
        "/api/saved-locations",
        locationData,
      );
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/saved-locations"] });
      toast({
        title: t("toast.locationSaved"),
        description: t("toast.locationSavedDesc"),
      });
    },
    onError: (error: any) => {
      let errorMessage = t("toast.locationSaveFailedDesc");
      try {
        if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        } else if (error?.message) {
          errorMessage = error.message;
        }
      } catch (e) {
        // Use default message
      }
      toast({
        title: t("toast.locationSaveFailed"),
        description: errorMessage,
        variant: "destructive",
      });
    },
  });

  // Delete saved location mutation
  const deleteSavedLocationMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/saved-locations/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/saved-locations"] });
      toast({
        title: t("toast.locationDeleted"),
        description: t("toast.locationDeletedDesc"),
      });
    },
    onError: (error: any) => {
      let errorMessage = t("toast.locationDeleteFailedDesc");
      try {
        if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        } else if (error?.message) {
          errorMessage = error.message;
        }
      } catch (e) {
        // Use default message
      }
      toast({
        title: t("toast.locationDeleteFailed"),
        description: errorMessage,
        variant: "destructive",
      });
    },
  });

  // Get current time and location
  const getCurrentTimeAndLocation = async () => {
    const currentTime = new Date().toLocaleString(
      language === "he" ? "he-IL" : "en-US",
      {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "long",
      },
    );

    let location = "";
    if (navigator.geolocation) {
      try {
        const position = await new Promise<GeolocationPosition>(
          (resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject);
          },
        );
        location = `${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`;
      } catch (error) {
        location = t("error.locationUnavailable");
      }
    }

    return { currentTime, location };
  };

  // Handle context submission
  const handleContextSubmit = async () => {
    // Validate that an AAC user is selected
    if (
      !contextInfo.selectedStudentId ||
      contextInfo.selectedStudentId.trim() === ""
    ) {
      toast({
        variant: "destructive",
        title: t("error.title"),
        description: t("error.selectStudent"),
      });
      return;
    }

    let finalContext = { ...contextInfo };

    if (contextInfo.useCurrentTime || contextInfo.useCurrentLocation) {
      const { currentTime, location } = await getCurrentTimeAndLocation();
      if (contextInfo.useCurrentTime) {
        finalContext.timeContext = currentTime;
      }
      if (contextInfo.useCurrentLocation) {
        finalContext.location = location;

        // Save location with alias if provided
        if (contextInfo.locationAlias && contextInfo.locationAlias.trim()) {
          try {
            // Parse coordinates from location string (format: "lat, lng")
            const coords = location
              .split(",")
              .map((coord) => parseFloat(coord.trim()));
            if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
              createSavedLocationMutation.mutate({
                alias: contextInfo.locationAlias.trim(),
                locationType: "gps",
                locationName: location,
                latitude: coords[0],
                longitude: coords[1],
              });
            }
          } catch (error) {
            console.warn(
              "Failed to parse coordinates for saved location:",
              error,
            );
          }
        }
      }
    }

    // Get selected AAC user information
    const selectedStudent = studentsData?.students?.find(
      (user: any) =>
        String(user.studentId) === String(finalContext.selectedStudentId),
    );

    // Create context string to append to interpretation
    const studentContext = selectedStudent
      ? [
          `${t("label.student")}: ${selectedStudent.alias}`,
          selectedStudent.age && `${t("label.age")}: ${selectedStudent.age}`,
          selectedStudent.gender &&
            `${t("label.gender")}: ${selectedStudent.gender}`,
          selectedStudent.diagnosis &&
            `${t("label.condition")}: ${selectedStudent.diagnosis}`,
          selectedStudent.backgroundContext &&
            `${t("label.backgroundContext")}: ${selectedStudent.backgroundContext}`,
        ]
          .filter(Boolean)
          .join(", ")
      : "";

    const contextString = [
      studentContext,
      finalContext.timeContext &&
        `${language === "he" ? "זמן" : "Time"}: ${finalContext.timeContext}`,
      finalContext.location &&
        `${language === "he" ? "מיקום" : "Location"}: ${finalContext.location}`,
      finalContext.background &&
        `${language === "he" ? "רקע" : "Background"}: ${finalContext.background}`,
      finalContext.previousEvents &&
        `${language === "he" ? "אירועים קודמים" : "Previous events"}: ${finalContext.previousEvents}`,
      finalContext.futureEvents &&
        `${language === "he" ? "אירועים עתידיים" : "Future events"}: ${finalContext.futureEvents}`,
    ]
      .filter(Boolean)
      .join("\n");

    // Proceed with interpretation
    if (pendingInterpretation === "text") {
      const contextualInput = contextString
        ? `${inputText}\n\n${language === "he" ? "הקשר נוסף" : "Additional context"}:\n${contextString}`
        : inputText;

      // Create structured interpretation request with AAC user data and context
      const interpretationRequest = {
        input: contextualInput,
        inputType: "text",
        language,
        studentId: selectedStudent?.studentId || null,
        studentAlias: selectedStudent?.alias || null,
        timeContext: finalContext.timeContext || null,
        location: finalContext.location || null,
        background: finalContext.background || null,
        previousEvents: finalContext.previousEvents || null,
        futureEvents: finalContext.futureEvents || null,
      };

      // Use the mutation for proper loading state management
      textInterpretMutation.mutate(interpretationRequest);
    } else if (pendingInterpretation === "image") {
      const croppedFile = new File(
        [croppedImageBlob!],
        selectedFile?.name || "cropped-image.jpg",
        {
          type: "image/jpeg",
        },
      );

      // Include context in the image interpretation input
      const imageInput = contextString
        ? `AAC screen image: ${croppedFile.name}\n\n${language === "he" ? "הקשר נוסף" : "Additional context"}:\n${contextString}`
        : `AAC screen image: ${croppedFile.name}`;

      // Create context object for image interpretation
      const imageContext = {
        input: imageInput,
        studentId: selectedStudent?.studentId || null,
        studentAlias: selectedStudent?.alias || null,
        timeContext: finalContext.timeContext || null,
        location: finalContext.location || null,
        background: finalContext.background || null,
        previousEvents: finalContext.previousEvents || null,
        futureEvents: finalContext.futureEvents || null,
      };

      // Use the mutation for proper loading state management
      imageInterpretMutation.mutate({
        file: croppedFile,
        context: imageContext,
      });
    }

    setShowContextDialog(false);
    setPendingInterpretation(null);
    setContextInfo({
      selectedStudentId: "",
      location: "",
      locationOption: "",
      locationAlias: "",
      timeContext: "",
      background: "",
      previousEvents: "",
      futureEvents: "",
      useCurrentTime: false,
      useCurrentLocation: false,
    });
  };

  // AAC User handlers
  const handleCreateStudent = () => {
    if (!studentForm.alias.trim()) {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description:
          language === "he"
            ? "נדרש כינוי למשתמש תת״ח"
            : "AAC user alias is required",
        variant: "destructive",
      });
      return;
    }
    createStudentMutation.mutate(studentForm);
  };

  const handleEditStudent = (student: any) => {
    setEditingStudent(student);
    setStudentForm({
      alias: student.alias || "",
      gender: student.gender || "",
      age: student.age || "",
      diagnosis: student.diagnosis || "",
    });
  };

  const handleUpdateStudent = () => {
    if (!studentForm.alias.trim()) {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description:
          language === "he"
            ? "נדרש כינוי למשתמש תת״ח"
            : "AAC user alias is required",
        variant: "destructive",
      });
      return;
    }
    updateStudentMutation.mutate({ id: editingStudent.id, data: studentForm });
  };

  const handleCancelEdit = () => {
    setEditingStudent(null);
    setStudentForm({
      alias: "",
      gender: "",
      age: "",
      diagnosis: "",
    });
  };

  // Initialize profile form when user data is available
  const initializeProfileForm = useCallback(() => {
    if (user) {
      setProfileForm({
        firstName: user.firstName || "",
        lastName: user.lastName || "",
      });
    }
  }, [user]);

  // Initialize profile form when user changes
  useEffect(() => {
    initializeProfileForm();
  }, [initializeProfileForm]);

  // Handle profile form submission
  const handleUpdateProfile = () => {
    if (!profileForm.firstName.trim()) {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description:
          language === "he" ? "שם פרטי נדרש" : "First name is required",
        variant: "destructive",
      });
      return;
    }
    updateProfileMutation.mutate(profileForm);
  };

  // Handle profile image file selection
  const handleProfileImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type
      if (!file.type.startsWith("image/")) {
        toast({
          title: language === "he" ? "שגיאה" : "Error",
          description:
            language === "he"
              ? "נא לבחור קובץ תמונה תקין (JPG, PNG, GIF)"
              : "Please select a valid image file (JPG, PNG, GIF)",
          variant: "destructive",
        });
        e.target.value = ""; // Clear the input
        return;
      }

      // Validate file size (10MB limit to match server)
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: language === "he" ? "שגיאה" : "Error",
          description:
            language === "he"
              ? "גודל התמונה חייב להיות פחות מ-10MB"
              : "Image size must be less than 10MB",
          variant: "destructive",
        });
        e.target.value = ""; // Clear the input
        return;
      }

      // Clear previous preview URL to prevent memory leaks
      if (profileImagePreview && profileImagePreview.startsWith("blob:")) {
        URL.revokeObjectURL(profileImagePreview);
      }

      setProfileImageFile(file);

      // Create preview
      const reader = new FileReader();
      reader.onload = (e) => {
        setProfileImagePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Handle profile image upload
  const handleUploadProfileImage = () => {
    if (profileImageFile) {
      uploadProfileImageMutation.mutate(profileImageFile);
    }
  };

  // Clear profile image selection
  const handleClearProfileImage = () => {
    // Clean up preview URL to prevent memory leaks
    if (profileImagePreview && profileImagePreview.startsWith("blob:")) {
      URL.revokeObjectURL(profileImagePreview);
    }

    setProfileImageFile(null);
    setProfileImagePreview(null);

    // Clear file input
    const fileInput = document.getElementById(
      "profile-image-input",
    ) as HTMLInputElement;
    if (fileInput) {
      fileInput.value = "";
    }
  };

  // Invite code form handlers
  const handleCreateInviteCode = (data: InsertInviteCode) => {
    createInviteCodeMutation.mutate(data);
  };

  const handleRedeemInviteCode = (data: RedeemInviteCode) => {
    redeemInviteCodeMutation.mutate(data);
  };

  const handleCopyInviteCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast({
        title: language === "he" ? "✅ קוד הועתק" : "✅ Code Copied",
        description:
          language === "he"
            ? `קוד ההזמנה ${code} הועתק ללוח העתקות`
            : `Invite code ${code} copied to clipboard`,
      });
    } catch (error) {
      // Fallback for browsers that don't support clipboard API
      try {
        const textArea = document.createElement("textarea");
        textArea.value = code;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
        toast({
          title: language === "he" ? "✅ קוד הועתק" : "✅ Code Copied",
          description:
            language === "he"
              ? `קוד ההזמנה ${code} הועתק ללוח העתקות`
              : `Invite code ${code} copied to clipboard`,
        });
      } catch (fallbackError) {
        toast({
          title: language === "he" ? "❌ העתקה נכשלה" : "❌ Copy Failed",
          description:
            language === "he"
              ? "לא ניתן להעתיק קוד הזמנה"
              : "Failed to copy invite code",
          variant: "destructive",
        });
      }
    }
  };

  // Admin authentication now uses regular user system (removed old admin login)

  const handleAdminAccess = () => {
    // Admin users are now authenticated through the regular user system
    // Redirect directly to admin panel
    window.location.href = "/admin";
  };

  // Share interpretation function
  const shareInterpretation = (type: "whatsapp" | "copy" | "email") => {
    if (!currentInterpretation) return;

    const { interpretedMeaning, analysis, confidence, suggestedResponse } =
      currentInterpretation;
    const originalInput = currentInterpretation.interpretation.originalInput;

    const shareText =
      language === "he"
        ? `🗣️ פרשנות תקשורת מסייעת CommuniAACte

📝 קלט מקורי: ${originalInput}

💭 המשמעות המפורשת:
"${interpretedMeaning}"

🔍 ניתוח:
${analysis.map((point) => `• ${point}`).join("\n")}

📊 רמת ביטחון: ${Math.round(confidence * 100)}%

💡 תגובה מוצעת:
"${suggestedResponse}"

---
CommuniAACte מפרש תת"ח`
        : `🗣️ CommuniAACteAAC - Communication Interpretation

📝 Original Input: ${originalInput}

💭 Interpreted Meaning:
"${interpretedMeaning}"

🔍 Analysis:
${analysis.map((point) => `• ${point}`).join("\n")}

📊 Confidence Level: ${Math.round(confidence * 100)}%

💡 Suggested Response:
"${suggestedResponse}"

---
Generated by CommuniAACte`;

    switch (type) {
      case "whatsapp":
        const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
        window.open(whatsappUrl, "_blank");
        break;
      case "copy":
        navigator.clipboard
          .writeText(shareText)
          .then(() => {
            toast({
              title: t("toast.copied"),
              description: t("toast.copiedDesc"),
            });
          })
          .catch(() => {
            toast({
              title: t("toast.copyFailed"),
              description: t("toast.copyFailedDesc"),
              variant: "destructive",
            });
          });
        break;
      case "email":
        const subject =
          language === "he"
            ? "פרשנות תקשורת מסייעת"
            : "AAC Communication Interpretation";
        const emailUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(shareText)}`;
        window.location.href = emailUrl;
        break;
    }
  };

  const handleTextInterpret = () => {
    // Check authentication first
    if (!isAuthenticated) {
      toast({
        title: language === "he" ? "נדרשת התחברות" : "Login Required",
        description:
          language === "he"
            ? "יש להתחבר כדי להשתמש בשירות הפרשנות"
            : "Please log in to use the interpretation service",
        variant: "destructive",
      });
      setShowLoginDialog(true);
      return;
    }

    if (!inputText.trim()) {
      toast({
        title: t("toast.textRequired"),
        description: t("toast.textRequiredDesc"),
        variant: "destructive",
      });
      return;
    }
    setPendingInterpretation("text");
    setShowContextDialog(true);
  };

  const handleImageInterpret = () => {
    // Check authentication first
    if (!isAuthenticated) {
      toast({
        title: language === "he" ? "נדרשת התחברות" : "Login Required",
        description:
          language === "he"
            ? "יש להתחבר כדי להשתמש בשירות הפרשנות"
            : "Please log in to use the interpretation service",
        variant: "destructive",
      });
      setShowLoginDialog(true);
      return;
    }

    if (!croppedImageBlob) {
      toast({
        title: t("toast.imageRequired"),
        description: t("toast.imageRequiredDesc"),
        variant: "destructive",
      });
      return;
    }
    setPendingInterpretation("image");
    setShowContextDialog(true);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.type.startsWith("image/")) {
        setSelectedFile(file);

        // Create preview URL
        const reader = new FileReader();
        reader.onload = () => {
          setImagePreview(reader.result as string);
          setShowCropDialog(true);
        };
        reader.readAsDataURL(file);
      } else {
        toast({
          title: t("toast.invalidFile"),
          description: t("toast.invalidFileDesc"),
          variant: "destructive",
        });
      }
    }
    setShowImageMenu(false);
  };

  const handleCameraCapture = () => {
    const cameraInput = document.getElementById(
      "camera-input",
    ) as HTMLInputElement;
    cameraInput?.click();
  };

  const handleGallerySelect = () => {
    const galleryInput = document.getElementById(
      "gallery-input",
    ) as HTMLInputElement;
    galleryInput?.click();
  };

  const onImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const { width, height } = e.currentTarget;
      const crop = centerCrop(
        makeAspectCrop(
          {
            unit: "%",
            width: 90,
          },
          1,
          width,
          height,
        ),
        width,
        height,
      );
      setCrop(crop);
    },
    [],
  );

  const getCroppedImg = useCallback(
    (image: HTMLImageElement, crop: Crop): Promise<Blob> => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        throw new Error("No 2d context");
      }

      const scaleX = image.naturalWidth / image.width;
      const scaleY = image.naturalHeight / image.height;

      canvas.width = crop.width;
      canvas.height = crop.height;

      ctx.drawImage(
        image,
        crop.x * scaleX,
        crop.y * scaleY,
        crop.width * scaleX,
        crop.height * scaleY,
        0,
        0,
        crop.width,
        crop.height,
      );

      return new Promise((resolve) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              throw new Error("Canvas is empty");
            }
            resolve(blob);
          },
          "image/jpeg",
          0.9,
        );
      });
    },
    [],
  );

  const handleCropComplete = async () => {
    if (imgRef.current && crop && crop.width && crop.height) {
      try {
        const croppedImage = await getCroppedImg(imgRef.current, crop);
        setCroppedImageBlob(croppedImage);
        setShowCropDialog(false);

        toast({
          title: t("toast.imageCropped"),
          description: t("toast.imageCroppedDesc"),
        });
      } catch (e) {
        toast({
          title: t("toast.cropFailed"),
          description: t("toast.cropFailedDesc"),
          variant: "destructive",
        });
      }
    }
  };

  const handleCropCancel = () => {
    setShowCropDialog(false);
    setSelectedFile(null);
    setImagePreview(null);
    setCroppedImageBlob(null);
  };

  const handleClear = () => {
    setCurrentInterpretation(null);
    setInputText("");
    setSelectedFile(null);
    setImagePreview(null);
    setCroppedImageBlob(null);
  };

  const handleSelectHistoryItem = (interpretation: Interpretation) => {
    setCurrentInterpretation({
      success: true,
      interpretation,
      interpretedMeaning: interpretation.interpretedMeaning,
      analysis: interpretation.analysis,
      confidence: interpretation.confidence,
      suggestedResponse: interpretation.suggestedResponse,
    });
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginEmail.trim() || !loginPassword.trim()) {
      toast({
        title: t("auth.error"),
        description: t("auth.fieldsRequired"),
        variant: "destructive",
      });
      return;
    }

    setIsLoggingIn(true);
    try {
      const success = await login(loginEmail, loginPassword);
      if (success) {
        setShowLoginDialog(false);
        setLoginEmail("");
        setLoginPassword("");
        toast({
          title: t("auth.loginSuccess"),
          description: t("auth.welcomeBack"),
        });
      } else {
        toast({
          title: t("auth.loginFailed"),
          description: t("auth.invalidCredentials"),
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: t("auth.loginFailed"),
        description: t("auth.loginError"),
        variant: "destructive",
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !registerData.firstName.trim() ||
      !registerData.lastName.trim() ||
      !registerData.email.trim() ||
      !registerData.password.trim() ||
      !registerData.confirmPassword.trim()
    ) {
      toast({
        title: t("auth.error"),
        description: t("auth.fieldsRequired"),
        variant: "destructive",
      });
      return;
    }

    if (registerData.password !== registerData.confirmPassword) {
      toast({
        title: t("auth.error"),
        description: t("auth.passwordMismatch"),
        variant: "destructive",
      });
      return;
    }

    setIsRegistering(true);
    try {
      const body = {
        email: registerData.email,
        firstName: registerData.firstName,
        lastName: registerData.lastName,
        password: registerData.password,
        userType: registerData.userType,
      }
      const response = await apiRequest("POST", "/auth/register", body);

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Registration failed");
      }

      // Update user context with the new user data
      await refetchUser();

      toast({
        title: t("auth.registerSuccess"),
        description: t("auth.registerSuccessDesc"),
      });
      setShowRegisterDialog(false);
      setRegisterData({
        firstName: "",
        lastName: "",
        email: "",
        password: "",
        confirmPassword: "",
        userType: "Caregiver",
      });
    } catch (error) {
      toast({
        title: t("auth.registerFailed"),
        description: t("auth.registerError"),
        variant: "destructive",
      });
    } finally {
      setIsRegistering(false);
    }
  };

  const isLoading =
    textInterpretMutation.isPending || imageInterpretMutation.isPending;

    const location = useLocation();
    const isBaseRoute = location.pathname === "/interpret";

  // Bridge: let shell header open these dialogs without moving them yet
  useUIEvent("login",     () => setShowLoginDialog(true));
  useUIEvent("register",  () => setShowRegisterDialog(true));
  useUIEvent("settings",  () => setShowSettingsDialog(true));
  useUIEvent("about",     () => setShowAboutDialog(true));
  useUIEvent("privacy",   () => setShowPrivacyDialog(true));
  useUIEvent("terms",     () => setShowTermsDialog(true));

  return (
    <div dir={isRTL ? "rtl" : "ltr"}>
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
        {isBaseRoute ? (
          <CommuniAACteNewSession
            isLoading={isLoading}
            inputText={inputText}
            setInputText={setInputText}
            croppedImageBlob={croppedImageBlob}
            imagePreview={imagePreview}
            handleTextInterpret={handleTextInterpret}
            handleImageInterpret={handleImageInterpret}
            handleFileChange={handleFileChange}
            handleCameraCapture={handleCameraCapture}
            handleGallerySelect={handleGallerySelect}
            handleClear={handleClear}
            setShowImageMenu={setShowImageMenu}
            showImageMenu={showImageMenu}
            currentInterpretation={currentInterpretation}
            loadingHistoricalSuggestions={loadingHistoricalSuggestions}
            historicalSuggestions={historicalSuggestions}
            showHistoricalSuggestions={showHistoricalSuggestions}
            handleSuggestionSelect={handleSuggestionSelect}
            setShowCropDialog={setShowCropDialog}
            contextInfo={contextInfo}
            shareInterpretation={shareInterpretation}
            t={t}
            isRTL={isRTL}
            language={language}
            // onShare={handleShare}
            // user={user}
          />
        ) : (
          // nested routes: /communiacte/history, /communiacte/history/:id
          <Outlet />
        )}
      </div>

      {/* === B) DIALOGS & POPUPS */}

      {/* Image Crop Dialog */}
      <Dialog open={showCropDialog} onOpenChange={setShowCropDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CropIcon className="w-5 h-5" />
              {t("crop.title")}
            </DialogTitle>
          </DialogHeader>

          <DialogDescription>{t("crop.description")}</DialogDescription>

          <div className="space-y-4">
            {imagePreview && (
              <div className="flex justify-center">
                <ReactCrop
                  crop={crop}
                  onChange={(_, percentCrop) => setCrop(percentCrop)}
                  onComplete={(c) => setCrop(c)}
                  aspect={undefined}
                  minWidth={50}
                  minHeight={50}
                >
                  <img
                    ref={imgRef}
                    alt="Crop me"
                    src={imagePreview}
                    onLoad={onImageLoad}
                    className="max-w-full max-h-[60vh] object-contain"
                  />
                </ReactCrop>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={handleCropCancel}>
              {t("button.cancel")}
            </Button>
            <Button
              onClick={handleCropComplete}
              className="bg-secondary hover:bg-green-700"
            >
              <CropIcon className="w-4 h-4 mr-2" />
              {t("button.applyCrop")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image Popup Dialog */}
      <Dialog open={showImagePopup} onOpenChange={setShowImagePopup}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Image className="w-5 h-5" />
              {language === "he"
                ? "תמונת תקשורת תת״ח"
                : "AAC Communication Image"}
            </DialogTitle>
            <DialogDescription>
              {selectedImageInterpretation && (
                <div className="flex flex-col gap-1 text-sm">
                  <span>
                    {(() => {
                      const date = new Date(
                        selectedImageInterpretation.createdAt,
                      );
                      const locale = language === "he" ? "he-IL" : "en-US";
                      return `${date.toLocaleDateString(locale)} ${date.toLocaleTimeString(
                        locale,
                        {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: language !== "he",
                        },
                      )}`;
                    })()}
                  </span>
                  {selectedImageInterpretation.studentName && (
                    <span>
                      {language === "he" ? "עבור" : "For"}:{" "}
                      {selectedImageInterpretation.studentName}
                    </span>
                  )}
                </div>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {selectedImageData && (
              <div className="flex justify-center">
                <img
                  src={`data:image/jpeg;base64,${selectedImageData}`}
                  alt={
                    language === "he"
                      ? "תמונת תקשורת תת״ח"
                      : "AAC Communication Image"
                  }
                  className="max-w-full max-h-[60vh] object-contain rounded-lg border border-border"
                  data-testid="popup-image-full"
                />
              </div>
            )}

            {selectedImageInterpretation && (
              <div className="space-y-4 bg-muted/50 p-4 rounded-lg">
                {/* Original Input Text - prominently displayed */}
                <div>
                  <h3 className="text-sm font-medium text-foreground mb-2">
                    {language === "he"
                      ? "טקסט מקורי (תת״ח):"
                      : "Original Input (AAC):"}
                  </h3>
                  <div
                    className="bg-background dark:bg-background border border-border p-3 rounded-lg"
                    data-testid="text-original-input"
                  >
                    <span className="text-foreground font-mono text-base leading-relaxed whitespace-pre-wrap break-words">
                      {selectedImageInterpretation.originalInput}
                    </span>
                  </div>
                </div>

                {/* Interpretation */}
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2">
                    {language === "he" ? "פרשנות:" : "Interpretation:"}
                  </h4>
                  <div
                    className="bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30 p-3 rounded-lg"
                    data-testid="text-interpretation"
                  >
                    <p className="text-foreground text-sm leading-relaxed whitespace-pre-wrap break-words">
                      "{selectedImageInterpretation.interpretedMeaning}"
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImagePopup(false)}>
              {t("ui.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Context Dialog */}
      <Dialog open={showContextDialog} onOpenChange={setShowContextDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {t("context.title")}
            </DialogTitle>
            <DialogDescription>{t("context.description")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* AAC User Selection - MANDATORY */}
            <div className="space-y-2 p-4 border border-orange-200 bg-orange-50/50 rounded-lg">
              <Label
                htmlFor="student"
                className="flex items-center gap-2 font-semibold text-orange-800"
              >
                <User className="h-4 w-4" />
                {language === "he"
                  ? 'בחר משתמש תת"ח (חובה)'
                  : "Select AAC User (Required)"}
                <span className="text-red-500">*</span>
              </Label>
              <Select
                value={contextInfo.selectedStudentId}
                onValueChange={(value) =>
                  setContextInfo((prev) => ({
                    ...prev,
                    selectedStudentId: value,
                  }))
                }
                required
              >
                <SelectTrigger
                  data-testid="select-student"
                  className="border-orange-200"
                >
                  <SelectValue
                    placeholder={
                      language === "he"
                        ? 'בחר את משתמש תת"ח שעבורו תבוצע הפרשנות...'
                        : "Select the AAC user for this interpretation..."
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {studentsLoading ? (
                    <SelectItem value="loading" disabled>
                      {language === "he" ? "טוען..." : "Loading..."}
                    </SelectItem>
                  ) : studentsData?.students?.length > 0 ? (
                    studentsData.students
                      .filter(
                        (student: any) =>
                          student.studentId &&
                          String(student.studentId).trim() !== "",
                      )
                      .map((student: any) => (
                        <SelectItem
                          key={student.studentId}
                          value={String(student.studentId)}
                        >
                          <div className="flex flex-col">
                            <span className="font-medium">{student.alias}</span>
                            <span className="text-xs text-muted-foreground">
                              {[
                                student.age &&
                                  `${language === "he" ? "גיל" : "Age"}: ${student.age}`,
                                student.gender &&
                                  `${language === "he" ? "מגדר" : "Gender"}: ${student.gender}`,
                                student.diagnosis &&
                                  `${language === "he" ? "אבחנה" : "Condition"}: ${student.diagnosis}`,
                              ]
                                .filter(Boolean)
                                .join(" • ")}
                            </span>
                          </div>
                        </SelectItem>
                      ))
                  ) : (
                    <SelectItem value="no-users" disabled>
                      {language === "he"
                        ? "אין משתמשי תת״ח זמינים - צור חדש בהגדרות"
                        : "No AAC users available - create one in settings"}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              {!contextInfo.selectedStudentId && (
                <p className="text-sm text-orange-700">
                  {language === "he"
                    ? 'חובה לבחור משתמש תת"ח לפני המשך הפרשנות'
                    : "You must select an AAC user before continuing with interpretation"}
                </p>
              )}
            </div>

            {/* Time and Location */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label
                  htmlFor="timeContext"
                  className="flex items-center gap-2"
                >
                  <Clock className="h-4 w-4" />
                  {t("context.time")}
                </Label>
                <Input
                  id="timeContext"
                  value={contextInfo.timeContext}
                  onChange={(e) =>
                    setContextInfo((prev) => ({
                      ...prev,
                      timeContext: e.target.value,
                    }))
                  }
                  placeholder={t("context.timePlaceholder")}
                  disabled={contextInfo.useCurrentTime}
                />
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="useCurrentTime"
                    checked={contextInfo.useCurrentTime}
                    onCheckedChange={(checked) =>
                      setContextInfo((prev) => ({
                        ...prev,
                        useCurrentTime: checked as boolean,
                      }))
                    }
                  />
                  <Label htmlFor="useCurrentTime" className="text-sm">
                    {t("context.useCurrentTime")}
                  </Label>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="location" className="flex items-center gap-2">
                  <MapPin className="h-4 w-4" />
                  {t("context.location")}
                </Label>

                {/* Location Selection */}
                <div className="space-y-2">
                  <Select
                    value={contextInfo.locationOption || ""}
                    onValueChange={(value) => {
                      if (value === "custom") {
                        setContextInfo((prev) => ({
                          ...prev,
                          locationOption: "custom",
                          location: "",
                        }));
                      } else {
                        setContextInfo((prev) => ({
                          ...prev,
                          locationOption: value,
                          location: value,
                        }));
                      }
                    }}
                    disabled={contextInfo.useCurrentLocation}
                  >
                    <SelectTrigger data-testid="select-location-preset">
                      <SelectValue
                        placeholder={
                          language === "he"
                            ? "בחר מיקום או הכנס חופשי"
                            : "Select location or enter custom"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="בית">
                        {language === "he" ? "בית" : "Home"}
                      </SelectItem>
                      <SelectItem value="בית ספר">
                        {language === "he" ? "בית ספר" : "School"}
                      </SelectItem>
                      <SelectItem value="גן">
                        {language === "he" ? "גן" : "Kindergarten"}
                      </SelectItem>
                      <SelectItem value="נסיעה">
                        {language === "he" ? "נסיעה" : "Travel"}
                      </SelectItem>
                      <SelectItem value="custom">
                        {language === "he"
                          ? "הכנס מיקום אחר..."
                          : "Enter custom location..."}
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Custom location input - show when 'custom' is selected or when user has typed custom text */}
                  {(contextInfo.locationOption === "custom" ||
                    (!contextInfo.locationOption && contextInfo.location)) && (
                    <Input
                      id="location"
                      value={contextInfo.location}
                      onChange={(e) =>
                        setContextInfo((prev) => ({
                          ...prev,
                          location: e.target.value,
                        }))
                      }
                      placeholder={t("context.locationPlaceholder")}
                      disabled={contextInfo.useCurrentLocation}
                      data-testid="input-location-custom"
                    />
                  )}
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="useCurrentLocation"
                    checked={contextInfo.useCurrentLocation}
                    onCheckedChange={(checked) =>
                      setContextInfo((prev) => ({
                        ...prev,
                        useCurrentLocation: checked as boolean,
                      }))
                    }
                  />
                  <Label htmlFor="useCurrentLocation" className="text-sm">
                    {t("context.useCurrentLocation")}
                  </Label>
                </div>

                {/* GPS Location Alias - show when GPS is checked */}
                {contextInfo.useCurrentLocation && (
                  <div className="mt-2 p-3 bg-muted/50 rounded-lg space-y-2">
                    <Label
                      htmlFor="locationAlias"
                      className="text-sm font-medium"
                    >
                      {language === "he"
                        ? "תן שם למיקום זה (אופציונלי)"
                        : "Name this location (optional)"}
                    </Label>
                    <Input
                      id="locationAlias"
                      value={contextInfo.locationAlias || ""}
                      onChange={(e) =>
                        setContextInfo((prev) => ({
                          ...prev,
                          locationAlias: e.target.value,
                        }))
                      }
                      placeholder={
                        language === "he"
                          ? 'לדוגמה: "בית של סבתא" או "הקפה של דיקלה"'
                          : 'e.g. "Grandma\'s house" or "Dikla\'s cafe"'
                      }
                      data-testid="input-location-alias"
                    />
                    <p className="text-xs text-muted-foreground">
                      {language === "he"
                        ? "המיקום יישמר לשימוש עתידי"
                        : "This location will be saved for future use"}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Background Context */}
            <div className="space-y-2">
              <Label htmlFor="background">{t("context.background")}</Label>
              <Textarea
                id="background"
                value={contextInfo.background}
                onChange={(e) =>
                  setContextInfo((prev) => ({
                    ...prev,
                    background: e.target.value,
                  }))
                }
                placeholder={t("context.backgroundPlaceholder")}
                rows={3}
              />
            </div>

            {/* Previous Events */}
            <div className="space-y-2">
              <Label htmlFor="previousEvents">
                {t("context.previousEvents")}
              </Label>
              <Textarea
                id="previousEvents"
                value={contextInfo.previousEvents}
                onChange={(e) =>
                  setContextInfo((prev) => ({
                    ...prev,
                    previousEvents: e.target.value,
                  }))
                }
                placeholder={t("context.previousEventsPlaceholder")}
                rows={3}
              />
            </div>

            {/* Future Events */}
            <div className="space-y-2">
              <Label htmlFor="futureEvents">{t("context.futureEvents")}</Label>
              <Textarea
                id="futureEvents"
                value={contextInfo.futureEvents}
                onChange={(e) =>
                  setContextInfo((prev) => ({
                    ...prev,
                    futureEvents: e.target.value,
                  }))
                }
                placeholder={t("context.futureEventsPlaceholder")}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowContextDialog(false)}
            >
              {t("context.cancel")}
            </Button>
            <Button onClick={handleContextSubmit}>
              {t("context.continue")}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <Dialog open={showSettingsDialog} onOpenChange={setShowSettingsDialog}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle
              className={`flex items-center gap-2 ${language === "he" ? "text-right flex-row-reverse" : "text-left"}`}
            >
              <Settings className="w-5 h-5" />
              {language === "he" ? "הגדרות משתמש" : "User Settings"}
            </DialogTitle>
          </DialogHeader>
          <DialogDescription
            className={language === "he" ? "text-right" : "text-left"}
          >
            {language === "he"
              ? "נהל את משתמשי תת״ח שלך והגדרות אישיות"
              : "Manage your AAC users and personal settings"}
          </DialogDescription>

          <div className="space-y-6">
            {/* Personal Profile Section */}
            <div>
              <h3
                className={`text-lg font-medium mb-4 flex items-center gap-2 ${language === "he" ? "text-right flex-row-reverse" : "text-left"}`}
              >
                <User className="w-5 h-5" />
                {language === "he" ? "פרופיל אישי" : "Personal Profile"}
              </h3>

              <div className="bg-muted/50 p-4 rounded-lg mb-4">
                {/* Profile Image Section */}
                <div className="mb-6">
                  <h4 className="text-sm font-medium mb-3">
                    {language === "he" ? "תמונת פרופיל" : "Profile Image"}
                  </h4>
                  <div className="flex items-center gap-4">
                    {/* Current Profile Image */}
                    <div className="w-16 h-16 rounded-full bg-muted border-2 border-border overflow-hidden">
                      {user?.profileImageUrl ? (
                        <img
                          src={user.profileImageUrl}
                          alt={user.fullName || user.firstName || "Profile"}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-primary/10">
                          <User className="w-8 h-8 text-primary" />
                        </div>
                      )}
                    </div>

                    {/* Image Upload Section */}
                    <div className="flex-1">
                      {profileImagePreview ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <img
                              src={profileImagePreview}
                              alt="Preview"
                              className="w-12 h-12 rounded-full object-cover border"
                            />
                            <span className="text-sm text-foreground">
                              {language === "he"
                                ? "תמונה חדשה נבחרה"
                                : "New image selected"}
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              onClick={handleUploadProfileImage}
                              disabled={uploadProfileImageMutation.isPending}
                              size="sm"
                              className="flex items-center gap-2"
                              data-testid="button-upload-profile-image"
                            >
                              {uploadProfileImageMutation.isPending ? (
                                <>
                                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></div>
                                  {language === "he"
                                    ? "מעלה..."
                                    : "Uploading..."}
                                </>
                              ) : (
                                <>
                                  <Upload className="w-4 h-4" />
                                  {language === "he" ? "העלה" : "Upload"}
                                </>
                              )}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={handleClearProfileImage}
                              size="sm"
                              disabled={uploadProfileImageMutation.isPending}
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleProfileImageChange}
                            className="hidden"
                            id="profile-image-input"
                            data-testid="input-profile-image"
                          />
                          <Button
                            variant="outline"
                            onClick={() =>
                              document
                                .getElementById("profile-image-input")
                                ?.click()
                            }
                            className="flex items-center gap-2"
                            data-testid="button-select-profile-image"
                          >
                            <Camera className="w-4 h-4" />
                            {language === "he" ? "בחר תמונה" : "Select Image"}
                          </Button>
                          <p className="text-xs text-muted-foreground mt-1">
                            {language === "he"
                              ? "JPG, PNG, GIF עד 5MB"
                              : "JPG, PNG, GIF up to 5MB"}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Profile Name Section */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="profileFirstName">
                      {language === "he"
                        ? "שם פרטי (חובה)"
                        : "First Name (Required)"}
                    </Label>
                    <Input
                      id="profileFirstName"
                      value={profileForm.firstName}
                      onChange={(e) =>
                        setProfileForm((prev) => ({
                          ...prev,
                          firstName: e.target.value,
                        }))
                      }
                      placeholder={language === "he" ? "שם פרטי" : "First Name"}
                      required
                      data-testid="input-profile-first-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profileLastName">
                      {language === "he" ? "שם משפחה" : "Last Name"}
                    </Label>
                    <Input
                      id="profileLastName"
                      value={profileForm.lastName}
                      onChange={(e) =>
                        setProfileForm((prev) => ({
                          ...prev,
                          lastName: e.target.value,
                        }))
                      }
                      placeholder={language === "he" ? "שם משפחה" : "Last Name"}
                      data-testid="input-profile-last-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profileEmail">
                      {language === "he" ? "אימייל" : "Email"}
                    </Label>
                    <Input
                      id="profileEmail"
                      value={user?.email || ""}
                      disabled
                      className="bg-muted text-muted-foreground"
                      data-testid="input-profile-email"
                    />
                    <p className="text-xs text-muted-foreground">
                      {language === "he"
                        ? "לא ניתן לשנות כתובת אימייל"
                        : "Email address cannot be changed"}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2 mt-4">
                  <Button
                    onClick={handleUpdateProfile}
                    disabled={updateProfileMutation.isPending}
                    className="flex items-center gap-2"
                    data-testid="button-update-profile"
                  >
                    {updateProfileMutation.isPending ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                        {language === "he" ? "מעדכן..." : "Updating..."}
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4" />
                        {language === "he" ? "עדכן פרופיל" : "Update Profile"}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={initializeProfileForm}
                    disabled={updateProfileMutation.isPending}
                    data-testid="button-reset-profile"
                  >
                    {language === "he" ? "איפוס" : "Reset"}
                  </Button>
                </div>
              </div>
            </div>

            {/* AAC Users Section */}
            <div>
              <h3
                className={`text-lg font-medium mb-4 flex items-center gap-2 ${language === "he" ? "text-right flex-row-reverse" : "text-left"}`}
              >
                <User className="w-5 h-5" />
                {language === "he" ? "משתמשי תת״ח" : "AAC Users"}
              </h3>

              {/* Add New AAC User Form */}
              <div className="bg-muted/50 p-4 rounded-lg mb-4">
                <h4 className="text-sm font-medium mb-3">
                  {editingStudent
                    ? language === "he"
                      ? "ערוך משתמש תת״ח"
                      : "Edit AAC User"
                    : language === "he"
                      ? "הוסף משתמש תת״ח חדש"
                      : "Add New AAC User"}
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="aacAlias">
                      {language === "he" ? "כינוי (חובה)" : "Alias (Required)"}
                    </Label>
                    <Input
                      id="aacAlias"
                      value={studentForm.alias}
                      onChange={(e) =>
                        setStudentForm((prev) => ({
                          ...prev,
                          alias: e.target.value,
                        }))
                      }
                      placeholder={
                        language === "he"
                          ? "לדוגמה: שרה, דני"
                          : "e.g., Sarah, Danny"
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="aacGender">
                      {language === "he" ? "מגדר" : "Gender"}
                    </Label>
                    <Select
                      value={studentForm.gender}
                      onValueChange={(value) =>
                        setStudentForm((prev) => ({ ...prev, gender: value }))
                      }
                    >
                      <SelectTrigger id="aacGender">
                        <SelectValue
                          placeholder={
                            language === "he" ? "בחר מגדר" : "Select gender"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Male">
                          {language === "he" ? "זכר" : "Male"}
                        </SelectItem>
                        <SelectItem value="Female">
                          {language === "he" ? "נקבה" : "Female"}
                        </SelectItem>
                        <SelectItem value="Other">
                          {language === "he" ? "אחר" : "Other"}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="aacAge">
                      {language === "he" ? "גיל" : "Age"}
                    </Label>
                    <Input
                      id="aacAge"
                      value={studentForm.age}
                      onChange={(e) =>
                        setStudentForm((prev) => ({
                          ...prev,
                          age: e.target.value,
                        }))
                      }
                      placeholder={
                        language === "he"
                          ? "לדוגמה: 6 שנים"
                          : "e.g., 6 years old"
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="aacDisability">
                      {language === "he"
                        ? "אבחנה/תסמונת"
                        : "Disability/Syndrome"}
                    </Label>
                    <Input
                      id="aacDisability"
                      value={studentForm.diagnosis}
                      onChange={(e) =>
                        setStudentForm((prev) => ({
                          ...prev,
                          diagnosis: e.target.value,
                        }))
                      }
                      placeholder={
                        language === "he"
                          ? "לדוגמה: תסמונת רט"
                          : "e.g., Rett Syndrome"
                      }
                    />
                  </div>
                </div>
                <div className="flex gap-2 mt-4">
                  <Button
                    onClick={
                      editingStudent ? handleUpdateStudent : handleCreateStudent
                    }
                    disabled={
                      createStudentMutation.isPending ||
                      updateStudentMutation.isPending
                    }
                    className="flex items-center gap-2"
                  >
                    {editingStudent ? (
                      <Edit className="w-4 h-4" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                    {editingStudent
                      ? language === "he"
                        ? "עדכן"
                        : "Update"
                      : language === "he"
                        ? "הוסף"
                        : "Add"}
                  </Button>
                  {editingStudent && (
                    <Button variant="outline" onClick={handleCancelEdit}>
                      {language === "he" ? "בטל" : "Cancel"}
                    </Button>
                  )}
                </div>
              </div>

              {/* Existing AAC Users List */}
              <div className="space-y-2">
                {studentsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                  </div>
                ) : studentsData?.students?.length > 0 ? (
                  studentsData.students.map((student: any) => (
                    <div
                      key={student.id}
                      className="border border-border rounded-lg p-3 flex justify-between items-start"
                    >
                      <div className="space-y-1">
                        <h4 className="font-medium">{student.alias}</h4>
                        <div className="text-sm text-muted-foreground space-y-1">
                          {student.gender && (
                            <p>
                              {language === "he" ? "מגדר" : "Gender"}:{" "}
                              {student.gender}
                            </p>
                          )}
                          {student.age && (
                            <p>
                              {language === "he" ? "גיל" : "Age"}: {student.age}
                            </p>
                          )}
                          {student.diagnosis && (
                            <p>
                              {language === "he" ? "אבחנה" : "Condition"}:{" "}
                              {student.diagnosis}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setScheduleStudent({
                              studentId: student.studentId,
                              alias: student.alias,
                            });
                            setScheduleManagerOpen(true);
                          }}
                          className="p-2"
                          title={
                            language === "he"
                              ? "נהל לוח זמנים"
                              : "Manage Schedule"
                          }
                          data-testid={`button-manage-schedule-${student.id}`}
                        >
                          <Calendar className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditStudent(student)}
                          className="p-2"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() =>
                            deleteStudentMutation.mutate(student.id)
                          }
                          disabled={deleteStudentMutation.isPending}
                          className="p-2"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>
                      {language === "he"
                        ? "אין משתמשי תת״ח עדיין. הוסף את הראשון!"
                        : "No AAC users yet. Add your first one!"}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* AAC User Sharing Section */}
            <div>
              <h3
                className={`text-lg font-medium mb-4 flex items-center gap-2 ${language === "he" ? "text-right flex-row-reverse" : "text-left"}`}
              >
                <Users className="w-5 h-5" />
                {language === "he" ? "שיתוף משתמשי תת״ח" : "AAC User Sharing"}
              </h3>

              <div className="space-y-4">
                {/* Show invite codes query error */}
                {inviteCodesError && (
                  <Alert
                    variant="destructive"
                    data-testid="alert-invite-codes-error"
                  >
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      {language === "he"
                        ? "שגיאה בטעינת קודי הזמנה"
                        : "Error loading invite codes"}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Create Invite Code Section */}
                <div className="bg-muted/50 p-4 rounded-lg">
                  <h4 className="text-sm font-medium mb-3">
                    {language === "he"
                      ? "צור קוד הזמנה לשיתוף משתמש תת״ח"
                      : "Create Invite Code to Share AAC User"}
                  </h4>

                  <Form {...createInviteForm}>
                    <form
                      onSubmit={createInviteForm.handleSubmit(
                        handleCreateInviteCode,
                      )}
                      className="space-y-4"
                    >
                      <FormField
                        control={createInviteForm.control}
                        name="studentId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {language === "he"
                                ? "בחר משתמש תת״ח לשיתוף"
                                : "Select AAC User to Share"}
                            </FormLabel>
                            <Select
                              onValueChange={field.onChange}
                              value={field.value}
                              disabled={
                                studentsLoading ||
                                createInviteCodeMutation.isPending
                              }
                            >
                              <FormControl>
                                <SelectTrigger data-testid="select-student-for-invite">
                                  <SelectValue
                                    placeholder={
                                      language === "he"
                                        ? "בחר משתמש תת״ח"
                                        : "Select AAC user"
                                    }
                                  />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {studentsLoading ? (
                                  <SelectItem value="loading" disabled>
                                    {t("ui.loading")}
                                  </SelectItem>
                                ) : studentsData?.students?.length > 0 ? (
                                  studentsData.students
                                    .filter(
                                      (student: any) =>
                                        student.studentId &&
                                        String(student.studentId).trim() !== "",
                                    )
                                    .map((student: any) => (
                                      <SelectItem
                                        key={student.studentId}
                                        value={String(student.studentId)}
                                      >
                                        {student.alias}
                                        {student.age && ` (${student.age})`}
                                        {student.gender &&
                                          ` - ${student.gender}`}
                                      </SelectItem>
                                    ))
                                ) : (
                                  <SelectItem value="no-users" disabled>
                                    {t("ui.noStudents")}
                                  </SelectItem>
                                )}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <Button
                        type="submit"
                        disabled={
                          createInviteCodeMutation.isPending ||
                          studentsLoading ||
                          !createInviteForm.watch("studentId")
                        }
                        className="flex items-center gap-2"
                        data-testid="button-create-invite-code"
                      >
                        {createInviteCodeMutation.isPending ? (
                          <>
                            <div
                              className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"
                              data-testid="spinner-create-invite"
                            ></div>
                            {t("ui.creating")}
                          </>
                        ) : (
                          <>
                            <Share2 className="w-4 h-4" />
                            {t("ui.createInviteCode")}
                          </>
                        )}
                      </Button>
                    </form>
                  </Form>
                </div>

                {/* Redeem Invite Code Section */}
                <div className="bg-muted/50 p-4 rounded-lg">
                  <h4 className="text-sm font-medium mb-3">
                    {t("ui.redeemInviteCode")}
                  </h4>

                  <Form {...redeemInviteForm}>
                    <form
                      onSubmit={redeemInviteForm.handleSubmit(
                        handleRedeemInviteCode,
                      )}
                      className="space-y-4"
                    >
                      <FormField
                        control={redeemInviteForm.control}
                        name="code"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("ui.enterInviteCode")}</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  {...field}
                                  onChange={(e) =>
                                    field.onChange(e.target.value.toUpperCase())
                                  }
                                  placeholder={t("ui.inviteCodePlaceholder")}
                                  maxLength={8}
                                  className={`font-mono ${isRTL ? "text-right" : "text-left"}`}
                                  data-testid="input-redeem-invite-code"
                                  disabled={redeemInviteCodeMutation.isPending}
                                />
                                <div
                                  className={`absolute top-1/2 transform -translate-y-1/2 text-xs text-muted-foreground ${isRTL ? "left-3" : "right-3"}`}
                                >
                                  <span data-testid="character-counter">
                                    {field.value?.length || 0}/8
                                  </span>
                                </div>
                              </div>
                            </FormControl>
                            <FormDescription>
                              {t("ui.inviteCodeError")}
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <Button
                        type="submit"
                        disabled={
                          redeemInviteCodeMutation.isPending ||
                          !redeemInviteForm.watch("code")?.trim()
                        }
                        className="flex items-center gap-2"
                        data-testid="button-redeem-invite-code"
                      >
                        {redeemInviteCodeMutation.isPending ? (
                          <>
                            <div
                              className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"
                              data-testid="spinner-redeem-invite"
                            ></div>
                            {t("ui.redeeming")}
                          </>
                        ) : (
                          <>
                            <Plus className="w-4 h-4" />
                            {t("ui.redeemCode")}
                          </>
                        )}
                      </Button>
                    </form>
                  </Form>
                </div>

                {/* Referral Code Section */}
                <div className="bg-muted/50 p-4 rounded-lg">
                  <h4 className="text-sm font-medium mb-3">
                    {language === "he" ? "קוד ההפניה שלך" : "Your Referral Code"}
                  </h4>
                  <p className="text-xs text-muted-foreground mb-3">
                    {language === "he"
                      ? "שתף את קוד ההפניה שלך עם חברים. כשהם נרשמים באמצעות הקוד, שניכם תקבלו בונוס קרדיטים!"
                      : "Share your referral code with friends. When they sign up using your code, you'll both receive bonus credits!"}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm font-mono bg-background px-3 py-2 rounded border select-all text-center font-bold tracking-wide">
                      {user?.referralCode || ""}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (user?.referralCode) {
                          navigator.clipboard.writeText(user.referralCode);
                          toast({
                            title: language === "he" ? "הועתק!" : "Copied!",
                            description:
                              language === "he"
                                ? "קוד ההפניה הועתק ללוח"
                                : "Referral code copied to clipboard",
                          });
                        }
                      }}
                      className="flex items-center gap-2"
                      data-testid="button-copy-referral-code"
                    >
                      <Copy className="w-4 h-4" />
                      {language === "he" ? "העתק" : "Copy"}
                    </Button>
                  </div>
                </div>

                {/* Active Invite Codes Section */}
                <div className="bg-muted/50 p-4 rounded-lg">
                  <div
                    className={`flex items-center justify-between mb-3 ${language === "he" ? "flex-row-reverse" : ""}`}
                  >
                    <h4 className="text-sm font-medium">
                      {t("ui.myInviteCodes")}
                    </h4>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setShowActiveInviteCodes(!showActiveInviteCodes)
                      }
                      className="flex items-center gap-1 text-xs"
                      data-testid="button-toggle-invite-codes"
                    >
                      <ChevronUp
                        className={`w-3 h-3 transition-transform ${showActiveInviteCodes ? "rotate-180" : ""}`}
                      />
                      {t("ui.showHide")}
                    </Button>
                  </div>

                  {showActiveInviteCodes && (
                    <div className="space-y-2">
                      {inviteCodesLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary"></div>
                        </div>
                      ) : inviteCodesData?.inviteCodes?.length > 0 ? (
                        inviteCodesData.inviteCodes
                          .filter((code: any) => code.isActive)
                          .map((inviteCode: any) => (
                            <div
                              key={inviteCode.id}
                              className="border border-border rounded-lg p-3 flex justify-between items-center"
                              data-testid={`invite-code-item-${inviteCode.id}`}
                            >
                              <div className="space-y-1">
                                <div
                                  className={`flex items-center gap-2 ${language === "he" ? "flex-row-reverse" : ""}`}
                                >
                                  <code
                                    className="text-sm font-mono bg-background px-2 py-1 rounded border select-all"
                                    data-testid={`invite-code-display-${inviteCode.id}`}
                                  >
                                    {inviteCode.code}
                                  </code>
                                  <span
                                    className="text-sm font-medium"
                                    data-testid={`invite-code-alias-${inviteCode.id}`}
                                  >
                                    {inviteCode.studentAlias}
                                  </span>
                                </div>
                                <div
                                  className="text-xs text-muted-foreground"
                                  data-testid={`invite-code-meta-${inviteCode.id}`}
                                >
                                  {t("ui.created")}:{" "}
                                  {new Date(
                                    inviteCode.createdAt,
                                  ).toLocaleDateString(
                                    language === "he" ? "he-IL" : "en-US",
                                  )}
                                  {inviteCode.timesRedeemed > 0 && (
                                    <>
                                      {" • "}
                                      {t("ui.redeemed")}:{" "}
                                      {inviteCode.timesRedeemed}
                                      {inviteCode.redemptionLimit > 1 &&
                                        `/${inviteCode.redemptionLimit}`}
                                    </>
                                  )}
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    handleCopyInviteCode(inviteCode.code)
                                  }
                                  className="p-2"
                                  data-testid={`button-copy-invite-${inviteCode.id}`}
                                  title={t("ui.copyInviteCode")}
                                >
                                  <Copy className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() =>
                                    deleteInviteCodeMutation.mutate(
                                      inviteCode.id,
                                    )
                                  }
                                  disabled={deleteInviteCodeMutation.isPending}
                                  className="p-2"
                                  data-testid={`button-delete-invite-${inviteCode.id}`}
                                  title={t("ui.deleteInviteCode")}
                                >
                                  {deleteInviteCodeMutation.isPending ? (
                                    <div
                                      className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"
                                      data-testid={`spinner-delete-invite-${inviteCode.id}`}
                                    ></div>
                                  ) : (
                                    <Trash2 className="w-4 h-4" />
                                  )}
                                </Button>
                              </div>
                            </div>
                          ))
                      ) : (
                        <div
                          className="text-center py-4 text-muted-foreground text-sm"
                          data-testid="no-invite-codes-message"
                        >
                          <p>{t("ui.noInviteCodes")}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSettingsDialog(false)}
            >
              {t("ui.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );

}
