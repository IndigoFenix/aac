// src/components/GlobalAuthModals.tsx
import { useState, FormEvent, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/hooks/useAuth";
import { useAacUser } from "@/hooks/useAacUser";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { openUI, useUIEvent } from "@/lib/uiEvents";
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
import { InsertInviteCode, insertInviteCodeSchema, Interpretation, RedeemInviteCode, redeemInviteCodeSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { useTheme } from "@/contexts/ThemeContext";

export function GlobalAuthModals() {
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

  // AAC users come from the global provider
  const {
    aacUsers,
    isLoading: aacUsersLoading,
    refetchAacUser,
  } = useAacUser();

  // Fetch user's invite codes
  const {
    data: inviteCodesData,
    isLoading: inviteCodesLoading,
    error: inviteCodesError,
  } = useQuery({
    queryKey: ["/api/invite-codes"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/invite-codes");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  // dialog visibility
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  const [showRegisterDialog, setShowRegisterDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);

  // login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // registration form
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerData, setRegisterData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirmPassword: "",
    userType: "Caregiver" as "admin" | "Teacher" | "Caregiver" | "SLP" | "Parent",
  });
  
  const [profileImagePreview, setProfileImagePreview] = useState<string | null>(
    null,
  );

  // settings
  // CHANGED: 'age' replaced with 'birthDate' (ISO date string 'YYYY-MM-DD')
  const [aacUserForm, setAacUserForm] = useState({
    name: "",
    gender: "",
    birthDate: "",
    diagnosis: "",
    backgroundContext: "",
    systemType: "tala",
    country: "IL",
    school: "",
    grade: "",
    idNumber: "",
  });
  const [editingAacUser, setEditingAacUser] = useState<any>(null);
  const [showStudentModal, setShowStudentModal] = useState(false);
  const [profileForm, setProfileForm] = useState({
    firstName: "",
    lastName: "",
  });
  const [profileImageFile, setProfileImageFile] = useState<File | null>(null);
  // Invite code states
  const [showActiveInviteCodes, setShowActiveInviteCodes] = useState(false);

  // Schedule manager state
  const [scheduleManagerOpen, setScheduleManagerOpen] = useState(false);
  const [scheduleAacUser, setScheduleAacUser] = useState<{
    aacUserId: string;
    name: string;
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

  // listen for shell events
  useUIEvent("login", () => {
    setShowRegisterDialog(false);
    setShowLoginDialog(true);
  });
  useUIEvent("register", () => {
    setShowLoginDialog(false);
    setShowRegisterDialog(true);
  });
  useUIEvent("settings", () => {
    setShowSettingsDialog(true);
  });

  // Listen for createStudent event - opens student modal with empty form
  useUIEvent("createStudent", () => {
    // Clear any existing edit state
    setEditingAacUser(null);
    setAacUserForm({
      name: "",
      gender: "",
      birthDate: "",
      diagnosis: "",
      backgroundContext: "",
      systemType: "tala",
      country: "IL",
      school: "",
      grade: "",
      idNumber: "",
    });
    // Open the student modal
    setShowStudentModal(true);
  });

  // Listen for editStudent event - opens student modal with AAC user data pre-filled
  useUIEvent("editStudent", (studentData: any) => {
    if (studentData) {
      setEditingAacUser(studentData);
      setAacUserForm({
        name: studentData.name || "",
        gender: studentData.gender || "",
        birthDate: studentData.birthDate || "",
        diagnosis: studentData.diagnosis || "",
        backgroundContext: studentData.backgroundContext || "",
        systemType: studentData.systemType || "tala",
        country: studentData.country || "IL",
        school: studentData.school || "",
        grade: studentData.grade || "",
        idNumber: studentData.idNumber || "",
      });
    }
    // Open the student modal
    setShowStudentModal(true);
  });

  // handlers (migrated from home.tsx)
  const handleEmailLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!loginEmail.trim() || !loginPassword.trim()) {
      toast({ title: t("auth.error"), description: t("auth.fieldsRequired"), variant: "destructive" });
      return;
    }
    setIsLoggingIn(true);
    try {
      const ok = await login(loginEmail, loginPassword);
      if (ok) {
        await refetchUser();
        toast({ title: t("auth.loginSuccess"), description: t("auth.welcomeBack") });
        setShowLoginDialog(false);
        setLoginEmail("");
        setLoginPassword("");
      } else {
        toast({ title: t("auth.loginFailed"), description: t("auth.invalidCredentials"), variant: "destructive" });
      }
    } catch {
      toast({ title: t("auth.loginFailed"), description: t("auth.loginError"), variant: "destructive" });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    const d = registerData;
    if (!d.firstName.trim() || !d.lastName.trim() || !d.email.trim() || !d.password.trim() || !d.confirmPassword.trim()) {
      toast({ title: t("auth.error"), description: t("auth.fieldsRequired"), variant: "destructive" });
      return;
    }
    if (d.password !== d.confirmPassword) {
      toast({ title: t("auth.error"), description: t("auth.passwordMismatch"), variant: "destructive" });
      return;
    }
    setIsRegistering(true);
    try {
      const res = await apiRequest("POST", "/auth/register", {
        email: d.email,
        firstName: d.firstName,
        lastName: d.lastName,
        password: d.password,
        userType: d.userType,
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Registration failed");

      await refetchUser();
      toast({ title: t("auth.registerSuccess"), description: t("auth.registerSuccessDesc") });
      setShowRegisterDialog(false);
      setRegisterData({ firstName: "", lastName: "", email: "", password: "", confirmPassword: "", userType: "Caregiver" });
    } catch {
      toast({ title: t("auth.registerFailed"), description: t("auth.registerError"), variant: "destructive" });
    } finally {
      setIsRegistering(false);
    }
  };

  // ADDED: Helper function to calculate age from birth date
  const calculateAge = (birthDateStr: string | null): number | null => {
    if (!birthDateStr) return null;
    const birth = new Date(birthDateStr);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  };


  // Create AAC user mutation
  const createAacUserMutation = useMutation({
    mutationFn: async (aacUserData: any) => {
      const res = await apiRequest("POST", "/api/aac-users", aacUserData);
      return res.json();
    },
    onSuccess: async () => {
      // Refresh global AAC users in the provider
      await refetchAacUser();

      // Optional: keep this if anything else still uses the raw query
      queryClient.invalidateQueries({ queryKey: ["/api/aac-users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/students/list"] });

      setAacUserForm({
        name: "",
        gender: "",
        birthDate: "",
        diagnosis: "",
        backgroundContext: "",
        systemType: "tala",
        country: "IL",
        school: "",
        grade: "",
        idNumber: "",
      });
      setShowStudentModal(false);
      toast({
        title: t("toast.aacUserCreated"),
        description: t("toast.aacUserCreatedDesc"),
      });
    },
    onError: (error: any) => {
      toast({
        title: t("toast.aacUserCreateFailed"),
        description: error?.message || t("toast.aacUserCreateFailedDesc"),
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
    onSuccess: async () => {
      await refetchAacUser();
      queryClient.invalidateQueries({ queryKey: ["/api/aac-users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/students/list"] });

      setEditingAacUser(null);
      setAacUserForm({
        name: "",
        gender: "",
        birthDate: "",
        diagnosis: "",
        backgroundContext: "",
        systemType: "tala",
        country: "IL",
        school: "",
        grade: "",
        idNumber: "",
      });
      setShowStudentModal(false);
      toast({
        title: t("toast.aacUserUpdated"),
        description: t("toast.aacUserUpdatedDesc"),
      });
    },
    onError: (error: any) => {
      toast({
        title: t("toast.aacUserUpdateFailed"),
        description: error?.message || t("toast.aacUserUpdateFailedDesc"),
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
    onSuccess: async () => {
      await refetchAacUser();
      queryClient.invalidateQueries({ queryKey: ["/api/aac-users"] });

      toast({
        title: t("toast.aacUserDeleted"),
        description: t("toast.aacUserDeletedDesc"),
      });
    },
    onError: (error: any) => {
      toast({
        title: t("toast.aacUserDeleteFailed"),
        description: error?.message || t("toast.aacUserDeleteFailedDesc"),
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
    onSuccess: async (data) => {
      await refetchAacUser();
      queryClient.invalidateQueries({ queryKey: ["/api/invite-codes"] });

      redeemInviteForm.reset();
      toast({
        title: t("toast.inviteRedeemed"),
        description: `${t("label.aacUser")} "${data.aacUserName}" ${
          language === "he" ? "נוסף בהצלחה" : "has been added successfully"
        }`,
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
      } catch {
        // keep default
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
      name: string;
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
    onSuccess: () => {
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
  
  // AAC User handlers
  const handleCreateAacUser = () => {
    if (!aacUserForm.name.trim()) {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description:
          language === "he"
            ? "נדרש כינוי למשתמש תת״ח"
            : "AAC user name is required",
        variant: "destructive",
      });
      return;
    }
    createAacUserMutation.mutate(aacUserForm);
  };

  // CHANGED: Now uses birthDate instead of age
  const handleEditAacUser = (aacUser: any) => {
    setEditingAacUser(aacUser);
    setAacUserForm({
      name: aacUser.name || "",
      gender: aacUser.gender || "",
      birthDate: aacUser.birthDate || "",
      disabilityOrSyndrome: aacUser.disabilityOrSyndrome || "",
    });
  };

  const handleUpdateAacUser = () => {
    if (!aacUserForm.name.trim()) {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description:
          language === "he"
            ? "נדרש כינוי למשתמש תת״ח"
            : "AAC user name is required",
        variant: "destructive",
      });
      return;
    }
    updateAacUserMutation.mutate({ id: editingAacUser.id, data: aacUserForm });
  };

  // Reset form and close student modal
  const handleCancelEdit = () => {
    setEditingAacUser(null);
    setAacUserForm({
      name: "",
      gender: "",
      birthDate: "",
      diagnosis: "",
      backgroundContext: "",
      systemType: "tala",
      country: "IL",
      school: "",
      grade: "",
      idNumber: "",
    });
    setShowStudentModal(false);
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

  return (
    <>
      {/* Login Dialog (GLOBAL) */}

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
                    <Label htmlFor="aacName">
                      {language === "he" ? "כינוי (חובה)" : "Name (Required)"}
                    </Label>
                    <Input
                      id="aacName"
                      value={aacUserForm.name}
                      onChange={(e) =>
                        setAacUserForm((prev) => ({
                          ...prev,
                          name: e.target.value,
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
                  {/* CHANGED: Replaced age text input with birthDate date picker */}
                  <div className="space-y-2">
                    <Label htmlFor="aacBirthDate">
                      {language === "he" ? "תאריך לידה" : "Date of Birth"}
                    </Label>
                    <Input
                      id="aacBirthDate"
                      type="date"
                      value={aacUserForm.birthDate}
                      onChange={(e) =>
                        setAacUserForm((prev) => ({
                          ...prev,
                          birthDate: e.target.value,
                        }))
                      }
                      max={new Date().toISOString().split('T')[0]}
                    />
                    {aacUserForm.birthDate && (
                      <p className="text-xs text-muted-foreground">
                        {language === "he" 
                          ? `גיל: ${calculateAge(aacUserForm.birthDate)} שנים`
                          : `Age: ${calculateAge(aacUserForm.birthDate)} years`}
                      </p>
                    )}
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
                ) : aacUsers && aacUsers.length > 0 ? (
                  aacUsers.map((aacUser: any) => (
                    <div
                      key={aacUser.id}
                      className="border border-border rounded-lg p-3 flex justify-between items-start"
                    >
                      <div className="space-y-1">
                        <h4 className="font-medium">{aacUser.name}</h4>
                        <div className="text-sm text-muted-foreground space-y-1">
                          {aacUser.gender && (
                            <p>
                              {language === "he" ? "מגדר" : "Gender"}:{" "}
                              {aacUser.gender}
                            </p>
                          )}
                          {(aacUser.birthDate || aacUser.age) && (
                            <p>
                              {language === "he" ? "גיל" : "Age"}:{" "}
                              {aacUser.age ??
                                calculateAge(aacUser.birthDate)}
                              {aacUser.birthDate && (
                                <span className="text-xs ml-2">
                                  (
                                  {new Date(
                                    aacUser.birthDate,
                                  ).toLocaleDateString(
                                    language === "he" ? "he-IL" : "en-US",
                                  )}
                                  )
                                </span>
                              )}
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
                              aacUserId: aacUser.id,
                              name: aacUser.name,
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
                                ) : aacUsers && aacUsers.length > 0 ? (
                                  aacUsers
                                    .filter(
                                      (aacUser: any) =>
                                        aacUser.id &&
                                        String(aacUser.id).trim() !== "",
                                    )
                                    .map((aacUser: any) => (
                                      <SelectItem
                                        key={aacUser.id}
                                        value={String(aacUser.id)}
                                      >
                                        {aacUser.name}
                                        {(aacUser.age || aacUser.birthDate) &&
                                          ` (${
                                            aacUser.age ??
                                            calculateAge(aacUser.birthDate)
                                          })`}
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
                                    data-testid={`invite-code-name-${inviteCode.id}`}
                                  >
                                    {inviteCode.aacUserName}
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

      {/* Student (AAC User) Create/Edit Modal */}
      <Dialog open={showStudentModal} onOpenChange={setShowStudentModal}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className={language === "he" ? "text-right" : ""}>
              {editingAacUser
                ? language === "he"
                  ? "עריכת תלמיד"
                  : "Edit Student"
                : language === "he"
                  ? "הוספת תלמיד חדש"
                  : "Add New Student"}
            </DialogTitle>
            <DialogDescription className={language === "he" ? "text-right" : ""}>
              {editingAacUser
                ? language === "he"
                  ? "עדכן את פרטי התלמיד"
                  : "Update the student's information"
                : language === "he"
                  ? "הזן את פרטי התלמיד החדש"
                  : "Enter the new student's information"}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Row 1: Name and ID Number */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studentName">
                  {language === "he" ? "שם (חובה)" : "Name (Required)"}
                </Label>
                <Input
                  id="studentName"
                  value={aacUserForm.name}
                  onChange={(e) =>
                    setAacUserForm((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  placeholder={
                    language === "he"
                      ? "לדוגמה: שרה כהן"
                      : "e.g., Sarah Cohen"
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="studentIdNumber">
                  {language === "he" ? "מספר תלמיד" : "Student ID"}
                </Label>
                <Input
                  id="studentIdNumber"
                  value={aacUserForm.idNumber}
                  onChange={(e) =>
                    setAacUserForm((prev) => ({
                      ...prev,
                      idNumber: e.target.value,
                    }))
                  }
                  placeholder={
                    language === "he"
                      ? "מספר זיהוי"
                      : "ID number"
                  }
                />
              </div>
            </div>

            {/* Row 2: Gender and Birth Date */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studentGender">
                  {language === "he" ? "מגדר" : "Gender"}
                </Label>
                <Select
                  value={aacUserForm.gender}
                  onValueChange={(value) =>
                    setAacUserForm((prev) => ({ ...prev, gender: value }))
                  }
                >
                  <SelectTrigger id="studentGender">
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
                <Label htmlFor="studentBirthDate">
                  {language === "he" ? "תאריך לידה" : "Date of Birth"}
                </Label>
                <Input
                  id="studentBirthDate"
                  type="date"
                  value={aacUserForm.birthDate}
                  onChange={(e) =>
                    setAacUserForm((prev) => ({
                      ...prev,
                      birthDate: e.target.value,
                    }))
                  }
                  max={new Date().toISOString().split('T')[0]}
                />
                {aacUserForm.birthDate && (
                  <p className="text-xs text-muted-foreground">
                    {language === "he" 
                      ? `גיל: ${calculateAge(aacUserForm.birthDate)} שנים`
                      : `Age: ${calculateAge(aacUserForm.birthDate)} years`}
                  </p>
                )}
              </div>
            </div>

            {/* Row 3: School and Grade */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studentSchool">
                  {language === "he" ? "בית ספר" : "School"}
                </Label>
                <Input
                  id="studentSchool"
                  value={aacUserForm.school}
                  onChange={(e) =>
                    setAacUserForm((prev) => ({
                      ...prev,
                      school: e.target.value,
                    }))
                  }
                  placeholder={
                    language === "he"
                      ? "שם בית הספר"
                      : "School name"
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="studentGrade">
                  {language === "he" ? "כיתה" : "Grade"}
                </Label>
                <Input
                  id="studentGrade"
                  value={aacUserForm.grade}
                  onChange={(e) =>
                    setAacUserForm((prev) => ({
                      ...prev,
                      grade: e.target.value,
                    }))
                  }
                  placeholder={
                    language === "he"
                      ? "לדוגמה: ה׳, ו׳"
                      : "e.g., 5th, 6th"
                  }
                />
              </div>
            </div>

            {/* Row 4: Diagnosis */}
            <div className="space-y-2">
              <Label htmlFor="studentDiagnosis">
                {language === "he" ? "אבחנה" : "Diagnosis"}
              </Label>
              <Input
                id="studentDiagnosis"
                value={aacUserForm.diagnosis}
                onChange={(e) =>
                  setAacUserForm((prev) => ({
                    ...prev,
                    diagnosis: e.target.value,
                  }))
                }
                placeholder={
                  language === "he"
                    ? "לדוגמה: תסמונת רט, אוטיזם"
                    : "e.g., Rett Syndrome, Autism"
                }
              />
            </div>

            {/* Row 5: System Type and Country */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studentSystemType">
                  {language === "he" ? "סוג מערכת" : "System Type"}
                </Label>
                <Select
                  value={aacUserForm.systemType}
                  onValueChange={(value) =>
                    setAacUserForm((prev) => ({ ...prev, systemType: value }))
                  }
                >
                  <SelectTrigger id="studentSystemType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tala">
                      {language === "he" ? "תל״א (ישראל)" : "TALA (Israel)"}
                    </SelectItem>
                    <SelectItem value="us_iep">
                      {language === "he" ? "IEP (ארה״ב)" : "IEP (US)"}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="studentCountry">
                  {language === "he" ? "מדינה" : "Country"}
                </Label>
                <Select
                  value={aacUserForm.country}
                  onValueChange={(value) =>
                    setAacUserForm((prev) => ({ ...prev, country: value }))
                  }
                >
                  <SelectTrigger id="studentCountry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IL">
                      {language === "he" ? "ישראל" : "Israel"}
                    </SelectItem>
                    <SelectItem value="US">
                      {language === "he" ? "ארצות הברית" : "United States"}
                    </SelectItem>
                    <SelectItem value="UK">
                      {language === "he" ? "בריטניה" : "United Kingdom"}
                    </SelectItem>
                    <SelectItem value="Other">
                      {language === "he" ? "אחר" : "Other"}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Row 6: Background Context */}
            <div className="space-y-2">
              <Label htmlFor="studentBackgroundContext">
                {language === "he" ? "מידע רקע" : "Background Information"}
              </Label>
              <textarea
                id="studentBackgroundContext"
                className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={aacUserForm.backgroundContext}
                onChange={(e) =>
                  setAacUserForm((prev) => ({
                    ...prev,
                    backgroundContext: e.target.value,
                  }))
                }
                placeholder={
                  language === "he"
                    ? "מידע רלוונטי נוסף על התלמיד..."
                    : "Additional relevant information about the student..."
                }
              />
            </div>
          </div>

          <DialogFooter className={language === "he" ? "flex-row-reverse" : ""}>
            <Button
              variant="outline"
              onClick={handleCancelEdit}
            >
              {language === "he" ? "ביטול" : "Cancel"}
            </Button>
            <Button
              onClick={
                editingAacUser ? handleUpdateAacUser : handleCreateAacUser
              }
              disabled={
                createAacUserMutation.isPending ||
                updateAacUserMutation.isPending ||
                !aacUserForm.name.trim()
              }
              className="flex items-center gap-2"
            >
              {(createAacUserMutation.isPending || updateAacUserMutation.isPending) ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  {language === "he" ? "שומר..." : "Saving..."}
                </>
              ) : editingAacUser ? (
                <>
                  <Edit className="w-4 h-4" />
                  {language === "he" ? "עדכון" : "Update"}
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  {language === "he" ? "הוסף תלמיד" : "Add Student"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}