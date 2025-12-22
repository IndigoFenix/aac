// src/features/OverviewPanel.tsx
// Overview dashboard panel showing all students and statistics
// Simplified RTL support using dir attribute at container level

import { useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useFeaturePanel, useSharedState } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest } from '@/lib/queryClient';
import { cn } from '@/lib/utils';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  TrendingUp,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Users,
  Activity,
  ChevronRight,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

interface OverviewPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

// Mock data for initial display (will be replaced by API)
const mockStats = {
  totalStudents: 0,
  activeCases: 0,
  completedCases: 0,
  pendingReview: 0,
};

export function OverviewPanel({ isOpen, onClose }: OverviewPanelProps) {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { user } = useAuth();
  const { students, selectStudent } = useStudent();
  const { setActiveFeature, registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();
  const { setSharedState } = useSharedState();

  // Fetch overview data
  const { data: overviewData, isLoading } = useQuery({
    queryKey: ['/api/students/overview'],
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/students/overview');
      return response.json();
    },
    enabled: !!user && isOpen,
  });

  // Register metadata builder
  const buildOverviewMetadata = useCallback(() => {
    return {
      totalStudents: overviewData?.stats?.totalStudents || students.length,
      activeCases: overviewData?.stats?.activeCases || 0,
    };
  }, [overviewData, students.length]);

  useEffect(() => {
    registerMetadataBuilder('overview', buildOverviewMetadata);
    return () => unregisterMetadataBuilder('overview');
  }, [registerMetadataBuilder, unregisterMetadataBuilder, buildOverviewMetadata]);

  // Use API data or fallback to mock
  const stats = overviewData?.stats || mockStats;
  const chartData = overviewData?.phaseDistribution?.length > 0 
    ? overviewData.phaseDistribution.map((p: any, i: number) => ({
        name: p.phaseName,
        value: p.count,
        color: `hsl(var(--chart-${(i % 5) + 1}))`,
      }))
    : [];

  const upcomingDeadlines = overviewData?.upcomingDeadlines || [];

  // Handle student click - navigate to student progress
  const handleStudentClick = async (studentId: string) => {
    await selectStudent(studentId);
    setSharedState({ selectedStudentId: studentId });
    setActiveFeature('progress');
  };

  // Navigate to students list
  const handleViewAllStudents = () => {
    setActiveFeature('students');
  };

  if (!isOpen) return null;

  return (
    <div 
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        'flex flex-col h-full min-h-0',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}
    >
      <ScrollArea dir={isRTL ? 'rtl' : 'ltr'} className="flex-1">
        <div className="p-6 space-y-6">
          {/* Header */}
          <header className="space-y-2">
            <div className="flex justify-between items-start">
              <div>
                <h1 className={cn(
                  'text-2xl font-bold',
                  isDark ? 'text-white' : 'text-slate-900'
                )}>
                  {t('overview.title') || 'Caseload Overview'}
                </h1>
                <p className={cn(
                  'text-sm',
                  isDark ? 'text-slate-400' : 'text-slate-600'
                )}>
                  {t('overview.subtitle') || 'Monitor student progress and upcoming deadlines'}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="gap-2">
                  <CalendarDays className="w-4 h-4" />
                  {new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                </Button>
                <Button 
                  size="sm" 
                  className="gap-2 shadow-lg shadow-primary/20"
                  onClick={handleViewAllStudents}
                >
                  {t('nav.students') || 'Students'}
                  <ArrowRight className="w-4 h-4 icon-arrow-right" />
                </Button>
              </div>
            </div>
          </header>

          {/* Deadline Alert */}
          {upcomingDeadlines.length > 0 && (
            <div className={cn(
              'rounded-xl p-6 flex items-center gap-6 relative overflow-hidden',
              isDark 
                ? 'bg-gradient-to-l from-primary/20 to-transparent border border-primary/30'
                : 'bg-gradient-to-l from-primary/10 to-transparent border border-primary/20'
            )}>
              <div className="absolute top-0 left-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 -translate-x-1/3 pointer-events-none" />
              
              <div className={cn(
                'p-4 rounded-full border shadow-sm z-10',
                isDark ? 'bg-slate-900 border-primary/30' : 'bg-white border-primary/20'
              )}>
                <AlertCircle className="w-8 h-8 text-primary" />
              </div>
              <div className="flex-1 z-10">
                <h3 className={cn(
                  'text-lg font-bold flex items-center gap-2',
                  isDark ? 'text-white' : 'text-slate-900'
                )}>
                  {t('overview.deadlineAlert') || 'Upcoming Deadlines'}
                  <Badge variant="destructive" className="animate-pulse">
                    {t('overview.daysLeft') || '7 days'}
                  </Badge>
                </h3>
                <p className={cn(
                  'mt-1',
                  isDark ? 'text-slate-400' : 'text-slate-600'
                )}>
                  {(t('overview.deadlineDesc') || '{count} students require attention this week')
                    .replace('{count}', upcomingDeadlines.length.toString())}
                </p>
              </div>
              <div className="z-10">
                <Button
                  size="lg"
                  className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-md"
                  onClick={handleViewAllStudents}
                >
                  {t('overview.reviewBtn') || 'Review Now'}
                </Button>
              </div>
            </div>
          )}

          {/* Stats Grid */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t('overview.totalStudents') || 'Total Students'}
                </CardTitle>
                <Users className="w-4 h-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.totalStudents}</div>
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3 text-green-500" />
                  {t('overview.growth') || '+2 this month'}
                </p>
              </CardContent>
            </Card>

            <Card className="hover:shadow-md transition-shadow border-primary/20">
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t('overview.activePlans') || 'Active Plans'}
                </CardTitle>
                <Activity className="w-4 h-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">{stats.activeCases}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('overview.fromLastMonth') || 'In progress'}
                </p>
              </CardContent>
            </Card>

            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t('overview.completed') || 'Completed'}
                </CardTitle>
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">{stats.completedCases}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('overview.ytd') || 'Year to date'}
                </p>
              </CardContent>
            </Card>

            <Card className={cn(
              'hover:shadow-md transition-shadow',
              isDark 
                ? 'border-amber-800 bg-amber-900/10' 
                : 'border-amber-200 bg-amber-50/30'
            )}>
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className={cn(
                  'text-sm font-medium',
                  isDark ? 'text-amber-400' : 'text-amber-700'
                )}>
                  {t('overview.pendingReview') || 'Pending Review'}
                </CardTitle>
                <Clock className={cn(
                  'w-4 h-4',
                  isDark ? 'text-amber-400' : 'text-amber-600'
                )} />
              </CardHeader>
              <CardContent>
                <div className={cn(
                  'text-2xl font-bold',
                  isDark ? 'text-amber-400' : 'text-amber-700'
                )}>
                  {stats.pendingReview}
                </div>
                <p className={cn(
                  'text-xs mt-1',
                  isDark ? 'text-amber-500' : 'text-amber-600/80'
                )}>
                  {t('overview.attentionNeeded') || 'Need attention'}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Main Content Area */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Chart */}
            <Card className="lg:col-span-2 h-full flex flex-col">
              <CardHeader>
                <CardTitle>{t('overview.chartTitle') || 'Caseload by Phase'}</CardTitle>
                <CardDescription>
                  {t('overview.chartSubtitle') || 'Distribution of students across process phases'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 min-h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartData}
                    layout="vertical"
                    margin={{ top: 20, right: 0, left: 10, bottom: 5 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      horizontal={false}
                      stroke="hsl(var(--border))"
                    />
                    <XAxis type="number" hide reversed={isRTL} />
                    <YAxis
                      dataKey="name"
                      type="category"
                      orientation={isRTL ? 'right' : 'left'}
                      width={120}
                      tick={{
                        fill: 'hsl(var(--muted-foreground))',
                        fontSize: 12,
                        textAnchor: isRTL ? 'start' : 'end',
                        dx: isRTL ? 10 : -10,
                      }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        borderColor: 'hsl(var(--border))',
                        borderRadius: '8px',
                        textAlign: isRTL ? 'right' : 'left',
                        direction: isRTL ? 'rtl' : 'ltr',
                      }}
                      cursor={{ fill: 'hsl(var(--muted)/0.2)' }}
                    />
                    <Bar dataKey="value" radius={[4, 0, 0, 4]} barSize={32}>
                      {chartData.map((entry: any, index: number) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Priority Focus / Upcoming Deadlines */}
            <Card className="h-full flex flex-col">
              <CardHeader>
                <CardTitle>{t('overview.priorityFocus') || 'Priority Focus'}</CardTitle>
                <CardDescription>
                  {t('overview.priorityDesc') || 'Students requiring immediate attention'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-4">
                {students.slice(0, 4).map((student) => (
                  <div
                    key={student.id}
                    dir={isRTL ? 'rtl' : 'ltr'}
                    onClick={() => handleStudentClick(student.id)}
                    className={cn(
                      'group flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-all',
                      isDark 
                        ? 'border-slate-800 hover:border-primary/30 hover:bg-primary/5'
                        : 'border-border hover:border-primary/30 hover:bg-primary/5'
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        'w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs transition-colors',
                        isDark 
                          ? 'bg-slate-800 text-slate-300 group-hover:bg-primary group-hover:text-primary-foreground'
                          : 'bg-secondary text-secondary-foreground group-hover:bg-primary group-hover:text-primary-foreground'
                      )}>
                        {student.name.split(' ').map(n => n[0]).join('')}
                      </div>
                      <div>
                        <p className="font-medium text-sm">{student.name}</p>
                        <div className="flex items-center gap-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                          <p className="text-xs text-muted-foreground">
                            {t('overview.phaseGoals') || 'Goal Development'}
                          </p>
                        </div>
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground group-hover:text-primary"
                    >
                      <ChevronRight className={cn('w-4 h-4', isRTL && 'rotate-180')} />
                    </Button>
                  </div>
                ))}

                <Button 
                  variant="outline" 
                  className="w-full mt-auto"
                  onClick={handleViewAllStudents}
                >
                  {t('overview.viewAllPriority') || 'View All Students'}
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}