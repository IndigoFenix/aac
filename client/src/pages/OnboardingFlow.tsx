import { useState } from "react";
import { useLocation } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Calendar, CheckCircle2, Sparkles, User } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

export default function OnboardingFlow() {
  const { language } = useLanguage();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(1);
  const [createdStudentId, setCreatedStudentId] = useState<string | null>(null);
  const [showCodeRedemption, setShowCodeRedemption] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  
  // Step 1 form state - changed age to birthDate
  const [step1Form, setStep1Form] = useState({
    name: "",
    birthDate: "", // ISO date string 'YYYY-MM-DD'
    diagnosis: "",
  });

  // Step 2 form state
  const [step2Form, setStep2Form] = useState({
    dayOfWeek: 0, // 0=Sunday to 6=Saturday
    startTime: "09:00",
    endTime: "10:00",
    activityName: "",
    topicTags: [] as string[],
    isRepeatingWeekly: true,
  });
  const [topicTagInput, setTopicTagInput] = useState("");

  // Step 3 test interpretation state
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<any>(null);

  // Complete Step 1 mutation - updated to send birthDate
  const completeStep1 = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/onboarding/complete-step-1", {
        name: step1Form.name,
        birthDate: step1Form.birthDate || null, // Send as ISO date string or null
        diagnosis: step1Form.diagnosis,
      });
      return res.json();
    },
    onSuccess: (data) => {
      // Now using the primary key id instead of studentId
      setCreatedStudentId(data.student.id);
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      setCurrentStep(2);
      toast({
        title: language === "he" ? "נשמר בהצלחה" : "Saved successfully",
        description: language === "he" ? "פרופיל נוצר בהצלחה" : "Profile created successfully",
      });
    },
    onError: () => {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "נכשל ליצור פרופיל" : "Failed to create profile",
        variant: "destructive",
      });
    },
  });

  // Redeem invite code mutation
  const redeemCode = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/onboarding/redeem-code", { code: inviteCode });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      toast({
        title: language === "he" ? "הצלחה!" : "Success!",
        description: language === "he" 
          ? "הקוד מומש בהצלחה. ברוך הבא!" 
          : "Code redeemed successfully. Welcome!",
      });
      // Bypass remaining onboarding steps
      setTimeout(() => setLocation("/"), 1000);
    },
    onError: (error: any) => {
      const message = error?.message || (language === "he" ? "הקוד לא חוקי או פג תוקפו" : "Invalid or expired code");
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: message,
        variant: "destructive",
      });
    },
  });

  // Complete Step 2 mutation
  const completeStep2 = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/onboarding/complete-step-2", {
        ...step2Form,
        studentId: createdStudentId,
        dateOverride: null,
      });
      return res.json();
    },
    onSuccess: () => {
      setCurrentStep(3);
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({
        title: language === "he" ? "נשמר בהצלחה" : "Saved successfully",
        description: language === "he" ? "פעילות נוספה ללוח הזמנים" : "Activity added to schedule",
      });
    },
    onError: () => {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "נכשל להוסיף פעילות" : "Failed to add activity",
        variant: "destructive",
      });
    },
  });

  // Test interpretation mutation
  const testInterpretation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/interpret", {
        input: testInput,
        inputType: "text",
        language,
        studentId: createdStudentId,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setTestResult(data.interpretation);
    },
    onError: () => {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "נכשל לפרש טקסט" : "Failed to interpret text",
        variant: "destructive",
      });
    },
  });

  const handleStep1Submit = () => {
    if (!step1Form.name) {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "אנא מלא את שם המשתמש" : "Please enter the user's name",
        variant: "destructive",
      });
      return;
    }
    completeStep1.mutate();
  };

  const handleStep2Submit = () => {
    if (!step2Form.activityName || step2Form.topicTags.length < 2) {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "אנא מלא שם פעילות והוסף לפחות 2 תגיות" : "Please enter activity name and add at least 2 tags",
        variant: "destructive",
      });
      return;
    }
    completeStep2.mutate();
  };

  const addTopicTag = () => {
    if (topicTagInput.trim() && !step2Form.topicTags.includes(topicTagInput.trim())) {
      setStep2Form((prev) => ({
        ...prev,
        topicTags: [...prev.topicTags, topicTagInput.trim()],
      }));
      setTopicTagInput("");
    }
  };

  const removeTopicTag = (tag: string) => {
    setStep2Form((prev) => ({
      ...prev,
      topicTags: prev.topicTags.filter((t) => t !== tag),
    }));
  };

  const handleFinish = () => {
    // Invalidate queries to refresh onboarding status
    queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/students"] });
    setLocation("/");
  };

  // Helper to calculate age from birth date for display
  const calculateAge = (birthDateStr: string): number | null => {
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

  const daysOfWeek = language === "he" 
    ? ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]
    : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const isRtl = language === "he";

  return (
    <div className={`min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 dark:from-gray-900 dark:to-gray-800 py-8 px-4 ${isRtl ? "rtl" : "ltr"}`}>
      <div className="max-w-4xl mx-auto">
        {/* Progress Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {language === "he" ? "ברוכים הבאים ל-CommuniAACte!" : "Welcome to CommuniAACte!"}
            </h1>
            <Badge variant="secondary" className="text-sm">
              {language === "he" ? `שלב ${currentStep}/3` : `Step ${currentStep}/3`}
            </Badge>
          </div>
          <Progress value={(currentStep / 3) * 100} className="h-2" />
        </div>

        {/* Step 1: AAC User Profile OR Code Redemption */}
        {currentStep === 1 && (
          <Card className="border-2">
            <CardHeader>
              <div className={`flex items-center gap-3 ${isRtl ? "flex-row-reverse" : ""}`}>
                <User className="w-8 h-8 text-purple-600" />
                <div className={isRtl ? "text-right" : "text-left"}>
                  <CardTitle className="text-xl">
                    {showCodeRedemption 
                      ? (language === "he" ? "מימוש קוד הזמנה" : "Redeem Invite Code")
                      : (language === "he" ? "צור פרופיל משתמש AAC ראשון" : "Create Your First AAC User Profile")}
                  </CardTitle>
                  <CardDescription>
                    {showCodeRedemption
                      ? (language === "he" ? "הזן את קוד ההזמנה שקיבלת" : "Enter the invite code you received")
                      : (language === "he" ? "הזן את הפרטים של המשתמש שאיתו תעבוד" : "Enter the details of the AAC user you'll be working with")}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {!showCodeRedemption ? (
                <>
                  <div className={isRtl ? "text-right" : "text-left"}>
                    <Label htmlFor="name" className="text-base">
                      {language === "he" ? "שם" : "Name"} <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="name"
                      data-testid="input-name"
                      value={step1Form.name}
                      onChange={(e) => setStep1Form({ ...step1Form, name: e.target.value })}
                      placeholder={language === "he" ? "שם המשתמש" : "User's name"}
                      className="mt-1"
                      dir={isRtl ? "rtl" : "ltr"}
                    />
                  </div>

                  <div className={isRtl ? "text-right" : "text-left"}>
                    <Label htmlFor="birthDate" className="text-base">
                      {language === "he" ? "תאריך לידה" : "Date of Birth"}
                    </Label>
                    <Input
                      id="birthDate"
                      data-testid="input-birth-date"
                      type="date"
                      value={step1Form.birthDate}
                      onChange={(e) => setStep1Form({ ...step1Form, birthDate: e.target.value })}
                      className="mt-1"
                      dir="ltr"
                      max={new Date().toISOString().split('T')[0]} // Can't be in the future
                    />
                    {step1Form.birthDate && (
                      <p className="text-sm text-muted-foreground mt-1">
                        {language === "he" 
                          ? `גיל: ${calculateAge(step1Form.birthDate)} שנים`
                          : `Age: ${calculateAge(step1Form.birthDate)} years`}
                      </p>
                    )}
                  </div>

                  <div className={isRtl ? "text-right" : "text-left"}>
                    <Label htmlFor="diagnosis" className="text-base">
                      {language === "he" ? "מצב/אבחנה" : "Condition/Diagnosis"}
                    </Label>
                    <Input
                      id="diagnosis"
                      data-testid="input-diagnosis"
                      value={step1Form.diagnosis}
                      onChange={(e) => setStep1Form({ ...step1Form, diagnosis: e.target.value })}
                      placeholder={language === "he" ? "לדוגמה: תסמונת רט" : "e.g., Rett Syndrome"}
                      className="mt-1"
                      dir={isRtl ? "rtl" : "ltr"}
                    />
                  </div>

                  <Button
                    data-testid="button-continue-step1"
                    onClick={handleStep1Submit}
                    disabled={completeStep1.isPending}
                    className="w-full mt-6"
                    size="lg"
                  >
                    {completeStep1.isPending ? (
                      language === "he" ? "שומר..." : "Saving..."
                    ) : (
                      <div className={`flex items-center gap-2 ${isRtl ? "flex-row-reverse" : ""}`}>
                        <span>{language === "he" ? "המשך" : "Continue"}</span>
                        <ArrowRight className="w-5 h-5" />
                      </div>
                    )}
                  </Button>

                  {/* Toggle to code redemption */}
                  <div className="relative my-6">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-background px-2 text-muted-foreground">
                        {language === "he" ? "או" : "or"}
                      </span>
                    </div>
                  </div>

                  <Button
                    data-testid="button-show-code-redemption"
                    onClick={() => setShowCodeRedemption(true)}
                    variant="outline"
                    className="w-full"
                  >
                    {language === "he" ? "יש לך קוד הזמנה? מימוש כאן" : "Have an Invite Code? Redeem Here"}
                  </Button>
                </>
              ) : (
                <>
                  <div className={isRtl ? "text-right" : "text-left"}>
                    <Label htmlFor="inviteCode" className="text-base">
                      {language === "he" ? "קוד הזמנה" : "Invite Code"} <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="inviteCode"
                      data-testid="input-invite-code"
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                      placeholder={language === "he" ? "הזן קוד" : "Enter code"}
                      className="mt-1 font-mono"
                      dir="ltr"
                      maxLength={10}
                    />
                  </div>

                  <Button
                    data-testid="button-redeem-code"
                    onClick={() => redeemCode.mutate()}
                    disabled={!inviteCode || redeemCode.isPending}
                    className="w-full mt-6"
                    size="lg"
                  >
                    {redeemCode.isPending ? (
                      language === "he" ? "מאמת..." : "Validating..."
                    ) : (
                      language === "he" ? "מימוש קוד" : "Redeem Code"
                    )}
                  </Button>

                  {/* Toggle back to profile creation */}
                  <Button
                    data-testid="button-show-profile-creation"
                    onClick={() => setShowCodeRedemption(false)}
                    variant="ghost"
                    className="w-full"
                  >
                    {language === "he" ? "חזור ליצירת פרופיל" : "Back to Create Profile"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 2: Schedule Setup */}
        {currentStep === 2 && (
          <Card className="border-2">
            <CardHeader>
              <div className={`flex items-center gap-3 ${isRtl ? "flex-row-reverse" : ""}`}>
                <Calendar className="w-8 h-8 text-blue-600" />
                <div className={isRtl ? "text-right" : "text-left"}>
                  <CardTitle className="text-xl">
                    {language === "he" ? "הוסף פעילות ראשונה ללוח הזמנים" : "Add Your First Schedule Activity"}
                  </CardTitle>
                  <CardDescription>
                    {language === "he" 
                      ? "הכוון את ה-AI! הוסף פעילות יומית אחת לדיוק טוב יותר" 
                      : "Teach the AI! Add one daily activity for better accuracy"}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className={isRtl ? "text-right" : "text-left"}>
                <Label htmlFor="activity" className="text-base">
                  {language === "he" ? "שם הפעילות" : "Activity Name"} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="activity"
                  data-testid="input-activity"
                  value={step2Form.activityName}
                  onChange={(e) => setStep2Form({ ...step2Form, activityName: e.target.value })}
                  placeholder={language === "he" ? "לדוגמה: ארוחת בוקר" : "e.g., Breakfast"}
                  className="mt-1"
                  dir={isRtl ? "rtl" : "ltr"}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className={isRtl ? "text-right" : "text-left"}>
                  <Label htmlFor="day" className="text-base">
                    {language === "he" ? "יום" : "Day"}
                  </Label>
                  <select
                    id="day"
                    data-testid="select-day"
                    value={step2Form.dayOfWeek}
                    onChange={(e) => setStep2Form({ ...step2Form, dayOfWeek: parseInt(e.target.value) })}
                    className="w-full mt-1 p-2 border rounded-md"
                    dir={isRtl ? "rtl" : "ltr"}
                  >
                    {daysOfWeek.map((day, index) => (
                      <option key={index} value={index}>{day}</option>
                    ))}
                  </select>
                </div>

                <div className={isRtl ? "text-right" : "text-left"}>
                  <Label htmlFor="startTime" className="text-base">
                    {language === "he" ? "שעת התחלה" : "Start Time"}
                  </Label>
                  <Input
                    id="startTime"
                    data-testid="input-start-time"
                    type="time"
                    value={step2Form.startTime}
                    onChange={(e) => setStep2Form({ ...step2Form, startTime: e.target.value })}
                    className="mt-1"
                  />
                </div>

                <div className={isRtl ? "text-right" : "text-left"}>
                  <Label htmlFor="endTime" className="text-base">
                    {language === "he" ? "שעת סיום" : "End Time"}
                  </Label>
                  <Input
                    id="endTime"
                    data-testid="input-end-time"
                    type="time"
                    value={step2Form.endTime}
                    onChange={(e) => setStep2Form({ ...step2Form, endTime: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <div className={isRtl ? "text-right" : "text-left"}>
                <Label htmlFor="tags" className="text-base">
                  {language === "he" ? "תגיות נושא" : "Topic Tags"} <span className="text-red-500">* (לפחות 2)</span>
                </Label>
                <div className={`flex gap-2 mt-1 ${isRtl ? "flex-row-reverse" : ""}`}>
                  <Input
                    id="tags"
                    data-testid="input-tags"
                    value={topicTagInput}
                    onChange={(e) => setTopicTagInput(e.target.value)}
                    onKeyPress={(e) => e.key === "Enter" && (e.preventDefault(), addTopicTag())}
                    placeholder={language === "he" ? "לדוגמה: אוכל, משפחה" : "e.g., food, family"}
                    dir={isRtl ? "rtl" : "ltr"}
                  />
                  <Button data-testid="button-add-tag" onClick={addTopicTag} type="button" variant="outline">
                    {language === "he" ? "הוסף" : "Add"}
                  </Button>
                </div>
                <div className={`flex flex-wrap gap-2 mt-2 ${isRtl ? "flex-row-reverse" : ""}`}>
                  {step2Form.topicTags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="px-3 py-1">
                      {tag}
                      <button
                        data-testid={`button-remove-tag-${tag}`}
                        onClick={() => removeTopicTag(tag)}
                        className={`ml-2 hover:text-red-500 ${isRtl ? "mr-2 ml-0" : ""}`}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>

              <Button
                data-testid="button-continue-step2"
                onClick={handleStep2Submit}
                disabled={completeStep2.isPending}
                className="w-full mt-6"
                size="lg"
              >
                {completeStep2.isPending ? (
                  language === "he" ? "שומר..." : "Saving..."
                ) : (
                  <div className={`flex items-center gap-2 ${isRtl ? "flex-row-reverse" : ""}`}>
                    <span>{language === "he" ? "המשך" : "Continue"}</span>
                    <ArrowRight className="w-5 h-5" />
                  </div>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Test Interpretation */}
        {currentStep === 3 && (
          <Card className="border-2">
            <CardHeader>
              <div className={`flex items-center gap-3 ${isRtl ? "flex-row-reverse" : ""}`}>
                <Sparkles className="w-8 h-8 text-green-600" />
                <div className={isRtl ? "text-right" : "text-left"}>
                  <CardTitle className="text-xl">
                    {language === "he" ? "הצלחה! בוא ננסה את זה" : "Success! Let's Try It"}
                  </CardTitle>
                  <CardDescription>
                    {language === "he" 
                      ? "בדוק איך ה-AI משתמש בהקשר מלוח הזמנים" 
                      : "See how the AI uses your schedule context"}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Context Banner */}
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <p className={`text-sm text-blue-800 dark:text-blue-200 ${isRtl ? "text-right" : "text-left"}`}>
                  {language === "he" 
                    ? `מבוסס על פרופיל ${step1Form.name} ופעילות '${step2Form.activityName}' בלוח הזמנים שלך`
                    : `Based on ${step1Form.name}'s profile and your '${step2Form.activityName}' schedule`}
                </p>
              </div>

              <div className={isRtl ? "text-right" : "text-left"}>
                <Label htmlFor="testInput" className="text-base">
                  {language === "he" ? "נסה הודעת בדיקה" : "Try a Test Message"}
                </Label>
                <Input
                  id="testInput"
                  data-testid="input-test-message"
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  placeholder={language === "he" ? "הקלד הודעה לפרשנות..." : "Type a message to interpret..."}
                  className="mt-1"
                  dir={isRtl ? "rtl" : "ltr"}
                />
                <Button
                  data-testid="button-test-interpret"
                  onClick={() => testInterpretation.mutate()}
                  disabled={!testInput || testInterpretation.isPending}
                  className="mt-2 w-full"
                >
                  {testInterpretation.isPending 
                    ? (language === "he" ? "מפרש..." : "Interpreting...")
                    : (language === "he" ? "פרש" : "Interpret")}
                </Button>
              </div>

              {testResult && (
                <div className="mt-4 space-y-3">
                  <div className={`bg-white dark:bg-gray-800 border rounded-lg p-4 ${isRtl ? "text-right" : "text-left"}`}>
                    <h3 className="font-semibold text-lg mb-2">
                      {language === "he" ? "משמעות מפורשת:" : "Interpreted Meaning:"}
                    </h3>
                    <p className="text-gray-700 dark:text-gray-300" data-testid="text-interpretation-result">
                      {testResult.interpretedMeaning}
                    </p>
                  </div>

                  <div className={`flex gap-2 ${isRtl ? "flex-row-reverse" : ""}`}>
                    <Button variant="outline" size="sm" className="flex-1" data-testid="button-feedback-correct">
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      {language === "he" ? "זה נכון!" : "That's Right!"}
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1" data-testid="button-feedback-close">
                      {language === "he" ? "קרוב, זה היה..." : "That's Close, it was..."}
                    </Button>
                  </div>
                </div>
              )}

              <Button
                data-testid="button-finish"
                onClick={handleFinish}
                className="w-full mt-6"
                size="lg"
                variant="default"
              >
                <div className={`flex items-center gap-2 ${isRtl ? "flex-row-reverse" : ""}`}>
                  <span>{language === "he" ? "סיום ומעבר לאפליקציה" : "Finish & Go to App"}</span>
                  <ArrowRight className="w-5 h-5" />
                </div>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}