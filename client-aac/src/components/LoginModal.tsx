import { useState, FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, LogIn } from "lucide-react";
import aivotaLogo from "@assets/aivota_logo.png";
import { useLanguage } from "@/contexts/LanguageContext";

interface LoginModalProps {
  isOpen: boolean;
  onClose: (user?: any) => void;
}

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const { t } = useLanguage();
  const [isLogin, setIsLogin] = useState(true);
  const [impersonateEmail, setImpersonateEmail] = useState('');
  const [isImpersonating, setIsImpersonating] = useState(false);
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    name: "",
    age: "",
    gender: "male",
    language: "en",
    preferences: "",
    clinicalInfo: ""
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Login mutation
  const loginMutation = useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const response = await apiRequest("POST", "/auth/login", { ...credentials, aacClient: true });
      return response.json();
    },
    onSuccess: (data) => {
      localStorage.removeItem('aac_signed_out');
      toast({
        title: t("login.welcomeBackToastTitle"),
        description: t("login.loginSuccessDescription"),
      });
      // Set query data directly to avoid race condition between invalidateQueries and refetch
      queryClient.setQueryData(["/auth/user"], { success: true, user: data.user });
      onClose(data.user);
    },
    onError: (error: any) => {
      toast({
        title: t("login.loginFailedTitle"),
        description: error.message || t("login.invalidCredentials"),
        variant: "destructive",
      });
    },
  });

  // Registration mutation
  const registerMutation = useMutation({
    mutationFn: async (userData: any) => {
      const response = await apiRequest("POST", "/auth/register", userData);
      return response.json();
    },
    onSuccess: (data) => {
      localStorage.removeItem('aac_signed_out');
      toast({
        title: t("login.welcomeToAivotaTitle"),
        description: t("login.accountCreatedDescription"),
      });
      // Set query data directly to avoid race condition between invalidateQueries and refetch
      queryClient.setQueryData(["/auth/user"], { success: true, user: data.user });
      onClose(data.user);
    },
    onError: (error: any) => {
      toast({
        title: t("login.registrationFailedTitle"),
        description: error.message || t("login.failedToCreateAccount"),
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (isLogin) {
      loginMutation.mutate({
        email: formData.email,
        password: formData.password
      });
    } else {
      const userData = {
        ...formData,
        age: formData.age ? parseInt(formData.age) : undefined
      };
      registerMutation.mutate(userData);
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleImpersonate = async (e: FormEvent) => {
    e.preventDefault();
    if (!impersonateEmail.trim()) return;
    setIsImpersonating(true);
    try {
      const response = await apiRequest('POST', '/auth/impersonate', { email: impersonateEmail, aacClient: true });
      const data = await response.json();
      if (data.success && data.user) {
        localStorage.removeItem('aac_signed_out');
        toast({ title: 'Impersonation', description: `Logged in as ${data.user.email}` });
        queryClient.setQueryData(["/auth/user"], { success: true, user: data.user });
        onClose(data.user);
      } else {
        toast({ title: 'Impersonation failed', description: data.message, variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Impersonation failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsImpersonating(false);
    }
  };

  const isLoading = loginMutation.isPending || registerMutation.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={() => !isLoading && onClose()}>
      <DialogContent className="sm:max-w-[500px] shadow-lg" onPointerDownOutside={(e) => e.preventDefault()} hideCloseButton>
        <DialogHeader className="space-y-1 text-center sm:text-center">
          <img src={aivotaLogo} alt="Aivota" className="mx-auto h-16 mb-4 object-contain" />
          <DialogTitle className="text-2xl font-bold text-center">
            {isLogin ? t("login.welcomeBackHeading") : t("login.createAccountHeading")}
          </DialogTitle>
          <DialogDescription className="text-center">
            {isLogin
              ? t("login.loginDescription")
              : t("login.registerDescription")
            }
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("login.emailAddressRequired")}</Label>
            <Input
              id="email"
              type="email"
              placeholder={t("login.emailPlaceholderExample")}
              value={formData.email}
              onChange={(e) => handleInputChange("email", e.target.value)}
              required
              dir="ltr"
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{t("login.passwordRequired")}</Label>
            <Input
              id="password"
              type="password"
              placeholder={t("auth.passwordPlaceholder")}
              value={formData.password}
              onChange={(e) => handleInputChange("password", e.target.value)}
              required
              dir="ltr"
              disabled={isLoading}
            />
          </div>

          {/* Registration-only fields */}
          {!isLogin && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">{t("login.fullNameRequired")}</Label>
                  <Input
                    id="name"
                    placeholder={t("login.fullNamePlaceholder")}
                    value={formData.name}
                    onChange={(e) => handleInputChange("name", e.target.value)}
                    required
                    disabled={isLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="age">{t("settings.age")}</Label>
                  <Input
                    id="age"
                    type="number"
                    placeholder="25"
                    value={formData.age}
                    onChange={(e) => handleInputChange("age", e.target.value)}
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="gender">{t("settings.gender")}</Label>
                  <Select value={formData.gender} onValueChange={(value) => handleInputChange("gender", value)} disabled={isLoading}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("settings.selectGender")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="male">{t("settings.male")}</SelectItem>
                      <SelectItem value="female">{t("settings.female")}</SelectItem>
                      <SelectItem value="other">{t("settings.other")}</SelectItem>
                      <SelectItem value="prefer-not-to-say">{t("settings.preferNotToSay")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="language">{t("login.preferredLanguage")}</Label>
                  <Select value={formData.language} onValueChange={(value) => handleInputChange("language", value)} disabled={isLoading}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="he">עברית (Hebrew)</SelectItem>
                      <SelectItem value="es">Español (Spanish)</SelectItem>
                      <SelectItem value="pt">Português (Portuguese)</SelectItem>
                      <SelectItem value="fr">Français (French)</SelectItem>
                      <SelectItem value="ru">Русский (Russian)</SelectItem>
                      <SelectItem value="de">Deutsch (German)</SelectItem>
                      <SelectItem value="ar">العربية (Arabic)</SelectItem>
                      <SelectItem value="zh">中文 (Mandarin)</SelectItem>
                      <SelectItem value="yue">粵語 (Cantonese)</SelectItem>
                      <SelectItem value="ko">한국어 (Korean)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="preferences">{t("login.communicationPreferences")}</Label>
                <Textarea
                  id="preferences"
                  placeholder={t("login.communicationPreferencesPlaceholder")}
                  value={formData.preferences}
                  onChange={(e) => handleInputChange("preferences", e.target.value)}
                  rows={3}
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="clinicalInfo">{t("login.clinicalInformation")}</Label>
                <Textarea
                  id="clinicalInfo"
                  placeholder={t("login.clinicalInformationPlaceholder")}
                  value={formData.clinicalInfo}
                  onChange={(e) => handleInputChange("clinicalInfo", e.target.value)}
                  rows={2}
                  disabled={isLoading}
                />
              </div>
            </>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin me-2" />
                {isLogin ? t("login.signingIn") : t("login.creatingAccount")}
              </>
            ) : (
              isLogin ? t("login.signIn") : t("login.createAccount")
            )}
          </Button>
        </form>

        {/* Dev-only impersonation */}
        {import.meta.env.DEV && (
          <form onSubmit={handleImpersonate}>
            <div className="border-t pt-4 space-y-2">
              <p className="text-xs font-medium text-orange-600">Dev: Login as user</p>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="user@example.com"
                  value={impersonateEmail}
                  onChange={(e) => setImpersonateEmail(e.target.value)}
                  required
                  dir="ltr"
                  className="text-sm"
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={isImpersonating}
                  className="shrink-0 border-orange-300 text-orange-600 hover:bg-orange-50"
                >
                  {isImpersonating ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
