import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { Calendar, Clock, Plus, Edit2, Trash2, Save, X } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import type { StudentSchedule } from "@shared/schema";

interface ScheduleManagerProps {
  studentId: string;
  studentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ScheduleManager({
  studentId,
  studentName,
  open,
  onOpenChange,
}: ScheduleManagerProps) {
  const { t, language } = useLanguage();
  const { toast } = useToast();
  const [editingSchedule, setEditingSchedule] = useState<StudentSchedule | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "10:00",
    activityName: "",
    topicTags: [] as string[],
    isRepeatingWeekly: true,
    dateOverride: "" as string | undefined,
  });
  const [topicTagInput, setTopicTagInput] = useState("");

  const daysOfWeek = language === "he" 
    ? ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]
    : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Fetch schedules for this AAC user
  const { data: schedulesData, isLoading } = useQuery({
    queryKey: ["/api/schedules", studentId],
    queryFn: async () => {
      const res = await fetch(`/api/schedules/${studentId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch schedules");
      return res.json();
    },
    enabled: open && !!studentId,
  });

  const schedules: StudentSchedule[] = schedulesData?.schedules || [];

  // Create schedule mutation
  const createScheduleMutation = useMutation({
    mutationFn: async (data: typeof scheduleForm) => {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          studentId,
          startTime: `${data.startTime}:00`,
          endTime: `${data.endTime}:00`,
        }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to create schedule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedules", studentId] });
      toast({
        title: language === "he" ? "נוצר בהצלחה" : "Created successfully",
        description: language === "he" ? "פעילות נוספה ללוח הזמנים" : "Activity added to schedule",
      });
      resetForm();
    },
    onError: () => {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "נכשל ליצור פעילות" : "Failed to create activity",
        variant: "destructive",
      });
    },
  });

  // Update schedule mutation
  const updateScheduleMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<typeof scheduleForm> }) => {
      const res = await fetch(`/api/schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          startTime: data.startTime ? `${data.startTime}:00` : undefined,
          endTime: data.endTime ? `${data.endTime}:00` : undefined,
        }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update schedule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedules", studentId] });
      toast({
        title: language === "he" ? "עודכן בהצלחה" : "Updated successfully",
        description: language === "he" ? "פעילות עודכנה" : "Activity updated",
      });
      setEditingSchedule(null);
      resetForm();
    },
    onError: () => {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "נכשל לעדכן פעילות" : "Failed to update activity",
        variant: "destructive",
      });
    },
  });

  // Delete schedule mutation
  const deleteScheduleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/schedules/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete schedule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedules", studentId] });
      toast({
        title: language === "he" ? "נמחק בהצלחה" : "Deleted successfully",
        description: language === "he" ? "פעילות הוסרה מלוח הזמנים" : "Activity removed from schedule",
      });
    },
    onError: () => {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "נכשל למחוק פעילות" : "Failed to delete activity",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setScheduleForm({
      dayOfWeek: 1,
      startTime: "09:00",
      endTime: "10:00",
      activityName: "",
      topicTags: [],
      isRepeatingWeekly: true,
      dateOverride: "",
    });
    setTopicTagInput("");
    setIsCreating(false);
    setEditingSchedule(null);
  };

  const handleEdit = (schedule: StudentSchedule) => {
    setEditingSchedule(schedule);
    setScheduleForm({
      dayOfWeek: schedule.dayOfWeek,
      startTime: schedule.startTime.substring(0, 5),
      endTime: schedule.endTime.substring(0, 5),
      activityName: schedule.activityName,
      topicTags: schedule.topicTags || [],
      isRepeatingWeekly: schedule.isRepeatingWeekly,
      dateOverride: schedule.dateOverride || "",
    });
    setIsCreating(true);
  };

  const handleSubmit = () => {
    if (!scheduleForm.activityName) {
      toast({
        title: language === "he" ? "שגיאה" : "Error",
        description: language === "he" ? "שם פעילות חובה" : "Activity name is required",
        variant: "destructive",
      });
      return;
    }

    // Normalize dateOverride: convert empty string to null for backend validation
    const normalizedData = {
      ...scheduleForm,
      dateOverride: scheduleForm.dateOverride || undefined,
    };

    if (editingSchedule) {
      updateScheduleMutation.mutate({ id: editingSchedule.id, data: normalizedData });
    } else {
      createScheduleMutation.mutate(normalizedData);
    }
  };

  const addTopicTag = () => {
    if (topicTagInput.trim() && !scheduleForm.topicTags.includes(topicTagInput.trim())) {
      setScheduleForm((prev) => ({
        ...prev,
        topicTags: [...prev.topicTags, topicTagInput.trim()],
      }));
      setTopicTagInput("");
    }
  };

  const removeTopicTag = (tag: string) => {
    setScheduleForm((prev) => ({
      ...prev,
      topicTags: prev.topicTags.filter((t) => t !== tag),
    }));
  };

  // Group schedules by day of week
  const schedulesByDay = schedules.reduce((acc, schedule) => {
    const day = schedule.dayOfWeek;
    if (!acc[day]) acc[day] = [];
    acc[day].push(schedule);
    return acc;
  }, {} as Record<number, StudentSchedule[]>);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className={language === "he" ? "text-right" : "text-left"}>
            <div className={`flex items-center gap-2 ${language === "he" ? "flex-row-reverse" : ""}`}>
              <Calendar className="w-5 h-5" />
              {language === "he" ? `לוח זמנים - ${studentName}` : `Schedule - ${studentName}`}
            </div>
          </DialogTitle>
          <DialogDescription className={language === "he" ? "text-right" : "text-left"}>
            {language === "he"
              ? "נהל את לוח הזמנים השבועי לשיפור דיוק הפרשנות של הבינה המלאכותית"
              : "Manage weekly schedule to improve AI interpretation accuracy"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Add/Edit Form */}
          {isCreating ? (
            <div className="bg-muted/50 p-4 rounded-lg space-y-4">
              <h4 className="text-sm font-medium">
                {editingSchedule
                  ? language === "he"
                    ? "ערוך פעילות"
                    : "Edit Activity"
                  : language === "he"
                    ? "הוסף פעילות חדשה"
                    : "Add New Activity"}
              </h4>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{language === "he" ? "יום בשבוע" : "Day of Week"}</Label>
                  <Select
                    value={scheduleForm.dayOfWeek.toString()}
                    onValueChange={(value) =>
                      setScheduleForm((prev) => ({ ...prev, dayOfWeek: parseInt(value) }))
                    }
                  >
                    <SelectTrigger data-testid="select-day-of-week">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {daysOfWeek.map((day, index) => (
                        <SelectItem key={index + 1} value={(index + 1).toString()}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{language === "he" ? "שם פעילות" : "Activity Name"}</Label>
                  <Input
                    value={scheduleForm.activityName}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({ ...prev, activityName: e.target.value }))
                    }
                    placeholder={language === "he" ? "לדוגמה: מתמטיקה, ארוחת צהריים" : "e.g., Math, Lunch"}
                    data-testid="input-activity-name"
                  />
                </div>

                <div className="space-y-2">
                  <Label>{language === "he" ? "שעת התחלה" : "Start Time"}</Label>
                  <Input
                    type="time"
                    value={scheduleForm.startTime}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({ ...prev, startTime: e.target.value }))
                    }
                    data-testid="input-start-time"
                  />
                </div>

                <div className="space-y-2">
                  <Label>{language === "he" ? "שעת סיום" : "End Time"}</Label>
                  <Input
                    type="time"
                    value={scheduleForm.endTime}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({ ...prev, endTime: e.target.value }))
                    }
                    data-testid="input-end-time"
                  />
                </div>
              </div>

              {/* Topic Tags */}
              <div className="space-y-2">
                <Label>{language === "he" ? "תגיות נושא (לדיוק הבינה המלאכותית)" : "Topic Tags (for AI accuracy)"}</Label>
                <div className="flex gap-2">
                  <Input
                    value={topicTagInput}
                    onChange={(e) => setTopicTagInput(e.target.value)}
                    onKeyPress={(e) => e.key === "Enter" && (e.preventDefault(), addTopicTag())}
                    placeholder={language === "he" ? "לדוגמה: אוכל, משפחה, לימודים" : "e.g., food, family, learning"}
                    data-testid="input-topic-tag"
                  />
                  <Button type="button" onClick={addTopicTag} size="sm" data-testid="button-add-tag">
                    {language === "he" ? "הוסף" : "Add"}
                  </Button>
                </div>
                {scheduleForm.topicTags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {scheduleForm.topicTags.map((tag) => (
                      <div
                        key={tag}
                        className="bg-primary/10 text-primary px-2 py-1 rounded-md text-sm flex items-center gap-1"
                      >
                        {tag}
                        <button
                          type="button"
                          onClick={() => removeTopicTag(tag)}
                          className="hover:text-destructive"
                          data-testid={`button-remove-tag-${tag}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={handleSubmit}
                  disabled={createScheduleMutation.isPending || updateScheduleMutation.isPending}
                  data-testid="button-save-schedule"
                >
                  <Save className="w-4 h-4 mr-2" />
                  {language === "he" ? "שמור" : "Save"}
                </Button>
                <Button variant="outline" onClick={resetForm} data-testid="button-cancel-schedule">
                  {language === "he" ? "ביטול" : "Cancel"}
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setIsCreating(true)} className="w-full" data-testid="button-add-new-activity">
              <Plus className="w-4 h-4 mr-2" />
              {language === "he" ? "הוסף פעילות חדשה" : "Add New Activity"}
            </Button>
          )}

          {/* Weekly Schedule View */}
          <div className="space-y-4">
            <h4 className="text-sm font-medium">
              {language === "he" ? "לוח זמנים שבועי" : "Weekly Schedule"}
            </h4>
            
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                {language === "he" ? "טוען..." : "Loading..."}
              </div>
            ) : schedules.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {language === "he"
                  ? "אין פעילויות עדיין. הוסף את הראשונה!"
                  : "No activities yet. Add your first one!"}
              </div>
            ) : (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                  <div key={day} className="border rounded-lg p-3">
                    <h5 className="font-medium mb-2">{daysOfWeek[day - 1]}</h5>
                    {schedulesByDay[day] && schedulesByDay[day].length > 0 ? (
                      <div className="space-y-2">
                        {schedulesByDay[day]
                          .sort((a, b) => a.startTime.localeCompare(b.startTime))
                          .map((schedule) => (
                            <div
                              key={schedule.id}
                              className="bg-muted/50 p-2 rounded flex items-center justify-between"
                            >
                              <div className="flex-1">
                                <div className="font-medium">{schedule.activityName}</div>
                                <div className="text-sm text-muted-foreground flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  {schedule.startTime.substring(0, 5)} - {schedule.endTime.substring(0, 5)}
                                </div>
                                {schedule.topicTags && schedule.topicTags.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {schedule.topicTags.map((tag) => (
                                      <span
                                        key={tag}
                                        className="bg-primary/10 text-primary px-1.5 py-0.5 rounded text-xs"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleEdit(schedule)}
                                  data-testid={`button-edit-schedule-${schedule.id}`}
                                >
                                  <Edit2 className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => deleteScheduleMutation.mutate(schedule.id)}
                                  disabled={deleteScheduleMutation.isPending}
                                  data-testid={`button-delete-schedule-${schedule.id}`}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        {language === "he" ? "אין פעילויות" : "No activities"}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
