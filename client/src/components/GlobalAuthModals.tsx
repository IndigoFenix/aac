// src/components/GlobalAuthModals.tsx
import { useState, FormEvent, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/hooks/useAuth";
import { useStudent } from "@/hooks/useStudent";
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
import { InsertInviteCode, insertInviteCodeSchema, Interpretation, RedeemInviteCode, redeemInviteCodeSchema, Student } from "@shared/schema";
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
    students,
    isLoading: studentsLoading,
    refetchStudent,
  } = useStudent();

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
  const [studentForm, setStudentForm] = useState({
    name: "",
    gender: "",
    birthDate: "",
    framework: "tala",
    country: "IL"
  });
  const [editingStudent, setEditingStudent] = useState<any>(null);
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
  const [scheduleStudent, setScheduleStudent] = useState<{
    studentId: string;
    name: string;
  } | null>(null);

  // Invite code forms
  const createInviteForm = useForm<InsertInviteCode>({
    resolver: zodResolver(insertInviteCodeSchema),
    defaultValues: {
      studentId: undefined,
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
    setEditingStudent(null);
    setStudentForm({
      name: "",
      gender: "",
      birthDate: "",
      framework: "tala",
      country: "IL",
    });
    // Open the student modal
    setShowStudentModal(true);
  });

  // Listen for editStudent event - opens student modal with AAC user data pre-filled
  useUIEvent("editStudent", (studentData: any) => {
    if (studentData) {
      setEditingStudent(studentData);
      setStudentForm({
        name: studentData.name || "",
        gender: studentData.gender || "",
        birthDate: studentData.birthDate || "",
        framework: studentData.framework || "tala",
        country: studentData.country || "IL",
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
  const createStudentMutation = useMutation({
    mutationFn: async (studentData: any) => {
      const res = await apiRequest("POST", "/api/students", studentData);
      return res.json();
    },
    onSuccess: async () => {
      // Refresh global AAC users in the provider
      await refetchStudent();

      // Optional: keep this if anything else still uses the raw query
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });

      setStudentForm({
        name: "",
        gender: "",
        birthDate: "",
        framework: "tala",
        country: "IL",
      });
      setShowStudentModal(false);
      toast({
        title: t("toast.studentCreated"),
        description: t("toast.studentCreatedDesc"),
      });
    },
    onError: (error: any) => {
      toast({
        title: t("toast.studentCreateFailed"),
        description: error?.message || t("toast.studentCreateFailedDesc"),
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
    onSuccess: async () => {
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/students/list"] });

      setEditingStudent(null);
      setStudentForm({
        name: "",
        gender: "",
        birthDate: "",
        framework: "tala",
        country: "IL",
      });
      setShowStudentModal(false);
      toast({
        title: t("toast.studentUpdated"),
        description: t("toast.studentUpdatedDesc"),
      });
    },
    onError: (error: any) => {
      toast({
        title: t("toast.studentUpdateFailed"),
        description: error?.message || t("toast.studentUpdateFailedDesc"),
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
    onSuccess: async () => {
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });

      toast({
        title: t("toast.studentDeleted"),
        description: t("toast.studentDeletedDesc"),
      });
    },
    onError: (error: any) => {
      toast({
        title: t("toast.studentDeleteFailed"),
        description: error?.message || t("toast.studentDeleteFailedDesc"),
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
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ["/api/invite-codes"] });

      redeemInviteForm.reset();
      toast({
        title: t("toast.inviteRedeemed"),
        description: `${t("label.student")} "${data.studentName}" ${t("auth.addedSuccessfully")}`,
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
  const handleCreateStudent = () => {
    if (!studentForm.name.trim()) {
      toast({
        title: t("common.error"),
        description: t("student.nameIsRequired"),
        variant: "destructive",
      });
      return;
    }
    createStudentMutation.mutate(studentForm);
  };

  // CHANGED: Now uses birthDate instead of age
  const handleEditStudent = (student: Student) => {
    setEditingStudent(student);
    setStudentForm({
      name: student.name || "",
      gender: student.gender || "",
      birthDate: student.birthDate || "",
      framework: student.framework || "tala",
      country: student.country || "IL",
    });
  };

  const handleUpdateStudent = () => {
    if (!studentForm.name.trim()) {
      toast({
        title: t("common.error"),
        description: t("student.nameIsRequired"),
        variant: "destructive",
      });
      return;
    }
    updateStudentMutation.mutate({ id: editingStudent.id, data: studentForm });
  };

  // Reset form and close student modal
  const handleCancelEdit = () => {
    setEditingStudent(null);
    setStudentForm({
      name: "",
      gender: "",
      birthDate: "",
      framework: "tala",
      country: "IL",
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
        title: t("common.error"),
        description: t("settings.firstNameIsRequired"),
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
          title: t("common.error"),
          description: t("settings.selectValidImage"),
          variant: "destructive",
        });
        e.target.value = ""; // Clear the input
        return;
      }

      // Validate file size (10MB limit to match server)
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: t("common.error"),
          description: t("settings.imageSizeLimit"),
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
              {t("auth.loginDescription")}
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
              {t("auth.registerDescription")}
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
                {t("auth.userType")}
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
                    placeholder={t("auth.userTypePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Caregiver">
                    {t("auth.userTypeCaregiver")}
                  </SelectItem>
                  <SelectItem value="Parent">
                    {t("auth.userTypeParent")}
                  </SelectItem>
                  <SelectItem value="Teacher">
                    {t("auth.userTypeTeacher")}
                  </SelectItem>
                  <SelectItem value="SLP">
                    {t("auth.userTypeSLP")}
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
              className={`flex items-center gap-2 ${isRTL ? "text-right flex-row-reverse" : "text-left"}`}
            >
              <Settings className="w-5 h-5" />
              {t("settings.title")}
            </DialogTitle>
          </DialogHeader>
          <DialogDescription
            className={isRTL ? "text-right" : "text-left"}
          >
            {t("settings.description")}
          </DialogDescription>

          <div className="space-y-6">
            {/* Personal Profile Section */}
            <div>
              <h3
                className={`text-lg font-medium mb-4 flex items-center gap-2 ${isRTL ? "text-right flex-row-reverse" : "text-left"}`}
              >
                <User className="w-5 h-5" />
                {t("settings.personalProfile")}
              </h3>

              <div className="bg-muted/50 p-4 rounded-lg mb-4">
                {/* Profile Image Section */}
                <div className="mb-6">
                  <h4 className="text-sm font-medium mb-3">
                    {t("settings.profileImage")}
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
                              {t("settings.newImageSelected")}
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
                                  {t("common.uploading")}
                                </>
                              ) : (
                                <>
                                  <Upload className="w-4 h-4" />
                                  {t("common.upload")}
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
                            disabled={true}
                          >
                            <Camera className="w-4 h-4" />
                            {t("settings.selectImage")}
                          </Button>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t("settings.imageHint")}
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
                      {t("settings.firstNameRequired")}
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
                      placeholder={t("settings.firstName")}
                      required
                      data-testid="input-profile-first-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profileLastName">
                      {t("settings.lastName")}
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
                      placeholder={t("settings.lastName")}
                      data-testid="input-profile-last-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profileEmail">
                      {t("settings.email")}
                    </Label>
                    <Input
                      id="profileEmail"
                      value={user?.email || ""}
                      disabled
                      className="bg-muted text-muted-foreground"
                      data-testid="input-profile-email"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("settings.emailCannotChange")}
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
                        {t("settings.updating")}
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4" />
                        {t("settings.updateProfile")}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={initializeProfileForm}
                    disabled={updateProfileMutation.isPending}
                    data-testid="button-reset-profile"
                  >
                    {t("common.reset")}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSettingsDialog(false)}
            >
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Student (AAC User) Create/Edit Modal */}
      <Dialog open={showStudentModal} onOpenChange={setShowStudentModal}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className={isRTL ? "text-right" : ""}>
              {editingStudent
                ? t("student.edit")
                : t("student.addNew")}
            </DialogTitle>
            <DialogDescription className={isRTL ? "text-right" : ""}>
              {editingStudent
                ? t("student.editDescription")
                : t("student.addNewDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Row 1: Name and ID Number */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studentName">
                  {t("student.nameRequired")}
                </Label>
                <Input
                  id="studentName"
                  value={studentForm.name}
                  onChange={(e) =>
                    setStudentForm((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  placeholder={t("student.namePlaceholder")}
                  required
                />
              </div>
            </div>

            {/* Row 2: Gender and Birth Date */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studentGender">
                  {t("student.gender")}
                </Label>
                <Select
                  value={studentForm.gender}
                  onValueChange={(value) =>
                    setStudentForm((prev) => ({ ...prev, gender: value }))
                  }
                >
                  <SelectTrigger id="studentGender">
                    <SelectValue
                      placeholder={t("student.genderPlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Male">
                      {t("student.genderMale")}
                    </SelectItem>
                    <SelectItem value="Female">
                      {t("student.genderFemale")}
                    </SelectItem>
                    <SelectItem value="Other">
                      {t("student.genderOther")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="studentBirthDate">
                  {t("student.dateOfBirth")}
                </Label>
                <Input
                  id="studentBirthDate"
                  type="date"
                  value={studentForm.birthDate}
                  onChange={(e) =>
                    setStudentForm((prev) => ({
                      ...prev,
                      birthDate: e.target.value,
                    }))
                  }
                  max={new Date().toISOString().split('T')[0]}
                />
                {studentForm.birthDate && (
                  <p className="text-xs text-muted-foreground">
                    {t("student.ageDisplay").replace("{{age}}", String(calculateAge(studentForm.birthDate)))}
                  </p>
                )}
              </div>
            </div>

            {/* Row 5: System Type and Country */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studentFramework">
                  {t("student.systemType")}
                </Label>
                <Select
                  value={studentForm.framework}
                  onValueChange={(value) =>
                    setStudentForm((prev) => ({ ...prev, framework: value }))
                  }
                >
                  <SelectTrigger id="studentFramework">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tala">
                      {t("student.frameworkTala")}
                    </SelectItem>
                    <SelectItem value="us_iep">
                      {t("student.frameworkIep")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="studentCountry">
                  {t("student.country")}
                </Label>
                <Select
                  value={studentForm.country}
                  onValueChange={(value) =>
                    setStudentForm((prev) => ({ ...prev, country: value }))
                  }
                >
                  <SelectTrigger id="studentCountry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IL">
                      {t("student.countryIsrael")}
                    </SelectItem>
                    <SelectItem value="US">
                      {t("student.countryUS")}
                    </SelectItem>
                    <SelectItem value="UK">
                      {t("student.countryUK")}
                    </SelectItem>
                    <SelectItem value="Other">
                      {t("student.countryOther")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter className={isRTL ? "flex-row-reverse" : ""}>
            <Button
              variant="outline"
              onClick={handleCancelEdit}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={
                editingStudent ? handleUpdateStudent : handleCreateStudent
              }
              disabled={
                createStudentMutation.isPending ||
                updateStudentMutation.isPending ||
                !studentForm.name.trim()
              }
              className="flex items-center gap-2"
            >
              {(createStudentMutation.isPending || updateStudentMutation.isPending) ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  {t("common.saving")}
                </>
              ) : editingStudent ? (
                <>
                  <Edit className="w-4 h-4" />
                  {t("common.update")}
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  {t("student.addStudent")}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}