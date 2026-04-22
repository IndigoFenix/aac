// src/components/GlobalAuthModals.tsx
import { useState, FormEvent, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { useStudent } from "@/hooks/useStudent";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { openUI, useUIEvent } from "@/lib/uiEvents";
import { StudentModal } from '@/components/StudentModal';
import {
  Save,
  X,
  Upload,
  Crop as CropIcon,
  Camera,
  Settings,
  User,
  Loader2,
} from "lucide-react";
import { BiometricPhotoUpload } from "@/components/BiometricPhotoUpload";
import { InsertInviteCode, insertInviteCodeSchema, RedeemInviteCode, redeemInviteCodeSchema, Student } from "@shared/schema";
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
  const [showStudentModal, setShowStudentModal] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  
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
    setEditingStudent(null);
    setShowStudentModal(true);
  });

  // Listen for editStudent event - opens student modal with AAC user data pre-filled
  useUIEvent("editStudent", (studentData: Student | null) => {
    setEditingStudent(studentData);
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

            {/* Face Photo Section */}
            {user && (
              <div>
                <h3
                  className={`text-lg font-medium mb-4 flex items-center gap-2 ${isRTL ? "text-right flex-row-reverse" : "text-left"}`}
                >
                  <Camera className="w-5 h-5" />
                  {t("biometric.facePhoto")}
                </h3>
                <div className="bg-muted/50 p-4 rounded-lg">
                  <p className={`text-sm text-muted-foreground mb-3 ${isRTL ? "text-right" : ""}`}>
                    {t("biometric.photoHint")}
                  </p>
                  <BiometricPhotoUpload
                    target={{ type: "user", userId: user.id }}
                    biometricDataId={user.biometricDataId}
                  />
                </div>
              </div>
            )}
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

      {/* Student Create/Edit Modal */}
      <StudentModal
        isOpen={showStudentModal}
        onClose={() => {
          setShowStudentModal(false);
          setEditingStudent(null);
        }}
        editingStudent={editingStudent}
      />
    </>
  );
}