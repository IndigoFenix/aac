import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';
import { Users, FileText, TrendingUp, Clock, Download, Target, Filter, Calendar, ArrowDown, ArrowUp, Eye } from "lucide-react";
import { format, subDays, startOfDay, endOfDay } from 'date-fns';

interface AnalyticsData {
  kpis: {
    totalPrompts: number;
    uniqueUsers: number;
    boardsGenerated: number;
    pagesCreated: number;
    downloads: number;
    successRate: number;
    avgPagesPerBoard: number;
    avgProcessingTime: number;
  };
  timeSeriesData: Array<{
    date: string;
    prompts: number;
    boards: number;
    downloads: number;
  }>;
  topTopics: Array<{
    topic: string;
    prompts: number;
    boards: number;
    conversionRate: number;
    avgPages: number;
    lastUsed: string;
  }>;
  recentPrompts: Array<{
    id: string;
    userId: string;
    prompt: string;
    promptExcerpt: string;
    topic: string;
    language: string;
    model: string;
    pagesGenerated: number;
    success: boolean;
    downloaded: boolean;
    processingTimeMs: number;
    createdAt: string;
    user: {
      email: string;
    };
  }>;
  funnelData: {
    promptsCreated: number;
    boardsGenerated: number;
    downloaded: number;
  };
}

interface Filters {
  dateRange: 'last7days' | 'last30days' | 'last90days' | 'custom';
  startDate?: string;
  endDate?: string;
  topics: string[];
  users: string[];
  models: string[];
  languages: string[];
}

