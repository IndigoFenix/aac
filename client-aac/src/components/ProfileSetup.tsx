import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

interface ProfileSetupProps {
  isOpen: boolean;
  onComplete: (studentId: string) => void;
  onSkip: () => void;
}

export default function ProfileSetup({ isOpen, onComplete, onSkip }: ProfileSetupProps) {
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    age: "",
    preferences: "",
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  const createStudentMutation = useMutation({
    mutationFn: async (studentData: any) => {
      const response = await apiRequest("POST", "/api/students", studentData);
      return response.json();
    },
    onSuccess: (student) => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      toast({
        title: t('profile.profileCreatedTitle'),
        description: t('profile.profileCreatedDescription'),
      });
      onComplete(student.id);
    },
    onError: (error: any) => {
      toast({
        title: t('common.error'),
        description: error.message || t('profile.failedToCreateProfile'),
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const studentData: any = {
      firstName: formData.firstName,
      lastName: formData.lastName || undefined,
      preferences: formData.preferences,
    };

    // Convert age to birthDate for Student model
    if (formData.age) {
      const age = parseInt(formData.age);
      const birthYear = new Date().getFullYear() - age;
      studentData.birthDate = new Date(birthYear, 0, 1).toISOString();
    }

    createStudentMutation.mutate(studentData);
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
          >
            <div className="text-center mb-6">
              <h2 className="text-2xl font-bold text-text-primary mb-2">
                {t('profile.welcomeHeading')}
              </h2>
              <p className="text-text-secondary">
                {t('profile.setupSubtitle')}
              </p>
            </div>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="profile-first-name" className="block text-sm font-medium text-text-primary mb-2">
                    {t('profile.firstNameLabel')}
                  </label>
                  <Input
                    id="profile-first-name"
                    type="text"
                    placeholder={t('profile.firstNamePlaceholder')}
                    value={formData.firstName}
                    onChange={(e) => handleInputChange("firstName", e.target.value)}
                    required
                    className="text-lg"
                  />
                </div>
                <div>
                  <label htmlFor="profile-last-name" className="block text-sm font-medium text-text-primary mb-2">
                    {t('profile.lastNameLabel')}
                  </label>
                  <Input
                    id="profile-last-name"
                    type="text"
                    placeholder={t('profile.lastNamePlaceholder')}
                    value={formData.lastName}
                    onChange={(e) => handleInputChange("lastName", e.target.value)}
                    className="text-lg"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="profile-age" className="block text-sm font-medium text-text-primary mb-2">
                  {t('profile.ageLabel')}
                </label>
                <Input
                  id="profile-age"
                  type="number"
                  placeholder={t('settings.age')}
                  value={formData.age}
                  onChange={(e) => handleInputChange("age", e.target.value)}
                  min="1"
                  max="120"
                  className="text-lg"
                />
              </div>

              <div>
                <label htmlFor="profile-preferences" className="block text-sm font-medium text-text-primary mb-2">
                  {t('profile.favoriteThingsLabel')}
                </label>
                <Textarea
                  id="profile-preferences"
                  placeholder={t('profile.favoriteThingsPlaceholder')}
                  value={formData.preferences}
                  onChange={(e) => handleInputChange("preferences", e.target.value)}
                  rows={3}
                  className="text-lg"
                />
              </div>
              
              <div className="flex space-x-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={onSkip}
                  disabled={createStudentMutation.isPending}
                >
                  {t('profile.skipForNow')}
                </Button>
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={createStudentMutation.isPending || !formData.firstName.trim()}
                >
                  {createStudentMutation.isPending ? (
                    <div className="flex items-center space-x-2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      <span>{t('settings.saving')}</span>
                    </div>
                  ) : (
                    t('profile.saveProfile')
                  )}
                </Button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
