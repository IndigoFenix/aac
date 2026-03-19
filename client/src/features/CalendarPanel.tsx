// src/features/CalendarPanel.tsx
// Calendar feature panel with monthly view and event management

import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Edit2,
  Clock,
  Repeat,
  Users,
  CalendarDays,
  X,
} from 'lucide-react';

import type { CalendarEvent, CalendarEventAttendee } from '@shared/schema';

interface CalendarPanelProps {
  isOpen?: boolean;
}

type EventWithAttendees = CalendarEvent & { attendees: CalendarEventAttendee[] };

interface AttendeeEntry {
  attendeeType: 'user' | 'student' | 'classroom' | 'institute';
  attendeeId: string;
  label: string; // display name
}

interface EventFormData {
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  repeatType: 'none' | 'daily' | 'weekly';
  repeatDays: number[];
  repeatEndDate: string;
  attendees: AttendeeEntry[];
}

const defaultFormData: EventFormData = {
  title: '',
  description: '',
  startTime: '',
  endTime: '',
  allDay: false,
  repeatType: 'none',
  repeatDays: [],
  repeatEndDate: '',
  attendees: [],
};

function toLocalDateTimeString(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toLocalDateString(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function CalendarPanel({ isOpen }: CalendarPanelProps) {
  const { t, isRTL } = useLanguage();
  const { user } = useAuth();
  const { students } = useStudent();
  const { currentInstitute, institutes } = useInstitute();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [showEventDialog, setShowEventDialog] = useState(false);
  const [editingEvent, setEditingEvent] = useState<EventWithAttendees | null>(null);
  const [formData, setFormData] = useState<EventFormData>(defaultFormData);

  // Calculate month range for query
  const { startDate, endDate } = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    // Include prev/next month overflow days
    const start = new Date(year, month, 1);
    start.setDate(start.getDate() - start.getDay()); // go to start of week
    const end = new Date(year, month + 1, 0);
    end.setDate(end.getDate() + (6 - end.getDay())); // go to end of week
    end.setHours(23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }, [currentDate]);

  // Fetch events
  const { data: eventsData, isLoading } = useQuery({
    queryKey: ['/api/calendar/events', startDate.toISOString(), endDate.toISOString()],
    queryFn: async () => {
      const res = await apiRequest('GET',
        `/api/calendar/events?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`
      );
      const json = await res.json();
      return json.events as EventWithAttendees[];
    },
    enabled: !!user,
  });

  const events = eventsData || [];

  // Fetch classrooms for the current institute (for attendee picker)
  const { data: classroomsData } = useQuery({
    queryKey: ['/api/institutes', currentInstitute?.id, 'classrooms'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/institutes/${currentInstitute!.id}/classrooms`);
      const json = await res.json();
      return json.classrooms as { id: string; name: string }[];
    },
    enabled: !!currentInstitute,
  });

  const classrooms = classroomsData || [];

  // Build available attendee options for the picker
  const attendeeOptions = useMemo((): AttendeeEntry[] => {
    const opts: AttendeeEntry[] = [];

    // Students
    for (const s of students) {
      opts.push({ attendeeType: 'student', attendeeId: s.id, label: s.name });
    }

    // Institutes
    for (const inst of institutes) {
      opts.push({ attendeeType: 'institute', attendeeId: inst.id, label: inst.name });
    }

    // Classrooms
    for (const cr of classrooms) {
      opts.push({ attendeeType: 'classroom', attendeeId: cr.id, label: cr.name });
    }

    return opts;
  }, [students, institutes, classrooms]);

  // Expand recurring events into occurrences within the visible range
  const expandedEvents = useMemo(() => {
    const result: { event: EventWithAttendees; date: Date }[] = [];

    for (const ev of events) {
      const evStart = new Date(ev.startTime);
      const evEnd = new Date(ev.endTime);

      if (ev.repeatType === 'none') {
        result.push({ event: ev, date: evStart });
      } else if (ev.repeatType === 'daily') {
        const cursor = new Date(Math.max(evStart.getTime(), startDate.getTime()));
        cursor.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
        const repeatEnd = ev.repeatEndDate ? new Date(ev.repeatEndDate) : endDate;
        const limit = new Date(Math.min(repeatEnd.getTime(), endDate.getTime()));
        while (cursor <= limit) {
          result.push({ event: ev, date: new Date(cursor) });
          cursor.setDate(cursor.getDate() + 1);
        }
      } else if (ev.repeatType === 'weekly' && ev.repeatDays) {
        const days = ev.repeatDays as number[];
        const cursor = new Date(Math.max(evStart.getTime(), startDate.getTime()));
        cursor.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
        // Align to start of week
        cursor.setDate(cursor.getDate() - cursor.getDay());
        const repeatEnd = ev.repeatEndDate ? new Date(ev.repeatEndDate) : endDate;
        const limit = new Date(Math.min(repeatEnd.getTime(), endDate.getTime()));
        while (cursor <= limit) {
          for (const day of days) {
            const d = new Date(cursor);
            d.setDate(d.getDate() + day);
            if (d >= startDate && d <= limit && d >= evStart) {
              result.push({ event: ev, date: new Date(d) });
            }
          }
          cursor.setDate(cursor.getDate() + 7);
        }
      }
    }

    return result;
  }, [events, startDate, endDate]);

  // Group events by date key
  const eventsByDate = useMemo(() => {
    const map = new Map<string, { event: EventWithAttendees; date: Date }[]>();
    for (const item of expandedEvents) {
      const key = toLocalDateString(item.date);
      const list = map.get(key) || [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }, [expandedEvents]);

  // Mutations
  const createEvent = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest('POST', '/api/calendar/events', data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/calendar/events'] });
      toast({ description: t('calendar.created') });
      setShowEventDialog(false);
      resetForm();
    },
  });

  const updateEvent = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await apiRequest('PATCH', `/api/calendar/events/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/calendar/events'] });
      toast({ description: t('calendar.updated') });
      setShowEventDialog(false);
      resetForm();
    },
  });

  const deleteEvent = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest('DELETE', `/api/calendar/events/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/calendar/events'] });
      toast({ description: t('calendar.deleted') });
    },
  });

  const resetForm = useCallback(() => {
    setFormData(defaultFormData);
    setEditingEvent(null);
  }, []);

  const openNewEvent = useCallback((date?: Date) => {
    const d = date || new Date();
    const start = new Date(d);
    start.setHours(9, 0, 0, 0);
    const end = new Date(d);
    end.setHours(10, 0, 0, 0);
    setFormData({
      ...defaultFormData,
      startTime: toLocalDateTimeString(start),
      endTime: toLocalDateTimeString(end),
    });
    setEditingEvent(null);
    setShowEventDialog(true);
  }, []);

  const openEditEvent = useCallback((ev: EventWithAttendees) => {
    // Build attendee entries from existing attendees, resolving labels
    const existingAttendees: AttendeeEntry[] = (ev.attendees || []).map((att) => {
      let label = att.attendeeId;
      if (att.attendeeType === 'student') {
        const s = students.find((st) => st.id === att.attendeeId);
        if (s) label = s.name;
      } else if (att.attendeeType === 'institute') {
        const inst = institutes.find((i) => i.id === att.attendeeId);
        if (inst) label = inst.name;
      } else if (att.attendeeType === 'classroom') {
        const cr = classrooms.find((c) => c.id === att.attendeeId);
        if (cr) label = cr.name;
      } else if (att.attendeeType === 'user' && att.attendeeId === user?.id) {
        label = t('calendar.you');
      }
      return { attendeeType: att.attendeeType as AttendeeEntry['attendeeType'], attendeeId: att.attendeeId, label };
    });

    setFormData({
      title: ev.title,
      description: ev.description || '',
      startTime: toLocalDateTimeString(new Date(ev.startTime)),
      endTime: toLocalDateTimeString(new Date(ev.endTime)),
      allDay: ev.allDay,
      repeatType: ev.repeatType as any,
      repeatDays: (ev.repeatDays as number[]) || [],
      repeatEndDate: ev.repeatEndDate ? toLocalDateString(new Date(ev.repeatEndDate)) : '',
      attendees: existingAttendees,
    });
    setEditingEvent(ev);
    setShowEventDialog(true);
  }, [students, institutes, classrooms, user, t]);

  const handleSubmit = useCallback(() => {
    const payload: any = {
      title: formData.title,
      description: formData.description || undefined,
      startTime: new Date(formData.startTime).toISOString(),
      endTime: new Date(formData.endTime).toISOString(),
      allDay: formData.allDay,
      repeatType: formData.repeatType,
      repeatDays: formData.repeatType === 'weekly' ? formData.repeatDays : undefined,
      repeatEndDate: formData.repeatEndDate ? new Date(formData.repeatEndDate).toISOString() : undefined,
      attendees: formData.attendees
        .filter((a) => a.attendeeType !== 'user' || a.attendeeId !== user?.id) // creator is auto-added
        .map(({ attendeeType, attendeeId }) => ({ attendeeType, attendeeId })),
    };

    if (editingEvent) {
      updateEvent.mutate({ id: editingEvent.id, data: payload });
    } else {
      createEvent.mutate(payload);
    }
  }, [formData, editingEvent, createEvent, updateEvent, user]);

  const addAttendeeToForm = useCallback((entry: AttendeeEntry) => {
    setFormData(prev => {
      // Don't add duplicates
      if (prev.attendees.some(a => a.attendeeType === entry.attendeeType && a.attendeeId === entry.attendeeId)) {
        return prev;
      }
      return { ...prev, attendees: [...prev.attendees, entry] };
    });
  }, []);

  const removeAttendeeFromForm = useCallback((attendeeType: string, attendeeId: string) => {
    setFormData(prev => ({
      ...prev,
      attendees: prev.attendees.filter(a => !(a.attendeeType === attendeeType && a.attendeeId === attendeeId)),
    }));
  }, []);

  // Attendee options not already added
  const availableAttendees = useMemo(() => {
    return attendeeOptions.filter(opt =>
      !formData.attendees.some(a => a.attendeeType === opt.attendeeType && a.attendeeId === opt.attendeeId)
    );
  }, [attendeeOptions, formData.attendees]);

  const handleDeleteEvent = useCallback((eventId: string) => {
    if (window.confirm(t('calendar.deleteConfirm'))) {
      deleteEvent.mutate(eventId);
    }
  }, [deleteEvent, t]);

  // Calendar grid
  const calendarDays = useMemo(() => {
    const days: Date[] = [];
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
      days.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }, [startDate, endDate]);

  const navigateMonth = (delta: number) => {
    setCurrentDate(prev => {
      const next = new Date(prev);
      next.setMonth(next.getMonth() + delta);
      return next;
    });
  };

  const goToToday = () => {
    setCurrentDate(new Date());
    setSelectedDate(new Date());
  };

  const monthLabel = currentDate.toLocaleDateString(isRTL ? 'he' : 'en', { month: 'long', year: 'numeric' });

  const dayLabels = [
    t('calendar.sun'), t('calendar.mon'), t('calendar.tue'),
    t('calendar.wed'), t('calendar.thu'), t('calendar.fri'), t('calendar.sat'),
  ];

  const today = new Date();
  const todayKey = toLocalDateString(today);
  const currentMonth = currentDate.getMonth();

  // Events for selected date
  const selectedDateKey = selectedDate ? toLocalDateString(selectedDate) : null;
  const selectedDateEvents = selectedDateKey ? (eventsByDate.get(selectedDateKey) || []) : [];

  const toggleRepeatDay = (day: number) => {
    setFormData(prev => ({
      ...prev,
      repeatDays: prev.repeatDays.includes(day)
        ? prev.repeatDays.filter(d => d !== day)
        : [...prev.repeatDays, day].sort(),
    }));
  };

  if (!isOpen) return null;

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">{t('calendar.title')}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goToToday}>
            {t('calendar.today')}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => navigateMonth(-1)}>
            {isRTL ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </Button>
          <span className="text-sm font-medium min-w-[140px] text-center">{monthLabel}</span>
          <Button variant="ghost" size="icon" onClick={() => navigateMonth(1)}>
            {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </Button>
          <Button size="sm" onClick={() => openNewEvent()}>
            <Plus className="w-4 h-4 me-1" />
            {t('calendar.newEvent')}
          </Button>
        </div>
      </div>

      {/* Calendar Grid + Event Detail */}
      <div className="flex-1 flex overflow-hidden">
        {/* Calendar Grid */}
        <div className="flex-1 flex flex-col p-4 overflow-auto">
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-px mb-1">
            {dayLabels.map((label, i) => (
              <div key={i} className="text-center text-xs font-medium text-muted-foreground py-2">
                {label}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-px flex-1 bg-border rounded-lg overflow-hidden">
            {calendarDays.map((day) => {
              const dateKey = toLocalDateString(day);
              const dayEvents = eventsByDate.get(dateKey) || [];
              const isToday = dateKey === todayKey;
              const isCurrentMonth = day.getMonth() === currentMonth;
              const isSelected = selectedDateKey === dateKey;

              return (
                <div
                  key={dateKey}
                  className={cn(
                    "bg-card p-1 min-h-[80px] cursor-pointer transition-colors hover:bg-accent/50",
                    !isCurrentMonth && "bg-muted/30",
                    isSelected && "ring-2 ring-primary ring-inset",
                  )}
                  onClick={() => setSelectedDate(day)}
                  onDoubleClick={() => openNewEvent(day)}
                >
                  <div className={cn(
                    "text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full",
                    isToday && "bg-primary text-primary-foreground",
                    !isToday && !isCurrentMonth && "text-muted-foreground",
                  )}>
                    {day.getDate()}
                  </div>
                  <div className="space-y-0.5">
                    {dayEvents.slice(0, 3).map((item, i) => (
                      <div
                        key={`${item.event.id}-${i}`}
                        className="text-[10px] leading-tight truncate rounded px-1 py-0.5 bg-primary/10 text-primary cursor-pointer hover:bg-primary/20"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedDate(day);
                        }}
                      >
                        {item.event.title}
                      </div>
                    ))}
                    {dayEvents.length > 3 && (
                      <div className="text-[10px] text-muted-foreground ps-1">
                        +{dayEvents.length - 3}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Event Detail Sidebar */}
        {selectedDate && (
          <div className="w-72 border-s flex flex-col bg-card">
            <div className="p-3 border-b flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {selectedDate.toLocaleDateString(isRTL ? 'he' : 'en', { weekday: 'long', month: 'short', day: 'numeric' })}
              </h3>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openNewEvent(selectedDate)}>
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-3 space-y-2">
                {selectedDateEvents.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    {t('calendar.noEvents')}
                  </p>
                ) : (
                  selectedDateEvents.map((item, i) => (
                    <Card key={`${item.event.id}-${i}`} className="shadow-sm">
                      <CardContent className="p-3">
                        <div className="flex items-start justify-between gap-1">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{item.event.title}</p>
                            {item.event.description && (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                                {item.event.description}
                              </p>
                            )}
                          </div>
                          <div className="flex gap-0.5 flex-shrink-0">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              onClick={() => openEditEvent(item.event)}
                            >
                              <Edit2 className="w-3 h-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 text-destructive"
                              onClick={() => handleDeleteEvent(item.event.id)}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          {item.event.allDay ? (
                            <span>{t('calendar.allDay')}</span>
                          ) : (
                            <span>
                              {new Date(item.event.startTime).toLocaleTimeString(isRTL ? 'he' : 'en', { hour: '2-digit', minute: '2-digit' })}
                              {' - '}
                              {new Date(item.event.endTime).toLocaleTimeString(isRTL ? 'he' : 'en', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </div>
                        {item.event.repeatType !== 'none' && (
                          <div className="flex items-center gap-1 mt-1">
                            <Repeat className="w-3 h-3 text-muted-foreground" />
                            <Badge variant="secondary" className="text-[10px] px-1 py-0">
                              {t(`calendar.repeat${item.event.repeatType.charAt(0).toUpperCase() + item.event.repeatType.slice(1)}` as any)}
                            </Badge>
                          </div>
                        )}
                        {item.event.attendees && item.event.attendees.length > 0 && (
                          <div className="flex items-center gap-1 mt-1">
                            <Users className="w-3 h-3 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">
                              {item.event.attendees.length} {t('calendar.attendees').toLowerCase()}
                            </span>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>

      {/* Create/Edit Event Dialog */}
      <Dialog open={showEventDialog} onOpenChange={(open) => { if (!open) { setShowEventDialog(false); resetForm(); } }}>
        <DialogContent className="sm:max-w-[500px]" dir={isRTL ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle>
              {editingEvent ? t('calendar.editEvent') : t('calendar.newEvent')}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {/* Title */}
            <div className="space-y-2">
              <Label>{t('calendar.eventTitle')}</Label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder={t('calendar.eventTitle')}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label>{t('calendar.eventDescription')}</Label>
              <Textarea
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={2}
              />
            </div>

            {/* All Day Toggle */}
            <div className="flex items-center justify-between">
              <Label>{t('calendar.allDay')}</Label>
              <Switch
                checked={formData.allDay}
                onCheckedChange={(checked) => setFormData(prev => ({ ...prev, allDay: checked }))}
              />
            </div>

            {/* Start/End Time */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t('calendar.startTime')}</Label>
                <Input
                  type={formData.allDay ? 'date' : 'datetime-local'}
                  value={formData.allDay ? formData.startTime.split('T')[0] : formData.startTime}
                  onChange={(e) => {
                    const val = formData.allDay ? `${e.target.value}T00:00` : e.target.value;
                    setFormData(prev => ({ ...prev, startTime: val }));
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('calendar.endTime')}</Label>
                <Input
                  type={formData.allDay ? 'date' : 'datetime-local'}
                  value={formData.allDay ? formData.endTime.split('T')[0] : formData.endTime}
                  onChange={(e) => {
                    const val = formData.allDay ? `${e.target.value}T23:59` : e.target.value;
                    setFormData(prev => ({ ...prev, endTime: val }));
                  }}
                />
              </div>
            </div>

            {/* Repeat */}
            <div className="space-y-2">
              <Label>{t('calendar.repeat')}</Label>
              <Select
                value={formData.repeatType}
                onValueChange={(val) => setFormData(prev => ({ ...prev, repeatType: val as any }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('calendar.repeatNone')}</SelectItem>
                  <SelectItem value="daily">{t('calendar.repeatDaily')}</SelectItem>
                  <SelectItem value="weekly">{t('calendar.repeatWeekly')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Weekly day selection */}
            {formData.repeatType === 'weekly' && (
              <div className="space-y-2">
                <Label>{t('calendar.repeatDays')}</Label>
                <div className="flex gap-1">
                  {dayLabels.map((label, i) => (
                    <Button
                      key={i}
                      size="sm"
                      variant={formData.repeatDays.includes(i) ? 'default' : 'outline'}
                      className="w-9 h-9 p-0"
                      onClick={() => toggleRepeatDay(i)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* Repeat end date */}
            {formData.repeatType !== 'none' && (
              <div className="space-y-2">
                <Label>{t('calendar.repeatEndDate')}</Label>
                <Input
                  type="date"
                  value={formData.repeatEndDate}
                  onChange={(e) => setFormData(prev => ({ ...prev, repeatEndDate: e.target.value }))}
                />
              </div>
            )}

            {/* Attendees */}
            <div className="space-y-2">
              <Label>{t('calendar.attendees')}</Label>

              {/* Currently added attendees */}
              {formData.attendees.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {formData.attendees.map((att) => (
                    <Badge
                      key={`${att.attendeeType}-${att.attendeeId}`}
                      variant="secondary"
                      className="gap-1 pe-1"
                    >
                      <span className="text-[10px] text-muted-foreground uppercase">
                        {t(`calendar.${att.attendeeType}` as any)}
                      </span>
                      {att.label}
                      {/* Don't allow removing yourself (auto-added creator) */}
                      {!(att.attendeeType === 'user' && att.attendeeId === user?.id) && (
                        <button
                          type="button"
                          className="ms-1 rounded-full hover:bg-destructive/20 p-0.5"
                          onClick={() => removeAttendeeFromForm(att.attendeeType, att.attendeeId)}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Add attendee dropdown */}
              {availableAttendees.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-start gap-1.5">
                      <Plus className="w-3.5 h-3.5" />
                      {t('calendar.addAttendee')}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[280px]">
                    {/* Group by type */}
                    {(['student', 'institute', 'classroom'] as const).map((type) => {
                      const items = availableAttendees.filter((a) => a.attendeeType === type);
                      if (items.length === 0) return null;
                      return (
                        <div key={type}>
                          <DropdownMenuLabel className="text-xs">
                            {t(`calendar.${type}` as any)}
                          </DropdownMenuLabel>
                          {items.map((opt) => (
                            <DropdownMenuItem
                              key={`${opt.attendeeType}:${opt.attendeeId}`}
                              onClick={() => addAttendeeToForm(opt)}
                            >
                              {opt.label}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                        </div>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowEventDialog(false); resetForm(); }}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!formData.title || !formData.startTime || !formData.endTime || createEvent.isPending || updateEvent.isPending}
            >
              {editingEvent ? t('common.update') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