export default function AdminOverview() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<Filters>({
    dateRange: 'last30days',
    topics: [],
    users: [],
    models: [],
    languages: []
  });

  const [selectedPrompt, setSelectedPrompt] = useState<any>(null);

  // Auto-calculate date range based on selection
  useEffect(() => {
    if (filters.dateRange !== 'custom') {
      const now = new Date();
      let days = 30;
      if (filters.dateRange === 'last7days') days = 7;
      if (filters.dateRange === 'last90days') days = 90;
      
      setFilters(prev => ({
        ...prev,
        startDate: format(subDays(now, days), 'yyyy-MM-dd'),
        endDate: format(now, 'yyyy-MM-dd')
      }));
    }
  }, [filters.dateRange]);

  // Build query string for API
  const buildQueryString = () => {
    const params = new URLSearchParams();
    if (filters.startDate) params.append('startDate', filters.startDate);
    if (filters.endDate) params.append('endDate', filters.endDate);
    if (filters.topics.length) params.append('topics', filters.topics.join(','));
    if (filters.users.length) params.append('users', filters.users.join(','));
    if (filters.models.length) params.append('models', filters.models.join(','));
    if (filters.languages.length) params.append('languages', filters.languages.join(','));
    return params.toString();
  };

  // Fetch analytics data
  const { data: analytics, isLoading, error } = useQuery<AnalyticsData>({
    queryKey: ['/api/admin/analytics', buildQueryString()],
    queryFn: async () => {
      const response = await fetch(`/api/admin/analytics?${buildQueryString()}`);
      if (!response.ok) throw new Error('Failed to fetch analytics');
      return response.json();
    },
    refetchInterval: 30000 // Refresh every 30 seconds
  });

  const resetFilters = () => {
    setFilters({
      dateRange: 'last30days',
      topics: [],
      users: [],
      models: [],
      languages: []
    });
  };

  const funnelPercentages = analytics ? {
    boardGeneration: analytics.funnelData.promptsCreated > 0 
      ? Math.round((analytics.funnelData.boardsGenerated / analytics.funnelData.promptsCreated) * 100) 
      : 0,
    downloadRate: analytics.funnelData.boardsGenerated > 0 
      ? Math.round((analytics.funnelData.downloaded / analytics.funnelData.boardsGenerated) * 100) 
      : 0
  } : { boardGeneration: 0, downloadRate: 0 };

  if (error) {
    return <div className="text-red-500 p-6">Error loading analytics: {(error as Error).message}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Analytics Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <Select value={filters.dateRange} onValueChange={(value: any) => setFilters(prev => ({ ...prev, dateRange: value }))}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="last7days">Last 7 days</SelectItem>
                  <SelectItem value="last30days">Last 30 days</SelectItem>
                  <SelectItem value="last90days">Last 90 days</SelectItem>
                  <SelectItem value="custom">Custom range</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {filters.dateRange === 'custom' && (
              <>
                <Input
                  type="date"
                  placeholder="Start date"
                  value={filters.startDate || ''}
                  onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value }))}
                  className="w-40"
                />
                <Input
                  type="date"
                  placeholder="End date"
                  value={filters.endDate || ''}
                  onChange={(e) => setFilters(prev => ({ ...prev, endDate: e.target.value }))}
                  className="w-40"
                />
              </>
            )}

            <Button onClick={resetFilters} variant="outline" size="sm">
              Reset Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[...Array(8)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-4 bg-gray-200 rounded mb-2"></div>
                <div className="h-8 bg-gray-200 rounded mb-2"></div>
                <div className="h-3 bg-gray-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Prompts</CardTitle>
                <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{analytics?.kpis.totalPrompts || 0}</div>
                <p className="text-xs text-muted-foreground">
                  {analytics?.kpis.uniqueUsers || 0} unique users
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Boards Generated</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{analytics?.kpis.boardsGenerated || 0}</div>
                <p className="text-xs text-muted-foreground">
                  {analytics?.kpis.successRate || 0}% success rate
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Pages Created</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{analytics?.kpis.pagesCreated || 0}</div>
                <p className="text-xs text-muted-foreground">
                  {analytics?.kpis.avgPagesPerBoard || 0} avg per board
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Downloads</CardTitle>
                <Download className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{analytics?.kpis.downloads || 0}</div>
                <p className="text-xs text-muted-foreground">
                  {analytics?.kpis.avgProcessingTime || 0}ms avg time
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Time Series Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Activity Over Time</CardTitle>
                <CardDescription>Daily prompts, boards, and downloads</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={analytics?.timeSeriesData || []}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="prompts" stroke="#8884d8" name="Prompts" />
                      <Line type="monotone" dataKey="boards" stroke="#82ca9d" name="Boards" />
                      <Line type="monotone" dataKey="downloads" stroke="#ffc658" name="Downloads" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Funnel Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Conversion Funnel</CardTitle>
                <CardDescription>User journey from prompt to download</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-blue-50 rounded-lg">
                    <div>
                      <div className="font-semibold">Prompts Created</div>
                      <div className="text-2xl font-bold">{analytics?.funnelData.promptsCreated || 0}</div>
                    </div>
                    <div className="text-blue-600">
                      <Target className="h-6 w-6" />
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-center">
                    <ArrowDown className="h-4 w-4 text-gray-400" />
                    <span className="mx-2 text-sm text-gray-500">{funnelPercentages.boardGeneration}%</span>
                    <ArrowDown className="h-4 w-4 text-gray-400" />
                  </div>

                  <div className="flex items-center justify-between p-4 bg-green-50 rounded-lg">
                    <div>
                      <div className="font-semibold">Boards Generated</div>
                      <div className="text-2xl font-bold">{analytics?.funnelData.boardsGenerated || 0}</div>
                    </div>
                    <div className="text-green-600">
                      <FileText className="h-6 w-6" />
                    </div>
                  </div>

                  <div className="flex items-center justify-center">
                    <ArrowDown className="h-4 w-4 text-gray-400" />
                    <span className="mx-2 text-sm text-gray-500">{funnelPercentages.downloadRate}%</span>
                    <ArrowDown className="h-4 w-4 text-gray-400" />
                  </div>

                  <div className="flex items-center justify-between p-4 bg-orange-50 rounded-lg">
                    <div>
                      <div className="font-semibold">Downloaded</div>
                      <div className="text-2xl font-bold">{analytics?.funnelData.downloaded || 0}</div>
                    </div>
                    <div className="text-orange-600">
                      <Download className="h-6 w-6" />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Top Topics Table */}
          <Card>
            <CardHeader>
              <CardTitle>Top Communication Topics</CardTitle>
              <CardDescription>Most frequently requested board topics</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Topic</TableHead>
                    <TableHead className="text-right">Prompts</TableHead>
                    <TableHead className="text-right">Boards</TableHead>
                    <TableHead className="text-right">Success Rate</TableHead>
                    <TableHead className="text-right">Avg Pages</TableHead>
                    <TableHead>Last Used</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics?.topTopics.map((topic) => (
                    <TableRow key={topic.topic}>
                      <TableCell className="font-medium">
                        <Badge variant="outline">{topic.topic}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{topic.prompts}</TableCell>
                      <TableCell className="text-right">{topic.boards}</TableCell>
                      <TableCell className="text-right">{topic.conversionRate}%</TableCell>
                      <TableCell className="text-right">{topic.avgPages}</TableCell>
                      <TableCell>{format(new Date(topic.lastUsed), 'MMM dd, yyyy')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Recent Prompts Table with Detail Drawer */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Prompt Activity</CardTitle>
              <CardDescription>Latest 100 prompts with detailed information</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Topic</TableHead>
                    <TableHead>Prompt Excerpt</TableHead>
                    <TableHead>Pages</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics?.recentPrompts.slice(0, 20).map((prompt) => (
                    <TableRow key={prompt.id}>
                      <TableCell className="font-medium">{prompt.user.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{prompt.topic}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate">{prompt.promptExcerpt}</TableCell>
                      <TableCell>{prompt.pagesGenerated}</TableCell>
                      <TableCell>
                        <Badge className={prompt.success ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}>
                          {prompt.success ? 'Success' : 'Failed'}
                        </Badge>
                      </TableCell>
                      <TableCell>{prompt.processingTimeMs}ms</TableCell>
                      <TableCell>{format(new Date(prompt.createdAt), 'MMM dd, HH:mm')}</TableCell>
                      <TableCell>
                        <Sheet>
                          <SheetTrigger asChild>
                            <Button variant="ghost" size="sm" onClick={() => setSelectedPrompt(prompt)}>
                              <Eye className="h-4 w-4" />
                            </Button>
                          </SheetTrigger>
                          <SheetContent className="w-96 sm:w-1/2">
                            <SheetHeader>
                              <SheetTitle>Prompt Details</SheetTitle>
                              <SheetDescription>
                                Full information about this prompt and its processing
                              </SheetDescription>
                            </SheetHeader>
                            {selectedPrompt && (
                              <div className="mt-6 space-y-4">
                                <div>
                                  <label className="text-sm font-medium">User</label>
                                  <p className="text-sm text-gray-600">{selectedPrompt.user.email}</p>
                                </div>
                                <div>
                                  <label className="text-sm font-medium">Full Prompt</label>
                                  <p className="text-sm text-gray-600 p-3 bg-gray-50 rounded border max-h-40 overflow-y-auto">
                                    {selectedPrompt.prompt}
                                  </p>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                  <div>
                                    <label className="text-sm font-medium">Topic</label>
                                    <p className="text-sm text-gray-600">{selectedPrompt.topic}</p>
                                  </div>
                                  <div>
                                    <label className="text-sm font-medium">Language</label>
                                    <p className="text-sm text-gray-600">{selectedPrompt.language}</p>
                                  </div>
                                  <div>
                                    <label className="text-sm font-medium">Model</label>
                                    <p className="text-sm text-gray-600">{selectedPrompt.model}</p>
                                  </div>
                                  <div>
                                    <label className="text-sm font-medium">Pages Generated</label>
                                    <p className="text-sm text-gray-600">{selectedPrompt.pagesGenerated}</p>
                                  </div>
                                  <div>
                                    <label className="text-sm font-medium">Processing Time</label>
                                    <p className="text-sm text-gray-600">{selectedPrompt.processingTimeMs}ms</p>
                                  </div>
                                  <div>
                                    <label className="text-sm font-medium">Downloaded</label>
                                    <p className="text-sm text-gray-600">{selectedPrompt.downloaded ? 'Yes' : 'No'}</p>
                                  </div>
                                </div>
                              </div>
                            )}
                          </SheetContent>
                        </Sheet>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}