import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { 
  Users, 
  TrendingUp, 
  Download, 
  Calendar as CalendarIcon,
  Search,
  Filter,
  BarChart3,
  PieChart,
  LineChart,
  Activity,
  UserCheck,
  UserPlus,
  UserX,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  Minus
} from "lucide-react";
import { format, subDays } from "date-fns";
import { LineChart as RechartsLineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart as RechartsPieChart, Cell } from "recharts";

interface KPIData {
  totalUsers: number;
  activeUsers: number;
  newSignups: number;
  conversionToPaid: number;
  churnedUsers: number;
  dau: number;
  wau: number;
  mau: number;
  avgSessionsPerActiveUser: number;
  avgTimeInAppPerActiveUser: number;
  previousPeriod: {
    totalUsers: number;
    activeUsers: number;
    newSignups: number;
    conversionToPaid: number;
    churnedUsers: number;
    dau: number;
    wau: number;
    mau: number;
    avgSessionsPerActiveUser: number;
    avgTimeInAppPerActiveUser: number;
  };
}

interface TrendData {
  data: Array<{ date: string; value: number; previousValue: number }>;
}

interface TopUsersData {
  users: Array<{
    userId: string;
    email: string;
    plan: string;
    signupDate: string;
    lastSeen: string;
    sessionsInRange: number;
    totalEventsInRange: number;
    keyActions: {
      generations: number;
      downloads: number;
    };
  }>;
  total: number;
}

interface UserDetail {
  kpis: {
    totalSessions: number;
    totalEvents: number;
    totalTimeInApp: number;
    generations: number;
    downloads: number;
  };
  timeline: Array<{
    date: string;
    eventType: string;
    eventCategory: string;
    details: string;
  }>;
}

interface CohortData {
  cohorts: Array<{
    cohortPeriod: string;
    totalUsers: number;
    retentionRates: { [key: string]: number };
  }>;
}

