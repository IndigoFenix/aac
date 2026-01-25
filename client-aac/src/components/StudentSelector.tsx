import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogOut, User } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { LanguageSelector } from "@/components/LanguageSelector";

interface Student {
  id: string;
  firstName: string;
  lastName?: string;
  age?: number;
}

interface StudentsResponse {
  success: boolean;
  students: Student[];
}

interface StudentSelectorProps {
  user: { id: string; name?: string; email?: string };
  onStudentSelect: (studentId: string) => void;
  onLogout: () => void;
}

export default function StudentSelector({ user, onStudentSelect, onLogout }: StudentSelectorProps) {
  const { t, direction, isRTL } = useLanguage();
  const { data, isLoading, error } = useQuery<StudentsResponse>({
    queryKey: ["/api/students"],
  });

  const students = data?.students;

  // If we get a 401 error, the session is invalid - trigger logout to show login page
  useEffect(() => {
    if (error && error.message?.startsWith("401:")) {
      onLogout();
    }
  }, [error, onLogout]);

  const handleLogout = async () => {
    try {
      await apiRequest("POST", "/auth/logout", {});
      onLogout();
    } catch (err) {
      console.error("Logout failed:", err);
      onLogout();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4" dir={direction}>
      {/* Language Selector in top corner */}
      <div className={`fixed top-4 ${isRTL ? 'left-4' : 'right-4'}`}>
        <LanguageSelector variant="full" />
      </div>

      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-purple-700 dark:text-purple-400">
            {t("auth.selectStudent")}
          </CardTitle>
          <CardDescription className="flex items-center justify-center gap-2">
            <User className="h-4 w-4" />
            {t("auth.loggedInAs")} {user.name || user.email}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading ? (
            <div className="text-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto"></div>
              <p className="mt-2 text-gray-600 dark:text-gray-300">{t("auth.loadingStudents")}</p>
            </div>
          ) : error ? (
            <div className="text-center py-4 text-red-600 dark:text-red-400">
              {t("auth.failedToLoadStudents")}
            </div>
          ) : !students || students.length === 0 ? (
            <div className="text-center py-4 text-gray-600 dark:text-gray-300">
              <p>{t("auth.noStudentsFound")}</p>
              <p className="text-sm mt-2">{t("auth.addStudentHint")}</p>
            </div>
          ) : (
            <Select onValueChange={onStudentSelect}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("auth.chooseStudent")} />
              </SelectTrigger>
              <SelectContent>
                {students.map((student) => (
                  <SelectItem key={student.id} value={student.id}>
                    {student.firstName} {student.lastName || ""}
                    {student.age ? ` (${student.age} ${t("auth.years")})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="pt-4 border-t dark:border-gray-700">
            <Button
              variant="outline"
              onClick={handleLogout}
              className="w-full text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-500"
            >
              <LogOut className={`h-4 w-4 ${isRTL ? 'ms-2' : 'me-2'}`} />
              {t("common.logout")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
