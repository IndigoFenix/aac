import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  DollarSign, 
  TrendingUp, 
  Activity, 
  Target, 
  Calendar,
  RefreshCw,
  Download,
  Filter
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from "recharts";

interface CostAnalytics {
  overview: {
    totalCostToday: number;
    totalCostThisMonth: number;
    totalCalls: number;
    averageCostPerCall: number;
    successRate: number;
  };
  dailyTrends: Array<{
    date: string;
    totalCost: number;
    callCount: number;
    averageCost: number;
  }>;
  providerBreakdown: Array<{
    provider: string;
    model: string;
    totalCost: number;
    callCount: number;
    averageCost: number;
    successRate: number;
  }>;
  topUsers: Array<{
    userId: string;
    userEmail: string;
    totalCost: number;
    callCount: number;
  }>;
  recentCalls: Array<{
    id: string;
    provider: string;
    model: string;
    endpoint: string;
    totalCostUsd: string;
    inputTokens: number;
    outputTokens: number;
    success: boolean;
    createdAt: string;
    userEmail: string;
  }>;
}

interface CostSummary {
  totalCost: number;
  callCount: number;
  averageCostPerCall: number;
  dailyAverage: number;
  topProvider: string;
  projectedMonthlyCost: number;
}

const CHART_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

export default function CostAnalyticsDashboard() {
  const [dateFilter, setDateFilter] = useState("30");
  const [providerFilter, setProviderFilter] = useState("all");

  // Fetch cost analytics data
  const { data: analytics, isLoading: analyticsLoading, refetch: refetchAnalytics } = useQuery<CostAnalytics>({
    queryKey: ["/api/admin/cost-analytics", dateFilter, providerFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFilter !== "all") {
        const days = parseInt(dateFilter);
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
        params.append("startDate", startDate.toISOString());
        params.append("endDate", endDate.toISOString());
      }
      if (providerFilter !== "all") {
        params.append("provider", providerFilter);
      }
      
      const response = await fetch(`/api/admin/cost-analytics?${params}`);
      if (!response.ok) throw new Error('Failed to fetch analytics');
      return response.json();
    },
    refetchInterval: 60000 // Refresh every minute
  });

  // Fetch cost summary
  const { data: summary } = useQuery<CostSummary>({
    queryKey: ["/api/admin/cost-summary", dateFilter],
    queryFn: async () => {
      const days = dateFilter === "all" ? 30 : parseInt(dateFilter);
      const response = await fetch(`/api/admin/cost-summary?days=${days}`);
      if (!response.ok) throw new Error('Failed to fetch summary');
      return response.json();
    }
  });

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  };

  const exportData = () => {
    if (!analytics) return;
    
    const exportContent = {
      overview: analytics.overview,
      dailyTrends: analytics.dailyTrends,
      providerBreakdown: analytics.providerBreakdown,
      topUsers: analytics.topUsers,
      exportedAt: new Date().toISOString()
    };
    
    const blob = new Blob([JSON.stringify(exportContent, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cost-analytics-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (analyticsLoading) {
    return (
      <div className="space-y-6" data-testid="cost-analytics-loading">
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-border" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="cost-analytics-dashboard">
      {/* Header with Filters */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">API Cost Analytics</h2>
          <p className="text-muted-foreground">Monitor API usage costs and trends</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Label htmlFor="date-filter">Time Period:</Label>
            <Select value={dateFilter} onValueChange={setDateFilter}>
              <SelectTrigger className="w-32" id="date-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div className="flex items-center gap-2">
            <Label htmlFor="provider-filter">Provider:</Label>
            <Select value={providerFilter} onValueChange={setProviderFilter}>
              <SelectTrigger className="w-32" id="provider-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Providers</SelectItem>
                <SelectItem value="gemini">Gemini</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button onClick={() => refetchAnalytics()} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          
          <Button onClick={exportData} variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card data-testid="cost-today-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Today's Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(analytics?.overview.totalCostToday || 0)}</div>
          </CardContent>
        </Card>

        <Card data-testid="cost-month-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">This Month</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(analytics?.overview.totalCostThisMonth || 0)}</div>
          </CardContent>
        </Card>

        <Card data-testid="total-calls-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total API Calls</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{analytics?.overview.totalCalls?.toLocaleString() || 0}</div>
          </CardContent>
        </Card>

        <Card data-testid="avg-cost-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Cost/Call</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(analytics?.overview.averageCostPerCall || 0)}</div>
          </CardContent>
        </Card>

        <Card data-testid="success-rate-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{(analytics?.overview.successRate || 0).toFixed(1)}%</div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Daily Cost Trends */}
        <Card data-testid="daily-trends-chart">
          <CardHeader>
            <CardTitle>Daily Cost Trends</CardTitle>
            <CardDescription>API costs over time</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={analytics?.dailyTrends || []}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="date" 
                  tickFormatter={formatDate}
                  tick={{ fontSize: 12 }}
                />
                <YAxis tickFormatter={(value) => `$${value.toFixed(3)}`} />
                <Tooltip 
                  formatter={(value: number) => [formatCurrency(value), 'Cost']}
                  labelFormatter={(label) => new Date(label).toLocaleDateString()}
                />
                <Line 
                  type="monotone" 
                  dataKey="totalCost" 
                  stroke="#3B82F6" 
                  strokeWidth={2}
                  dot={{ fill: '#3B82F6', strokeWidth: 2, r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Provider Breakdown */}
        <Card data-testid="provider-breakdown-chart">
          <CardHeader>
            <CardTitle>Provider Cost Distribution</CardTitle>
            <CardDescription>Cost breakdown by provider and model</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={analytics?.providerBreakdown || []}
                  dataKey="totalCost"
                  nameKey="provider"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={(entry) => `${entry.provider}: ${formatCurrency(entry.totalCost)}`}
                >
                  {analytics?.providerBreakdown.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Tables */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Provider Breakdown Table */}
        <Card data-testid="provider-breakdown-table">
          <CardHeader>
            <CardTitle>Provider Performance</CardTitle>
            <CardDescription>Detailed breakdown by provider and model</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Success Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analytics?.providerBreakdown.map((provider, index) => (
                  <TableRow key={index}>
                    <TableCell className="font-medium">{provider.provider}</TableCell>
                    <TableCell>{provider.model}</TableCell>
                    <TableCell className="text-right">{formatCurrency(provider.totalCost)}</TableCell>
                    <TableCell className="text-right">{provider.callCount}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={provider.successRate > 95 ? "default" : "secondary"}>
                        {provider.successRate.toFixed(1)}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Top Users */}
        <Card data-testid="top-users-table">
          <CardHeader>
            <CardTitle>Top Users by Cost</CardTitle>
            <CardDescription>Users with highest API costs</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                  <TableHead className="text-right">API Calls</TableHead>
                  <TableHead className="text-right">Avg/Call</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analytics?.topUsers.map((user, index) => (
                  <TableRow key={index}>
                    <TableCell className="font-medium">{user.userEmail}</TableCell>
                    <TableCell className="text-right">{formatCurrency(user.totalCost)}</TableCell>
                    <TableCell className="text-right">{user.callCount}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(user.callCount > 0 ? user.totalCost / user.callCount : 0)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Recent API Calls */}
      <Card data-testid="recent-calls-table">
        <CardHeader>
          <CardTitle>Recent API Calls</CardTitle>
          <CardDescription>Latest API requests with cost details</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Input Tokens</TableHead>
                <TableHead className="text-right">Output Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics?.recentCalls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell className="font-medium">{call.provider}</TableCell>
                  <TableCell>{call.model}</TableCell>
                  <TableCell>{call.userEmail}</TableCell>
                  <TableCell className="text-right">{call.inputTokens.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{call.outputTokens.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{formatCurrency(parseFloat(call.totalCostUsd))}</TableCell>
                  <TableCell>
                    <Badge variant={call.success ? "default" : "destructive"}>
                      {call.success ? "Success" : "Failed"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {new Date(call.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}