export function UserStatistics() {
  // Date range filters
  const [startDate, setStartDate] = useState<Date>(subDays(new Date(), 30));
  const [endDate, setEndDate] = useState<Date>(new Date());
  
  // Filter states
  const [planTiers, setPlanTiers] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [acquisitionSources, setAcquisitionSources] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [featureTags, setFeatureTags] = useState<string[]>([]);
  
  // UI states
  const [selectedMetric, setSelectedMetric] = useState<'newSignups' | 'activeUsers' | 'conversions' | 'churns' | 'sessions'>('newSignups');
  const [trendGroupBy, setTrendGroupBy] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [cohortType, setCohortType] = useState<'weekly' | 'monthly'>('weekly');
  const [userTableSearch, setUserTableSearch] = useState('');
  const [userTablePage, setUserTablePage] = useState(1);
  const [userTableSort, setUserTableSort] = useState<'sessions' | 'events' | 'signupDate' | 'lastSeen'>('signupDate');
  const [userTableSortOrder, setUserTableSortOrder] = useState<'asc' | 'desc'>('desc');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // Build filter query params
  const buildFilterParams = () => {
    const params: Record<string, string> = {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
    };
    
    if (planTiers.length > 0) params.planTiers = planTiers.join(',');
    if (countries.length > 0) params.countries = countries.join(',');
    if (acquisitionSources.length > 0) params.acquisitionSources = acquisitionSources.join(',');
    if (platforms.length > 0) params.platforms = platforms.join(',');
    if (featureTags.length > 0) params.featureTags = featureTags.join(',');
    
    return new URLSearchParams(params).toString();
  };

  // Fetch KPIs
  const { data: kpis, isLoading: loadingKPIs } = useQuery<KPIData>({
    queryKey: ["/api/admin/user-statistics/kpis", buildFilterParams()],
    queryFn: async () => {
      const response = await fetch(`/api/admin/user-statistics/kpis?${buildFilterParams()}`);
      if (!response.ok) throw new Error('Failed to fetch KPIs');
      return response.json();
    }
  });

  // Fetch trends
  const { data: trends, isLoading: loadingTrends } = useQuery<TrendData>({
    queryKey: ["/api/admin/user-statistics/trends", selectedMetric, trendGroupBy, buildFilterParams()],
    queryFn: async () => {
      const params = new URLSearchParams({
        metric: selectedMetric,
        groupBy: trendGroupBy,
        ...Object.fromEntries(new URLSearchParams(buildFilterParams()))
      });
      const response = await fetch(`/api/admin/user-statistics/trends?${params}`);
      if (!response.ok) throw new Error('Failed to fetch trends');
      return response.json();
    }
  });

  // Fetch top users
  const { data: topUsers, isLoading: loadingTopUsers } = useQuery<TopUsersData>({
    queryKey: ["/api/admin/user-statistics/top-users", userTablePage, userTableSearch, userTableSort, userTableSortOrder, buildFilterParams()],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: '50',
        offset: ((userTablePage - 1) * 50).toString(),
        search: userTableSearch,
        sortBy: userTableSort,
        sortOrder: userTableSortOrder,
        ...Object.fromEntries(new URLSearchParams(buildFilterParams()))
      });
      const response = await fetch(`/api/admin/user-statistics/top-users?${params}`);
      if (!response.ok) throw new Error('Failed to fetch top users');
      return response.json();
    }
  });

  // Fetch user detail
  const { data: userDetail, isLoading: loadingUserDetail } = useQuery<UserDetail>({
    queryKey: ["/api/admin/user-statistics/user-detail", selectedUserId, buildFilterParams()],
    enabled: !!selectedUserId,
    queryFn: async () => {
      if (!selectedUserId) throw new Error('No user selected');
      const response = await fetch(`/api/admin/user-statistics/user-detail/${selectedUserId}?${buildFilterParams()}`);
      if (!response.ok) throw new Error('Failed to fetch user detail');
      return response.json();
    }
  });

  // Fetch cohorts
  const { data: cohorts, isLoading: loadingCohorts } = useQuery<CohortData>({
    queryKey: ["/api/admin/user-statistics/cohorts", cohortType, buildFilterParams()],
    queryFn: async () => {
      const params = new URLSearchParams({
        cohortType,
        ...Object.fromEntries(new URLSearchParams(buildFilterParams()))
      });
      const response = await fetch(`/api/admin/user-statistics/cohorts?${params}`);
      if (!response.ok) throw new Error('Failed to fetch cohorts');
      return response.json();
    }
  });

  // Calculate percentage change
  const calculateChange = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous) * 100;
  };

  // Format change percentage
  const formatChange = (change: number) => {
    const abs = Math.abs(change);
    const sign = change > 0 ? '+' : change < 0 ? '-' : '';
    return `${sign}${abs.toFixed(1)}%`;
  };

  // Get change icon
  const getChangeIcon = (change: number) => {
    if (change > 0) return <ArrowUpRight className="h-4 w-4 text-green-600" />;
    if (change < 0) return <ArrowDownRight className="h-4 w-4 text-red-600" />;
    return <Minus className="h-4 w-4 text-gray-600" />;
  };

  // Export functions
  const exportKPIs = () => {
    window.open(`/api/admin/user-statistics/export/kpis?${buildFilterParams()}`);
  };

  const exportTopUsers = () => {
    const params = new URLSearchParams({
      search: userTableSearch,
      sortBy: userTableSort,
      sortOrder: userTableSortOrder,
      ...Object.fromEntries(new URLSearchParams(buildFilterParams()))
    });
    window.open(`/api/admin/user-statistics/export/top-users?${params}`);
  };

  return (
    <div className="space-y-6" data-testid="user-statistics-page">
      {/* Header & Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            User Statistics & Analytics
          </CardTitle>
          <CardDescription>
            Comprehensive analytics dashboard for user behavior, engagement, and business metrics
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Date Range */}
          <div className="flex items-center gap-4">
            <Label>Date Range:</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-[280px] justify-start text-left">
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(startDate, "MMM dd, yyyy")} - {format(endDate, "MMM dd, yyyy")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="range"
                  selected={{ from: startDate, to: endDate }}
                  onSelect={(range) => {
                    if (range?.from) setStartDate(range.from);
                    if (range?.to) setEndDate(range.to);
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <Label>Plan Tiers</Label>
              <Select value={planTiers.join(',') || 'all'} onValueChange={(value) => setPlanTiers(value === 'all' ? [] : value.split(','))}>
                <SelectTrigger>
                  <SelectValue placeholder="All plans" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  <SelectItem value="free">Free</SelectItem>
                  <SelectItem value="pro_monthly">Pro Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <Label>Countries</Label>
              <Select value={countries.join(',') || 'all'} onValueChange={(value) => setCountries(value === 'all' ? [] : value.split(','))}>
                <SelectTrigger>
                  <SelectValue placeholder="All countries" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All countries</SelectItem>
                  <SelectItem value="US">United States</SelectItem>
                  <SelectItem value="CA">Canada</SelectItem>
                  <SelectItem value="UK">United Kingdom</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Acquisition Source</Label>
              <Select value={acquisitionSources.join(',') || 'all'} onValueChange={(value) => setAcquisitionSources(value === 'all' ? [] : value.split(','))}>
                <SelectTrigger>
                  <SelectValue placeholder="All sources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="organic">Organic</SelectItem>
                  <SelectItem value="referral">Referral</SelectItem>
                  <SelectItem value="campaign">Campaign</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Platforms</Label>
              <Select value={platforms.join(',') || 'all'} onValueChange={(value) => setPlatforms(value === 'all' ? [] : value.split(','))}>
                <SelectTrigger>
                  <SelectValue placeholder="All platforms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All platforms</SelectItem>
                  <SelectItem value="web">Web</SelectItem>
                  <SelectItem value="ios">iOS</SelectItem>
                  <SelectItem value="android">Android</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Feature Tags</Label>
              <Select value={featureTags.join(',') || 'all'} onValueChange={(value) => setFeatureTags(value === 'all' ? [] : value.split(','))}>
                <SelectTrigger>
                  <SelectValue placeholder="All features" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All features</SelectItem>
                  <SelectItem value="grid3">Grid3</SelectItem>
                  <SelectItem value="youtube">YouTube</SelectItem>
                  <SelectItem value="symbols">Symbols</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPIs Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
        {/* Total Users */}
        <Card data-testid="kpi-total-users">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Users</p>
                <p className="text-2xl font-bold">{loadingKPIs ? '...' : kpis?.totalUsers.toLocaleString()}</p>
              </div>
              <Users className="h-8 w-8 text-blue-600" />
            </div>
            {kpis && (
              <div className="flex items-center gap-1 mt-2">
                {getChangeIcon(calculateChange(kpis.totalUsers, kpis.previousPeriod.totalUsers))}
                <span className="text-sm text-muted-foreground">
                  {formatChange(calculateChange(kpis.totalUsers, kpis.previousPeriod.totalUsers))} vs previous period
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active Users */}
        <Card data-testid="kpi-active-users">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Active Users</p>
                <p className="text-2xl font-bold">{loadingKPIs ? '...' : kpis?.activeUsers.toLocaleString()}</p>
              </div>
              <Activity className="h-8 w-8 text-green-600" />
            </div>
            {kpis && (
              <div className="flex items-center gap-1 mt-2">
                {getChangeIcon(calculateChange(kpis.activeUsers, kpis.previousPeriod.activeUsers))}
                <span className="text-sm text-muted-foreground">
                  {formatChange(calculateChange(kpis.activeUsers, kpis.previousPeriod.activeUsers))} vs previous period
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* New Signups */}
        <Card data-testid="kpi-new-signups">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">New Signups</p>
                <p className="text-2xl font-bold">{loadingKPIs ? '...' : kpis?.newSignups.toLocaleString()}</p>
              </div>
              <UserPlus className="h-8 w-8 text-purple-600" />
            </div>
            {kpis && (
              <div className="flex items-center gap-1 mt-2">
                {getChangeIcon(calculateChange(kpis.newSignups, kpis.previousPeriod.newSignups))}
                <span className="text-sm text-muted-foreground">
                  {formatChange(calculateChange(kpis.newSignups, kpis.previousPeriod.newSignups))} vs previous period
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* DAU */}
        <Card data-testid="kpi-dau">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">DAU</p>
                <p className="text-2xl font-bold">{loadingKPIs ? '...' : kpis?.dau.toLocaleString()}</p>
              </div>
              <Clock className="h-8 w-8 text-orange-600" />
            </div>
            {kpis && (
              <div className="flex items-center gap-1 mt-2">
                {getChangeIcon(calculateChange(kpis.dau, kpis.previousPeriod.dau))}
                <span className="text-sm text-muted-foreground">
                  {formatChange(calculateChange(kpis.dau, kpis.previousPeriod.dau))} vs previous period
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* MAU */}
        <Card data-testid="kpi-mau">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">MAU</p>
                <p className="text-2xl font-bold">{loadingKPIs ? '...' : kpis?.mau.toLocaleString()}</p>
              </div>
              <TrendingUp className="h-8 w-8 text-red-600" />
            </div>
            {kpis && (
              <div className="flex items-center gap-1 mt-2">
                {getChangeIcon(calculateChange(kpis.mau, kpis.previousPeriod.mau))}
                <span className="text-sm text-muted-foreground">
                  {formatChange(calculateChange(kpis.mau, kpis.previousPeriod.mau))} vs previous period
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trends Chart */}
      <Card data-testid="trends-chart">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <LineChart className="h-5 w-5" />
                Trends Analysis
              </CardTitle>
              <CardDescription>Track key metrics over time with period-over-period comparison</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={selectedMetric} onValueChange={(value: any) => setSelectedMetric(value)}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newSignups">New Signups</SelectItem>
                  <SelectItem value="activeUsers">Active Users</SelectItem>
                  <SelectItem value="conversions">Conversions</SelectItem>
                  <SelectItem value="churns">Churns</SelectItem>
                  <SelectItem value="sessions">Sessions</SelectItem>
                </SelectContent>
              </Select>
              <Select value={trendGroupBy} onValueChange={(value: any) => setTrendGroupBy(value)}>
                <SelectTrigger className="w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingTrends ? (
            <div className="h-80 flex items-center justify-center">
              <div className="text-muted-foreground">Loading trends...</div>
            </div>
          ) : trends?.data ? (
            <ResponsiveContainer width="100%" height={320}>
              <RechartsLineChart data={trends.data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line 
                  type="monotone" 
                  dataKey="value" 
                  stroke="#2563eb" 
                  strokeWidth={2} 
                  name="Current Period" 
                />
                <Line 
                  type="monotone" 
                  dataKey="previousValue" 
                  stroke="#64748b" 
                  strokeWidth={2} 
                  strokeDasharray="5 5" 
                  name="Previous Period" 
                />
              </RechartsLineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-80 flex items-center justify-center">
              <div className="text-muted-foreground">No trend data available</div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top Users Table */}
      <Card data-testid="top-users-table">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Top Users Analysis
              </CardTitle>
              <CardDescription>Detailed user engagement metrics and behavior analysis</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search users..."
                  className="pl-8 w-[200px]"
                  value={userTableSearch}
                  onChange={(e) => setUserTableSearch(e.target.value)}
                  data-testid="input-user-search"
                />
              </div>
              <Button variant="outline" onClick={exportTopUsers} data-testid="button-export-top-users">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingTopUsers ? (
            <div className="flex items-center justify-center py-10">
              <div className="text-muted-foreground">Loading users...</div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Signup Date</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Generations</TableHead>
                  <TableHead>Downloads</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topUsers?.users?.map((user) => (
                  <TableRow key={user.userId} data-testid={`row-user-${user.userId}`}>
                    <TableCell className="font-medium">{user.email}</TableCell>
                    <TableCell>
                      <Badge variant={user.plan === 'free' ? 'secondary' : 'default'}>
                        {user.plan}
                      </Badge>
                    </TableCell>
                    <TableCell>{format(new Date(user.signupDate), 'MMM dd, yyyy')}</TableCell>
                    <TableCell>{user.lastSeen ? format(new Date(user.lastSeen), 'MMM dd, yyyy') : 'Never'}</TableCell>
                    <TableCell>{user.sessionsInRange}</TableCell>
                    <TableCell>{user.totalEventsInRange}</TableCell>
                    <TableCell>{user.keyActions.generations}</TableCell>
                    <TableCell>{user.keyActions.downloads}</TableCell>
                    <TableCell>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => setSelectedUserId(user.userId)}
                        data-testid={`button-view-user-${user.userId}`}
                      >
                        View Details
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          
          {/* Pagination */}
          {topUsers && (
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-muted-foreground">
                Showing {((userTablePage - 1) * 50) + 1} to {Math.min(userTablePage * 50, topUsers.total)} of {topUsers.total} users
              </div>
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  disabled={userTablePage === 1}
                  onClick={() => setUserTablePage(userTablePage - 1)}
                  data-testid="button-prev-page"
                >
                  Previous
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  disabled={userTablePage * 50 >= topUsers.total}
                  onClick={() => setUserTablePage(userTablePage + 1)}
                  data-testid="button-next-page"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* User Detail Modal/Panel */}
      {selectedUserId && (
        <Card data-testid="user-detail-panel">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>User Detail: {selectedUserId}</CardTitle>
              <Button variant="outline" onClick={() => setSelectedUserId(null)} data-testid="button-close-user-detail">
                Close
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loadingUserDetail ? (
              <div className="flex items-center justify-center py-10">
                <div className="text-muted-foreground">Loading user details...</div>
              </div>
            ) : userDetail ? (
              <div className="space-y-6">
                {/* User KPIs */}
                <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                  <Card>
                    <CardContent className="pt-4">
                      <div className="text-2xl font-bold">{userDetail.kpis.totalSessions}</div>
                      <div className="text-sm text-muted-foreground">Total Sessions</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <div className="text-2xl font-bold">{userDetail.kpis.totalEvents}</div>
                      <div className="text-sm text-muted-foreground">Total Events</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <div className="text-2xl font-bold">{Math.round(userDetail.kpis.totalTimeInApp / 1000 / 60)}m</div>
                      <div className="text-sm text-muted-foreground">Time in App</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <div className="text-2xl font-bold">{userDetail.kpis.generations}</div>
                      <div className="text-sm text-muted-foreground">Generations</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <div className="text-2xl font-bold">{userDetail.kpis.downloads}</div>
                      <div className="text-sm text-muted-foreground">Downloads</div>
                    </CardContent>
                  </Card>
                </div>

                {/* User Timeline */}
                <div>
                  <h4 className="text-lg font-semibold mb-4">Activity Timeline</h4>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {userDetail.timeline.map((event, index) => (
                      <div key={index} className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                        <div className="w-2 h-2 bg-blue-600 rounded-full"></div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{event.eventCategory}</Badge>
                            <span className="text-sm text-muted-foreground">
                              {format(new Date(event.date), 'MMM dd, yyyy HH:mm')}
                            </span>
                          </div>
                          <div className="text-sm mt-1">{event.details}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground">No user details available</div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Cohort Analysis */}
      <Card data-testid="cohort-analysis">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <PieChart className="h-5 w-5" />
                Cohort Analysis
              </CardTitle>
              <CardDescription>User retention analysis by signup cohorts</CardDescription>
            </div>
            <Select value={cohortType} onValueChange={(value: any) => setCohortType(value)}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loadingCohorts ? (
            <div className="flex items-center justify-center py-10">
              <div className="text-muted-foreground">Loading cohort analysis...</div>
            </div>
          ) : cohorts?.cohorts ? (
            <div className="space-y-4">
              {cohorts.cohorts.map((cohort, index) => (
                <div key={index} className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="font-semibold">Cohort: {cohort.cohortPeriod}</div>
                      <div className="text-sm text-muted-foreground">{cohort.totalUsers} users</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    {Object.entries(cohort.retentionRates).map(([period, rate]) => (
                      <div key={period} className="text-center">
                        <div className="text-2xl font-bold text-blue-600">{(rate * 100).toFixed(1)}%</div>
                        <div className="text-sm text-muted-foreground">{period} Retention</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground">No cohort data available</div>
          )}
        </CardContent>
      </Card>

      {/* Export Section */}
      <Card data-testid="export-section">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Export Data
          </CardTitle>
          <CardDescription>Download analytics data for external analysis</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Button onClick={exportKPIs} data-testid="button-export-kpis">
              <Download className="h-4 w-4 mr-2" />
              Export KPIs
            </Button>
            <Button onClick={exportTopUsers} data-testid="button-export-users">
              <Download className="h-4 w-4 mr-2" />
              Export Top Users
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default UserStatistics;