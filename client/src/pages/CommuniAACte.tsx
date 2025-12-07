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

export default function CommuniAACte() {
  const [inputMethod, setInputMethod] = useState<"text" | "image">("text");
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
    selectedAacUserId: "" as string, // Mandatory AAC user selection
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

  const [aacUserForm, setAacUserForm] = useState({
    alias: "",
    gender: "",
    age: "",
    disabilityOrSyndrome: "",
  });
  const [editingAacUser, setEditingAacUser] = useState<any>(null);
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
  const [scheduleAacUser, setScheduleAacUser] = useState<{
    aacUserId: string;
    alias: string;
  } | null>(null);

  // Invite code forms
  const createInviteForm = useForm<InsertInviteCode>({
    resolver: zodResolver(insertInviteCodeSchema),
    defaultValues: {
      aacUserId: undefined,
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
  const { theme, toggleTheme } = useTheme();
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
  const { data: aacUsersData, isLoading: aacUsersLoading } = useQuery({
    queryKey: ["/api/aac-users"],
    queryFn: async () => {
      const res = await fetch("/api/aac-users");
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
      const res = await fetch("/api/invite-codes");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  // Fetch user's saved locations
  const { data: savedLocationsData, isLoading: savedLocationsLoading } =
    useQuery({
      queryKey: ["/api/saved-locations"],
      queryFn: async () => {
        const res = await fetch("/api/saved-locations");
        return res.json();
      },
      enabled: isAuthenticated,
    });

  // Function to fetch historical suggestions
  const fetchHistoricalSuggestions = async (
    aacUserId: string,
    currentInput: string,
  ) => {
    if (!aacUserId || !currentInput.trim() || currentInput.length < 2) {
      setHistoricalSuggestions([]);
      setShowHistoricalSuggestions(false);
      return;
    }

    setLoadingHistoricalSuggestions(true);
    try {
      const res = await apiRequest("POST", "/api/historical-suggestions", {
        aacUserId,
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
      if (contextInfo.selectedAacUserId && inputText.trim().length >= 2) {
        fetchHistoricalSuggestions(contextInfo.selectedAacUserId, inputText);
      } else {
        setHistoricalSuggestions([]);
        setShowHistoricalSuggestions(false);
      }
    }, 500); // 500ms debounce

    return () => clearTimeout(timeoutId);
  }, [inputText, contextInfo.selectedAacUserId]);

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
      if (context.aacUserId) {
        formData.append("aacUserId", context.aacUserId);
      }
      if (context.aacUserAlias) {
        formData.append("aacUserAlias", context.aacUserAlias);
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

      const res = await fetch("/api/interpret", {
        method: "POST",
        body: formData,
      });

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
  const createAacUserMutation = useMutation({
    mutationFn: async (aacUserData: any) => {
      const res = await apiRequest("POST", "/api/aac-users", aacUserData);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/aac-users"] });
      setAacUserForm({
        alias: "",
        gender: "",
        age: "",
        disabilityOrSyndrome: "",
      });
      toast({
        title: t("toast.aacUserCreated"),
        description: t("toast.aacUserCreatedDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.aacUserCreateFailed"),
        description: error.message || t("toast.aacUserCreateFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Update AAC user mutation
  const updateAacUserMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await apiRequest("PATCH", `/api/aac-users/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/aac-users"] });
      setEditingAacUser(null);
      setAacUserForm({
        alias: "",
        gender: "",
        age: "",
        disabilityOrSyndrome: "",
      });
      toast({
        title: t("toast.aacUserUpdated"),
        description: t("toast.aacUserUpdatedDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.aacUserUpdateFailed"),
        description: error.message || t("toast.aacUserUpdateFailedDesc"),
        variant: "destructive",
      });
    },
  });

  // Delete AAC user mutation
  const deleteAacUserMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/aac-users/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/aac-users"] });
      toast({
        title: t("toast.aacUserDeleted"),
        description: t("toast.aacUserDeletedDesc"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.aacUserDeleteFailed"),
        description: error.message || t("toast.aacUserDeleteFailedDesc"),
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
      const res = await fetch("/api/profile/upload-image", {
        method: "POST",
        body: formData,
        credentials: "include",
        headers: {
          // Don't set Content-Type for FormData - let browser set it with boundary
        },
      });

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
      queryClient.invalidateQueries({ queryKey: ["/api/aac-users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invite-codes"] });
      redeemInviteForm.reset();
      toast({
        title: t("toast.inviteRedeemed"),
        description: `${t("label.aacUser")} "${data.aacUserAlias}" ${language === "he" ? "נוסף בהצלחה" : "has been added successfully"}`,
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
      !contextInfo.selectedAacUserId ||
      contextInfo.selectedAacUserId.trim() === ""
    ) {
      toast({
        variant: "destructive",
        title: t("error.title"),
        description: t("error.selectAacUser"),
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
    const selectedAacUser = aacUsersData?.aacUsers?.find(
      (user: any) =>
        String(user.aacUserId) === String(finalContext.selectedAacUserId),
    );

    // Create context string to append to interpretation
    const aacUserContext = selectedAacUser
      ? [
          `${t("label.aacUser")}: ${selectedAacUser.alias}`,
          selectedAacUser.age && `${t("label.age")}: ${selectedAacUser.age}`,
          selectedAacUser.gender &&
            `${t("label.gender")}: ${selectedAacUser.gender}`,
          selectedAacUser.disabilityOrSyndrome &&
            `${t("label.condition")}: ${selectedAacUser.disabilityOrSyndrome}`,
          selectedAacUser.backgroundContext &&
            `${t("label.backgroundContext")}: ${selectedAacUser.backgroundContext}`,
        ]
          .filter(Boolean)
          .join(", ")
      : "";

    const contextString = [
      aacUserContext,
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
        aacUserId: selectedAacUser?.aacUserId || null,
        aacUserAlias: selectedAacUser?.alias || null,
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
        aacUserId: selectedAacUser?.aacUserId || null,
        aacUserAlias: selectedAacUser?.alias || null,
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
      selectedAacUserId: "",
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
  const handleCreateAacUser = () => {
    if (!aacUserForm.alias.trim()) {
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
    createAacUserMutation.mutate(aacUserForm);
  };

  const handleEditAacUser = (aacUser: any) => {
    setEditingAacUser(aacUser);
    setAacUserForm({
      alias: aacUser.alias || "",
      gender: aacUser.gender || "",
      age: aacUser.age || "",
      disabilityOrSyndrome: aacUser.disabilityOrSyndrome || "",
    });
  };

  const handleUpdateAacUser = () => {
    if (!aacUserForm.alias.trim()) {
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
    updateAacUserMutation.mutate({ id: editingAacUser.id, data: aacUserForm });
  };

  const handleCancelEdit = () => {
    setEditingAacUser(null);
    setAacUserForm({
      alias: "",
      gender: "",
      age: "",
      disabilityOrSyndrome: "",
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
      const response = await fetch("/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: registerData.email,
          firstName: registerData.firstName,
          lastName: registerData.lastName,
          password: registerData.password,
          userType: registerData.userType,
        }),
      });

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

  return (
    <div dir={isRTL ? "rtl" : "ltr"} className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-surface shadow-sm border-b border-border sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-3 sm:py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center justify-center flex-shrink-0">
              <img
                src={appLogo}
                alt="CommuniAACte"
                className="h-8 w-auto"
              />
            </div>
            <div className="flex items-center gap-1 sm:gap-3 flex-shrink-0">
              {isAuthenticated && user && (
                <>
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <img src={creditIcon} alt="Credits" className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    <span className="font-medium text-foreground text-[10px] sm:text-xs">
                      {user.credits}
                    </span>
                  </div>
                  {(user.userType === "admin" || user.isAdmin) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAdminAccess}
                      className="text-xs px-1.5 py-0.5 sm:px-2 sm:py-1 bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100"
                      data-testid="button-admin"
                      aria-label={
                        language === "he"
                          ? "כניסה למערכת ניהול"
                          : "Access admin panel"
                      }
                    >
                      <Shield className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      <span className="hidden sm:inline ml-1">
                        {language === "he" ? "ניהול" : "Admin"}
                      </span>
                    </Button>
                  )}
                  <div className="flex items-center gap-0.5 sm:gap-1">
                    {user.profileImageUrl && (
                      <img
                        src={user.profileImageUrl}
                        alt={user.fullName}
                        className="w-6 h-6 sm:w-7 sm:h-7 rounded-full"
                      />
                    )}
                    <span className="text-[10px] sm:text-sm font-medium text-foreground truncate max-w-12 sm:max-w-32 hidden min-[360px]:inline">
                      {user.firstName}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSettingsDialog(true)}
                      className="text-xs px-0.5 py-0.5 sm:px-1 sm:py-1"
                      data-testid="button-settings"
                      aria-label={
                        language === "he" ? "הגדרות משתמש" : "User Settings"
                      }
                    >
                      <Settings className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={logout}
                      className="p-1.5"
                      title={t("auth.logout")}
                      data-testid="button-logout"
                    >
                      <LogOut className="w-4 h-4" />
                    </Button>
                  </div>
                </>
              )}
              {!isAuthenticated && !authLoading && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowLoginDialog(true)}
                  className="p-1.5"
                  title={t("auth.login")}
                  data-testid="button-login"
                >
                  <LogIn className="w-4 h-4" />
                </Button>
              )}
              <LanguageSelector />
            </div>
          </div>
        </div>
      </header>

      {/* App Title and Subtitle */}
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 text-center">
        <h1 className="text-lg sm:text-xl font-medium text-foreground">
          {t("app.title")}
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground">
          {t("app.subtitle")}
        </p>
      </div>

      <main className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
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

        {/* Results Section */}
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

        {/* History Section - Only show for authenticated users */}
        {isAuthenticated && user && (
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
                  className={`flex items-center gap-2 ${isRTL ? "flex-row-reverse justify-end ml-auto" : ""}`}
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
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                  </div>
                ) : historyData?.interpretations?.length > 0 ? (
                  <div className="space-y-3">
                    {historyData.interpretations.map(
                      (interpretation: Interpretation) => (
                        <div
                          key={interpretation.id}
                          className="border border-border rounded-lg p-3 hover:bg-muted transition-colors cursor-pointer"
                          onClick={() =>
                            handleSelectHistoryItem(interpretation)
                          }
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
        )}
      </main>

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
                  {selectedImageInterpretation.aacUserAlias && (
                    <span>
                      {language === "he" ? "עבור" : "For"}:{" "}
                      {selectedImageInterpretation.aacUserAlias}
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

      {/* Footer */}
      <footer className="bg-surface border-t border-border mt-8 sm:mt-12">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-2 sm:gap-4">
            <div className="text-xs sm:text-sm text-muted-foreground text-center sm:text-left">
              <p>
                {language === "he"
                  ? "מיועד למטפלים, מטפלות, הורים ומשפחות התומכים במשתמשי תת״ח"
                  : "Designed for caregivers, therapists, and families supporting AAC users"}
              </p>
            </div>
            <div className="flex gap-4 text-sm">
              <button
                onClick={() => setShowPrivacyDialog(true)}
                className="text-muted-foreground hover:text-primary transition-colors"
                data-testid="button-privacy-policy"
              >
                {language === "he" ? "מדיניות פרטיות" : "Privacy Policy"}
              </button>
              <button
                onClick={() => setShowTermsDialog(true)}
                className="text-muted-foreground hover:text-primary transition-colors"
                data-testid="button-terms-of-service"
              >
                {language === "he" ? "תקנון שימוש" : "Terms of Service"}
              </button>
              <a
                href="mailto:support@xahaph.com"
                className="text-muted-foreground hover:text-primary transition-colors"
              >
                {language === "he" ? "תמיכה" : "Support"}
              </a>
              <button
                onClick={() => setShowAboutDialog(true)}
                className="text-muted-foreground hover:text-primary transition-colors"
                data-testid="button-about"
              >
                {language === "he" ? "אודות" : "About"}
              </button>
            </div>
          </div>
          <div className="text-center mt-4 pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground">
              {language === "he"
                ? "כל הזכויות שמורות 2025"
                : "All rights reserved 2025"}
            </p>
          </div>
        </div>
      </footer>

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
                htmlFor="aacUser"
                className="flex items-center gap-2 font-semibold text-orange-800"
              >
                <User className="h-4 w-4" />
                {language === "he"
                  ? 'בחר משתמש תת"ח (חובה)'
                  : "Select AAC User (Required)"}
                <span className="text-red-500">*</span>
              </Label>
              <Select
                value={contextInfo.selectedAacUserId}
                onValueChange={(value) =>
                  setContextInfo((prev) => ({
                    ...prev,
                    selectedAacUserId: value,
                  }))
                }
                required
              >
                <SelectTrigger
                  data-testid="select-aac-user"
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
                  {aacUsersLoading ? (
                    <SelectItem value="loading" disabled>
                      {language === "he" ? "טוען..." : "Loading..."}
                    </SelectItem>
                  ) : aacUsersData?.aacUsers?.length > 0 ? (
                    aacUsersData.aacUsers
                      .filter(
                        (aacUser: any) =>
                          aacUser.aacUserId &&
                          String(aacUser.aacUserId).trim() !== "",
                      )
                      .map((aacUser: any) => (
                        <SelectItem
                          key={aacUser.aacUserId}
                          value={String(aacUser.aacUserId)}
                        >
                          <div className="flex flex-col">
                            <span className="font-medium">{aacUser.alias}</span>
                            <span className="text-xs text-muted-foreground">
                              {[
                                aacUser.age &&
                                  `${language === "he" ? "גיל" : "Age"}: ${aacUser.age}`,
                                aacUser.gender &&
                                  `${language === "he" ? "מגדר" : "Gender"}: ${aacUser.gender}`,
                                aacUser.disabilityOrSyndrome &&
                                  `${language === "he" ? "אבחנה" : "Condition"}: ${aacUser.disabilityOrSyndrome}`,
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
              {!contextInfo.selectedAacUserId && (
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

      {/* Login Dialog */}
      <Dialog open={showLoginDialog} onOpenChange={setShowLoginDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="w-full text-center">
              {t("auth.loginTitle")}
            </DialogTitle>
            <DialogDescription className="w-full text-center">
              {language === "he"
                ? "הכניסו את פרטי ההתחברות"
                : "Enter your login credentials"}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleEmailLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("auth.email")}</Label>
              <Input
                id="email"
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder={t("auth.emailPlaceholder")}
                required
                disabled={isLoggingIn}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t("auth.password")}</Label>
              <Input
                id="password"
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder={t("auth.passwordPlaceholder")}
                required
                disabled={isLoggingIn}
              />
            </div>

            <Button type="submit" className="w-full" disabled={isLoggingIn}>
              {isLoggingIn ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  {t("auth.loggingIn")}
                </>
              ) : (
                t("auth.loginWithEmail")
              )}
            </Button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                {t("auth.or")}
              </span>
            </div>
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => (window.location.href = "/auth/google")}
            type="button"
            data-testid="button-google-login"
          >
            <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="currentColor"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="currentColor"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="currentColor"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            {t("auth.googleLogin")}
          </Button>

          {/* Account creation and password recovery links */}
          <div className="space-y-3 text-center text-sm">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                setShowLoginDialog(false);
                setShowRegisterDialog(true);
              }}
            >
              {t("auth.noAccount")}
            </button>

            <button
              type="button"
              className="text-muted-foreground hover:text-primary hover:underline block w-full"
              onClick={() => {
                // TODO: Implement password recovery functionality
                alert(t("auth.forgotPassword"));
              }}
            >
              {t("auth.forgotPassword")}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Registration Dialog */}
      <Dialog open={showRegisterDialog} onOpenChange={setShowRegisterDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="w-full text-center">
              {t("auth.registerTitle")}
            </DialogTitle>
            <DialogDescription className="w-full text-center">
              {language === "he"
                ? "צור חשבון חדש כדי להתחיל להשתמש במערכת"
                : "Create a new account to start using the system"}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleRegister} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">{t("auth.firstName")}</Label>
                <Input
                  id="firstName"
                  type="text"
                  value={registerData.firstName}
                  onChange={(e) =>
                    setRegisterData((prev) => ({
                      ...prev,
                      firstName: e.target.value,
                    }))
                  }
                  placeholder={t("auth.firstNamePlaceholder")}
                  required
                  disabled={isRegistering}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="lastName">{t("auth.lastName")}</Label>
                <Input
                  id="lastName"
                  type="text"
                  value={registerData.lastName}
                  onChange={(e) =>
                    setRegisterData((prev) => ({
                      ...prev,
                      lastName: e.target.value,
                    }))
                  }
                  placeholder={t("auth.lastNamePlaceholder")}
                  required
                  disabled={isRegistering}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="registerEmail">{t("auth.email")}</Label>
              <Input
                id="registerEmail"
                type="email"
                value={registerData.email}
                onChange={(e) =>
                  setRegisterData((prev) => ({
                    ...prev,
                    email: e.target.value,
                  }))
                }
                placeholder={t("auth.emailPlaceholder")}
                required
                disabled={isRegistering}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="registerPassword">{t("auth.password")}</Label>
              <Input
                id="registerPassword"
                type="password"
                value={registerData.password}
                onChange={(e) =>
                  setRegisterData((prev) => ({
                    ...prev,
                    password: e.target.value,
                  }))
                }
                placeholder={t("auth.passwordPlaceholder")}
                required
                disabled={isRegistering}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">
                {t("auth.confirmPassword")}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                value={registerData.confirmPassword}
                onChange={(e) =>
                  setRegisterData((prev) => ({
                    ...prev,
                    confirmPassword: e.target.value,
                  }))
                }
                placeholder={t("auth.confirmPasswordPlaceholder")}
                required
                disabled={isRegistering}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="userType">
                {language === "he" ? "סוג משתמש" : "User Type"}
              </Label>
              <Select
                value={registerData.userType}
                onValueChange={(value) =>
                  setRegisterData((prev) => ({
                    ...prev,
                    userType: value as typeof registerData.userType,
                  }))
                }
                disabled={isRegistering}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      language === "he" ? "בחר סוג משתמש" : "Select user type"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Caregiver">
                    {language === "he" ? "מטפל/ת" : "Caregiver"}
                  </SelectItem>
                  <SelectItem value="Parent">
                    {language === "he" ? "הורה" : "Parent"}
                  </SelectItem>
                  <SelectItem value="Teacher">
                    {language === "he" ? "מורה" : "Teacher"}
                  </SelectItem>
                  <SelectItem value="SLP">
                    {language === "he" ? "קלינאי תקשורת" : "SLP"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button type="submit" className="w-full" disabled={isRegistering}>
              {isRegistering ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  {t("auth.registering")}
                </>
              ) : (
                t("auth.registerButton")
              )}
            </Button>
          </form>

          {/* Back to login link */}
          <div className="text-center text-sm">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                setShowRegisterDialog(false);
                setShowLoginDialog(true);
              }}
            >
              {t("auth.backToLogin")}
            </button>
          </div>
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

                {/* Theme Toggle Section */}
                <div className="mt-6 pt-6 border-t border-border">
                  <h4 className="text-sm font-medium mb-3">
                    {language === "he" ? "ערכת נושא" : "Theme"}
                  </h4>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {language === "he" 
                        ? theme === "dark" ? "מצב כהה" : "מצב בהיר"
                        : theme === "dark" ? "Dark Mode" : "Light Mode"}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleTheme}
                      className="flex items-center gap-2"
                      data-testid="button-toggle-theme"
                    >
                      {theme === "dark" ? (
                        <>
                          <Sun className="w-4 h-4" />
                          {language === "he" ? "בהיר" : "Light"}
                        </>
                      ) : (
                        <>
                          <Moon className="w-4 h-4" />
                          {language === "he" ? "כהה" : "Dark"}
                        </>
                      )}
                    </Button>
                  </div>
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
                  {editingAacUser
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
                      value={aacUserForm.alias}
                      onChange={(e) =>
                        setAacUserForm((prev) => ({
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
                      value={aacUserForm.gender}
                      onValueChange={(value) =>
                        setAacUserForm((prev) => ({ ...prev, gender: value }))
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
                      value={aacUserForm.age}
                      onChange={(e) =>
                        setAacUserForm((prev) => ({
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
                      value={aacUserForm.disabilityOrSyndrome}
                      onChange={(e) =>
                        setAacUserForm((prev) => ({
                          ...prev,
                          disabilityOrSyndrome: e.target.value,
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
                      editingAacUser ? handleUpdateAacUser : handleCreateAacUser
                    }
                    disabled={
                      createAacUserMutation.isPending ||
                      updateAacUserMutation.isPending
                    }
                    className="flex items-center gap-2"
                  >
                    {editingAacUser ? (
                      <Edit className="w-4 h-4" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                    {editingAacUser
                      ? language === "he"
                        ? "עדכן"
                        : "Update"
                      : language === "he"
                        ? "הוסף"
                        : "Add"}
                  </Button>
                  {editingAacUser && (
                    <Button variant="outline" onClick={handleCancelEdit}>
                      {language === "he" ? "בטל" : "Cancel"}
                    </Button>
                  )}
                </div>
              </div>

              {/* Existing AAC Users List */}
              <div className="space-y-2">
                {aacUsersLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                  </div>
                ) : aacUsersData?.aacUsers?.length > 0 ? (
                  aacUsersData.aacUsers.map((aacUser: any) => (
                    <div
                      key={aacUser.id}
                      className="border border-border rounded-lg p-3 flex justify-between items-start"
                    >
                      <div className="space-y-1">
                        <h4 className="font-medium">{aacUser.alias}</h4>
                        <div className="text-sm text-muted-foreground space-y-1">
                          {aacUser.gender && (
                            <p>
                              {language === "he" ? "מגדר" : "Gender"}:{" "}
                              {aacUser.gender}
                            </p>
                          )}
                          {aacUser.age && (
                            <p>
                              {language === "he" ? "גיל" : "Age"}: {aacUser.age}
                            </p>
                          )}
                          {aacUser.disabilityOrSyndrome && (
                            <p>
                              {language === "he" ? "אבחנה" : "Condition"}:{" "}
                              {aacUser.disabilityOrSyndrome}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setScheduleAacUser({
                              aacUserId: aacUser.aacUserId,
                              alias: aacUser.alias,
                            });
                            setScheduleManagerOpen(true);
                          }}
                          className="p-2"
                          title={
                            language === "he"
                              ? "נהל לוח זמנים"
                              : "Manage Schedule"
                          }
                          data-testid={`button-manage-schedule-${aacUser.id}`}
                        >
                          <Calendar className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditAacUser(aacUser)}
                          className="p-2"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() =>
                            deleteAacUserMutation.mutate(aacUser.id)
                          }
                          disabled={deleteAacUserMutation.isPending}
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
                        name="aacUserId"
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
                                aacUsersLoading ||
                                createInviteCodeMutation.isPending
                              }
                            >
                              <FormControl>
                                <SelectTrigger data-testid="select-aac-user-for-invite">
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
                                {aacUsersLoading ? (
                                  <SelectItem value="loading" disabled>
                                    {t("ui.loading")}
                                  </SelectItem>
                                ) : aacUsersData?.aacUsers?.length > 0 ? (
                                  aacUsersData.aacUsers
                                    .filter(
                                      (aacUser: any) =>
                                        aacUser.aacUserId &&
                                        String(aacUser.aacUserId).trim() !== "",
                                    )
                                    .map((aacUser: any) => (
                                      <SelectItem
                                        key={aacUser.aacUserId}
                                        value={String(aacUser.aacUserId)}
                                      >
                                        {aacUser.alias}
                                        {aacUser.age && ` (${aacUser.age})`}
                                        {aacUser.gender &&
                                          ` - ${aacUser.gender}`}
                                      </SelectItem>
                                    ))
                                ) : (
                                  <SelectItem value="no-users" disabled>
                                    {t("ui.noAacUsers")}
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
                          aacUsersLoading ||
                          !createInviteForm.watch("aacUserId")
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
                                    {inviteCode.aacUserAlias}
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

      {/* Privacy Policy Dialog */}
      <Dialog open={showPrivacyDialog} onOpenChange={setShowPrivacyDialog}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader
            className={language === "he" ? "text-right" : "text-left"}
          >
            <DialogTitle
              className={`flex items-center gap-3 ${language === "he" ? "justify-end flex-row-reverse" : "justify-start"}`}
            >
              <Shield className="w-6 h-6" />
              {language === "he" ? "מדיניות פרטיות" : "Privacy Policy"}
            </DialogTitle>
            <DialogDescription
              className={`mt-2 ${language === "he" ? "text-right" : "text-left"}`}
            >
              {language === "he"
                ? "מדיניות הפרטיות של CommuniAACte ואופן השימוש במידע שלכם"
                : "CommuniAACte Privacy Policy and how we use your information"}
            </DialogDescription>
          </DialogHeader>

          <div
            className={`space-y-6 text-sm leading-relaxed ${language === "he" ? "text-right" : "text-left"}`}
          >
            {language === "he" ? (
              <>
                <div>
                  <h3 className="font-semibold text-lg mb-3">כללי</h3>
                  <p className="text-muted-foreground">
                    אנו ב-CommuniAACte מחויבים לשמירה על פרטיות המשתמשים שלנו.
                    מדיניות פרטיות זו מסבירה כיצד אנו אוספים, משתמשים ומגנים על
                    המידע האישי שלכם כאשר אתם משתמשים בפלטפורמה שלנו.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">איסוף מידע</h3>
                  <div className="space-y-2 text-muted-foreground">
                    <p>
                      <strong>מידע אישי:</strong> אנו אוספים מידע כגון שם, כתובת
                      אימייל וסוג משתמש בעת יצירת חשבון.
                    </p>
                    <p>
                      <strong>מידע תקשורת:</strong> טקסטים ותמונות שאתם מעלים
                      לניתוח, כולל הקשר שמסופק על ידיכם.
                    </p>
                    <p>
                      <strong>פרופילי משתמשי תת״ח:</strong> מידע על משתמשי
                      התקשורת התומכת החלופית שאתם מנהלים.
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">שימוש במידע</h3>
                  <div className="space-y-2 text-muted-foreground">
                    <p>אנו משתמשים במידע שאתם מספקים כדי:</p>
                    <ul className="list-disc list-inside mr-4 space-y-1">
                      <li>לספק שירותי ניתוח תקשורת מותאמים אישית</li>
                      <li>לשמור היסטוריה של פירושים קודמים</li>
                      <li>לשפר את דיוק האלגוריתמים שלנו</li>
                      <li>לספק תמיכה טכנית</li>
                      <li>לשלוח הודעות חd�ובות לגבי השירות</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">שיתוף מידע</h3>
                  <p className="text-muted-foreground">
                    אנו לא משתפים, מוכרים או מעבירים את המידע האישי שלכם לצדדים
                    שלישיים, למעט במקרים הבאים: כאשר נדרש על פי חוק, כדי להגן על
                    הזכויות והבטיחות שלנו או של אחרים, או עם הסכמתכם המפורשת.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">אבטחת מידע</h3>
                  <p className="text-muted-foreground">
                    אנו מיישמים אמצעי אבטחה מתקדמים כדי להגן על המידע שלכם, כולל
                    הצפנה, גישה מוגבלת לנתונים ומערכות גיבוי מאובטחות. עם זאת,
                    אף שיטת אבטחה אינה בטוחה ב-100%.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">זכויותיכם</h3>
                  <div className="space-y-2 text-muted-foreground">
                    <p>יש לכם הזכות:</p>
                    <ul className="list-disc list-inside mr-4 space-y-1">
                      <li>לעיין במידע האישי שלכם</li>
                      <li>לבקש תיקון מידע שגוי</li>
                      <li>לבקש מחיקת החשבון והמידע שלכם</li>
                      <li>לייצא את המידע שלכם</li>
                      <li>להגביל עיבוד מידע מסוים</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">עדכוני מדיניות</h3>
                  <p className="text-muted-foreground">
                    אנו עשויים לעדכן מדיניות פרטיות זו מעת לעת. נודיע לכם על
                    שינויים מהותיים באמצעות אימייל או הודעה בפלטפורמה.
                  </p>
                </div>

                <div className="border-t pt-4">
                  <h3 className="font-semibold text-lg mb-3">יצירת קשר</h3>
                  <p className="text-muted-foreground">
                    לשאלות או הערות לגבי מדיניות הפרטיות, אנא פנו אלינו בכתובת:
                    <br />
                    <a
                      href="mailto:support@xahaph.com"
                      className="text-primary hover:underline"
                    >
                      support@xahaph.com
                    </a>
                  </p>
                </div>

                <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded">
                  <p>עדכון אחרון: ספטמבר 2025</p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <h3 className="font-semibold text-lg mb-3">Overview</h3>
                  <p className="text-muted-foreground">
                    At CommuniAACte, we are committed to protecting the privacy
                    of our users. This privacy policy explains how we collect,
                    use, and protect your personal information when you use our
                    platform.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    Information Collection
                  </h3>
                  <div className="space-y-2 text-muted-foreground">
                    <p>
                      <strong>Personal Information:</strong> We collect
                      information such as name, email address, and user type
                      when you create an account.
                    </p>
                    <p>
                      <strong>Communication Data:</strong> Text and images you
                      upload for analysis, including context you provide.
                    </p>
                    <p>
                      <strong>AAC User Profiles:</strong> Information about the
                      AAC users you manage.
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    Use of Information
                  </h3>
                  <div className="space-y-2 text-muted-foreground">
                    <p>We use the information you provide to:</p>
                    <ul className="list-disc list-inside ml-4 space-y-1">
                      <li>
                        Provide personalized communication analysis services
                      </li>
                      <li>Maintain history of previous interpretations</li>
                      <li>Improve the accuracy of our algorithms</li>
                      <li>Provide technical support</li>
                      <li>Send important service-related messages</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    Information Sharing
                  </h3>
                  <p className="text-muted-foreground">
                    We do not share, sell, or transfer your personal information
                    to third parties, except in the following cases: when
                    required by law, to protect our rights and safety or those
                    of others, or with your explicit consent.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">Data Security</h3>
                  <p className="text-muted-foreground">
                    We implement advanced security measures to protect your
                    information, including encryption, restricted data access,
                    and secure backup systems. However, no security method is
                    100% secure.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">Your Rights</h3>
                  <div className="space-y-2 text-muted-foreground">
                    <p>You have the right to:</p>
                    <ul className="list-disc list-inside ml-4 space-y-1">
                      <li>Access your personal information</li>
                      <li>Request correction of incorrect information</li>
                      <li>Request deletion of your account and data</li>
                      <li>Export your data</li>
                      <li>Restrict processing of certain information</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">Policy Updates</h3>
                  <p className="text-muted-foreground">
                    We may update this privacy policy from time to time. We will
                    notify you of material changes via email or platform
                    notification.
                  </p>
                </div>

                <div className="border-t pt-4">
                  <h3 className="font-semibold text-lg mb-3">Contact</h3>
                  <p className="text-muted-foreground">
                    For questions or comments about this privacy policy, please
                    contact us at:
                    <br />
                    <a
                      href="mailto:support@xahaph.com"
                      className="text-primary hover:underline"
                    >
                      support@xahaph.com
                    </a>
                  </p>
                </div>

                <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded">
                  <p>Last updated: September 2025</p>
                </div>
              </>
            )}
          </div>

          <DialogFooter
            className={language === "he" ? "justify-start" : "justify-end"}
          >
            <Button
              variant="outline"
              onClick={() => setShowPrivacyDialog(false)}
            >
              {t("ui.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* About Dialog */}
      <Dialog open={showAboutDialog} onOpenChange={setShowAboutDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader
            className={language === "he" ? "text-right" : "text-left"}
          >
            <DialogTitle
              className={`flex items-center gap-3 ${language === "he" ? "justify-end flex-row-reverse" : "justify-start"}`}
            >
              <img
                src={appLogo}
                alt="CommuniAACte"
                className="w-8 h-8 object-contain"
              />
            </DialogTitle>
            <h3 className={`mt-2 font-semibold text-lg text-right`}>
              {language === "he"
                ? "למד עוד על המשימה והחזון שלנו"
                : "Learn more about our mission and vision"}
            </h3>
          </DialogHeader>

          <div
            className={`space-y-6 ${language === "he" ? "text-right" : "text-left"}`}
          >
            {language === "he" ? (
              <>
                <div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    CommuniAACte היא פלטפורמה שפותחה במטרה להעצים ולשפר את
                    התקשורת של משתמשי תקשורת תומכת חלופית (תת״ח). המערכת שלנו
                    מנתחת טקסט ותמונה ומספקת תובנות מיידיות על משמעות התקשורת,
                    כדי שתוכלו להבין טוב יותר את הצרכים והכוונות של המשתמשים.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">המשימה שלנו</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    המשימה של CommuniAACte היא לתמוך במטפלים, הורים ומשפחות של
                    משתמשי תת״ח. על ידי פירוש והנגשת מסרים מורכבים, אנו שואפים
                    לגשר על פערי התקשורת ולאפשר לכל אחד להביע את עצמו בצורה
                    ברורה ומובנת.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    מה אנחנו מציעים?
                  </h3>
                  <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
                    <p>
                      <strong>ניתוח מהיר ומדויק:</strong> העלו תמונה או טקסט
                      וקבלו ניתוח מפורט ומדויק בזמן אמת.
                    </p>
                    <p>
                      <strong>היסטוריית תקשורת:</strong> עקבו אחר פירושי העבר
                      כדי לזהות דפוסים וללמוד טוב יותר את דרכי התקשורת.
                    </p>
                    <p>
                      <strong>ניהול משתמשים:</strong> צרו פרופילים אישיים
                      למשתמשי תת״ח כדי להתאים את הניתוח לצרכים הספציפיים שלהם.
                    </p>
                  </div>
                </div>

                <div className="border-t pt-4">
                  <p className="text-sm text-muted-foreground leading-relaxed italic">
                    CommuniAACte היא לא רק כלי - היא שותפה לדרך שלכם. אנחנו כאן
                    כדי להפוך את העולם לקצת יותר מובן, מסר אחר מסר.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    CommuniAACte is a platform developed to empower and enhance
                    communication for users of Augmentative and Alternative
                    Communication (AAC). Our system analyzes text and images,
                    providing instant insights into communication meaning,
                    helping you better understand users' needs and intentions.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">Our Mission</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    CommuniAACte's mission is to support caregivers, parents,
                    and families of AAC users. By interpreting and making
                    complex messages accessible, we strive to bridge
                    communication gaps and enable everyone to express themselves
                    clearly and understandably.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">What We Offer</h3>
                  <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
                    <p>
                      <strong>Quick and Accurate Analysis:</strong> Upload an
                      image or text and receive detailed, accurate real-time
                      analysis.
                    </p>
                    <p>
                      <strong>Communication History:</strong> Track past
                      interpretations to identify patterns and better understand
                      communication methods.
                    </p>
                    <p>
                      <strong>User Management:</strong> Create personal profiles
                      for AAC users to tailor analysis to their specific needs.
                    </p>
                  </div>
                </div>

                <div className="border-t pt-4">
                  <p className="text-sm text-muted-foreground leading-relaxed italic">
                    CommuniAACte is not just a tool - it's your partner on the
                    journey. We're here to make the world a little more
                    understandable, one message at a time.
                  </p>
                </div>
              </>
            )}
          </div>

          <DialogFooter
            className={language === "he" ? "justify-start" : "justify-end"}
          >
            <Button variant="outline" onClick={() => setShowAboutDialog(false)}>
              {t("ui.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Terms of Service Dialog */}
      <Dialog open={showTermsDialog} onOpenChange={setShowTermsDialog}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader
            className={language === "he" ? "text-right" : "text-left"}
          >
            <DialogTitle
              className={`flex items-center gap-3 ${language === "he" ? "justify-end flex-row-reverse" : "justify-start"}`}
            >
              <Shield className="w-6 h-6" />
              {language === "he" ? "תקנון שימוש" : "Terms of Service"}
            </DialogTitle>
          </DialogHeader>

          <div
            className={`space-y-6 ${language === "he" ? "text-right" : "text-left"}`}
            dir={language === "he" ? "rtl" : "ltr"}
          >
            {language === "he" ? (
              <>
                <div className="text-sm text-muted-foreground">
                  עודכן לאחרונה בתאריך: 17.09.2025
                </div>

                <div className="space-y-4 text-sm leading-relaxed">
                  <p>
                    ברוך הבא לשירות של חברת Xahaph AI (להלן: "השירות"). השימוש
                    בשירות כפוף לתנאים המפורטים להלן. קרא בעיון את התנאים לפני
                    השימוש.
                  </p>

                  <div>
                    <h3 className="font-semibold text-lg mb-3">
                      1. הסכמה לתנאים
                    </h3>
                    <p>
                      בעת השימוש בשירות, אתה מאשר שקראת והבנת את תנאי השימוש וכי
                      השימוש בשירות מהווה הסכמה מלאה ומחייבת לתנאים אלה. אם אינך
                      מסכים לתנאים, אנא הימנע משימוש בשירות.
                    </p>
                  </div>

                  <div>
                    <h3 className="font-semibold text-lg mb-3">
                      2. שינויים בתנאי השימוש
                    </h3>
                    <p>
                      חברת Xahaph AI רשאית לעדכן או לשנות את תנאי השימוש מעת לעת
                      לפי שיקול דעתה הבלעדי. כל שינוי ייכנס לתוקף מיד עם פרסומו
                      בשירות, והשימוש בשירות לאחר שינוי כזה יהווה הסכמה לתנאים
                      המעודכנים.
                    </p>
                  </div>

                  <div>
                    <h3 className="font-semibold text-lg mb-3">
                      3. שימוש בשירות
                    </h3>
                    <div className="space-y-3">
                      <p>השימוש בשירות מותר למטרות חוקיות בלבד.</p>
                      <p>
                        המשתמש מתחייב לא לעשות שימוש בשירות לצרכים הפוגעים
                        בזכויות צדדים שלישיים, לרבות זכויות קניין רוחני, פרטיות,
                        סודיות או כל זכות אחרת.
                      </p>
                      <p>
                        חברת Xahaph AI רשאית להפסיק את הגישה לשירות למשתמשים
                        המפרים תנאים אלה.
                      </p>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold text-lg mb-3">
                      4. קניין רוחני
                    </h3>
                    <p>
                      כל הזכויות בשירות, לרבות תוכן, עיצוב, טקסט, קוד, סימנים
                      מסחריים, לוגואים, תמונות וסרטונים, שייכות לחברת Xahaph AI
                      או לצדדים שלישיים שנתנו לה רישיון להשתמש בהם. אין להעתיק,
                      לשכפל, להפיץ או לשדר כל חלק מהשירות ללא אישור בכתב ומראש
                      מחברת Xahaph AI.
                    </p>
                  </div>

                  <div>
                    <h3 className="font-semibold text-lg mb-3">
                      5. הגבלת אחריות
                    </h3>
                    <div className="space-y-3">
                      <p>
                        השירות ניתן "כמות שהוא" (As Is) וללא אחריות מכל סוג.
                      </p>
                      <p>
                        חברת Xahaph AI לא תישא באחריות לכל נזק ישיר, עקיף,
                        תוצאתי או אחר שייגרם עקב השימוש בשירות או אי היכולת
                        להשתמש בו.
                      </p>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold text-lg mb-3">6. פרטיות</h3>
                    <p>
                      השימוש בשירות כפוף למדיניות הפרטיות של חברת Xahaph AI,
                      המהווה חלק בלתי נפרד מתנאי השימוש.
                    </p>
                  </div>

                  <div>
                    <h3 className="font-semibold text-lg mb-3">
                      7. הדין החל וסמכות שיפוט
                    </h3>
                    <p>
                      על תנאי שימוש אלה יחולו דיני מדינת ישראל בלבד. סמכות
                      השיפוט הבלעדית בכל מחלוקת הקשורה בתנאים אלה או בשירות תהיה
                      נתונה לבתי המשפט המוסמכים בעיר תל אביב-יפו.
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  Last updated: September 17, 2025
                </div>

                <p>
                  Welcome to the service provided by Xahaph AI ("the Service").
                  Use of the service is subject to the terms detailed below.
                  Please read the terms carefully before use.
                </p>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    1. Agreement to Terms
                  </h3>
                  <p>
                    By using the service, you confirm that you have read and
                    understood the terms of use and that use of the service
                    constitutes full and binding agreement to these terms. If
                    you do not agree to the terms, please refrain from using the
                    service.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    2. Changes to Terms of Use
                  </h3>
                  <p>
                    Xahaph AI may update or change the terms of use from time to
                    time at its sole discretion. Any change will take effect
                    immediately upon publication in the service, and use of the
                    service after such change will constitute agreement to the
                    updated terms.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    3. Use of Service
                  </h3>
                  <div className="space-y-3">
                    <p>
                      Use of the service is permitted for lawful purposes only.
                    </p>
                    <p>
                      The user undertakes not to use the service for purposes
                      that infringe the rights of third parties, including
                      intellectual property rights, privacy, confidentiality or
                      any other right.
                    </p>
                    <p>
                      Xahaph AI may terminate access to the service for users
                      who violate these terms.
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    4. Intellectual Property
                  </h3>
                  <p>
                    All rights in the service, including content, design, text,
                    code, trademarks, logos, images and videos, belong to Xahaph
                    AI or third parties who have licensed them to use. Do not
                    copy, duplicate, distribute or transmit any part of the
                    service without written permission in advance from Xahaph
                    AI.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    5. Limitation of Liability
                  </h3>
                  <div className="space-y-3">
                    <p>
                      The service is provided "As Is" and without warranty of
                      any kind.
                    </p>
                    <p>
                      Xahaph AI will not be liable for any direct, indirect,
                      consequential or other damage caused by the use of the
                      service or inability to use it.
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. Privacy</h3>
                  <p>
                    Use of the service is subject to Xahaph AI's privacy policy,
                    which is an integral part of the terms of use.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">
                    7. Applicable Law and Jurisdiction
                  </h3>
                  <p>
                    These terms of use shall be governed by the laws of the
                    State of Israel only. Exclusive jurisdiction in any dispute
                    related to these terms or the service shall be vested in the
                    competent courts in Tel Aviv-Yafo.
                  </p>
                </div>
              </div>
            )}
          </div>

          <DialogFooter
            className={language === "he" ? "justify-start" : "justify-end"}
          >
            <Button
              variant="outline"
              onClick={() => setShowTermsDialog(false)}
              data-testid="button-close-terms"
            >
              {t("ui.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Schedule Manager Dialog */}
      {scheduleAacUser && (
        <ScheduleManager
          aacUserId={scheduleAacUser.aacUserId}
          aacUserAlias={scheduleAacUser.alias}
          open={scheduleManagerOpen}
          onOpenChange={setScheduleManagerOpen}
        />
      )}

      {/* Admin login now uses regular user authentication system */}
    </div>
  );
}
