import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import aivotaLogo from "@assets/aivota_logo.png";

interface LoginModalProps {
  isOpen: boolean;
  onClose: (user?: any) => void;
}

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const [isLogin, setIsLogin] = useState(true);
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
      const response = await apiRequest("POST", "/auth/login", credentials);
      return response.json();
    },
    onSuccess: (data) => {
      localStorage.removeItem('aac_signed_out');
      toast({
        title: "Welcome back!",
        description: "You have successfully logged in.",
      });
      // Set query data directly to avoid race condition between invalidateQueries and refetch
      queryClient.setQueryData(["/auth/user"], { success: true, user: data.user });
      onClose(data.user);
    },
    onError: (error: any) => {
      toast({
        title: "Login Failed",
        description: error.message || "Invalid email or password",
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
        title: "Welcome to Aivota!",
        description: "Your account has been created successfully.",
      });
      // Set query data directly to avoid race condition between invalidateQueries and refetch
      queryClient.setQueryData(["/auth/user"], { success: true, user: data.user });
      onClose(data.user);
    },
    onError: (error: any) => {
      toast({
        title: "Registration Failed",
        description: error.message || "Failed to create account",
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

  const isLoading = loginMutation.isPending || registerMutation.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={() => !isLoading && onClose()}>
      <DialogContent className="sm:max-w-[500px]" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <img src={aivotaLogo} alt="Aivota" className="mx-auto h-14 mb-2 object-contain" />
          <DialogTitle>
            {isLogin ? "Welcome Back" : "Create Your Account"}
          </DialogTitle>
          <DialogDescription>
            {isLogin 
              ? "Sign in to access your communication profile and continue your journey."
              : "Join Aivota and create your personalized communication experience."
            }
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email and Password - Always required */}
          <div className="grid grid-cols-1 gap-4">
            <div>
              <Label htmlFor="email">Email Address *</Label>
              <Input
                id="email"
                type="email"
                placeholder="your.email@example.com"
                value={formData.email}
                onChange={(e) => handleInputChange("email", e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="password">Password *</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={formData.password}
                onChange={(e) => handleInputChange("password", e.target.value)}
                required
              />
            </div>
          </div>

          {/* Registration-only fields */}
          {!isLogin && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Full Name *</Label>
                  <Input
                    id="name"
                    placeholder="Your full name"
                    value={formData.name}
                    onChange={(e) => handleInputChange("name", e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="age">Age</Label>
                  <Input
                    id="age"
                    type="number"
                    placeholder="25"
                    value={formData.age}
                    onChange={(e) => handleInputChange("age", e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="gender">Gender</Label>
                  <Select value={formData.gender} onValueChange={(value) => handleInputChange("gender", value)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select gender" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                      <SelectItem value="prefer-not-to-say">Prefer not to say</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="language">Preferred Language</Label>
                  <Select value={formData.language} onValueChange={(value) => handleInputChange("language", value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="he">Hebrew</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="preferences">Communication Preferences</Label>
                <Textarea
                  id="preferences"
                  placeholder="Tell us about your communication needs, interests, or preferences..."
                  value={formData.preferences}
                  onChange={(e) => handleInputChange("preferences", e.target.value)}
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="clinicalInfo">Clinical Information (Optional)</Label>
                <Textarea
                  id="clinicalInfo"
                  placeholder="Any relevant clinical information or support needs..."
                  value={formData.clinicalInfo}
                  onChange={(e) => handleInputChange("clinicalInfo", e.target.value)}
                  rows={2}
                />
              </div>
            </>
          )}

          <div className="flex flex-col gap-3 pt-4">
            <Button 
              type="submit" 
              disabled={isLoading}
              className="w-full bg-purple-600 hover:bg-purple-700"
            >
              {isLoading 
                ? (isLogin ? "Signing in..." : "Creating Account...") 
                : (isLogin ? "Sign In" : "Create Account")
              }
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}