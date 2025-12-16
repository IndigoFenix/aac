import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, TrendingUp, Activity, CheckCircle2, CalendarIcon, Crown } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { Student } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

interface ClinicalMetrics {
  totalInterpretations: number;
  averageWPM: number | null;
  averageConfidence: number | null;
  acceptanceRate: number | null;
  feedbackCounts: {
    confirmed: number;
    corrected: number;
    rejected: number;
    noFeedback: number;
  };
}

export default function ClinicalDataPage() {
  const { toast } = useToast();
  const [selectedStudent, setSelectedStudent] = useState<string>("all");
  const [startDate, setStartDate] = useState<Date>();
  const [endDate, setEndDate] = useState<Date>();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Fetch user's AAC profiles
  const { data: studentsResponse, isLoading: isLoadingUsers } = useQuery<{
    success: boolean;
    students: Student[];
  }>({
    queryKey: ["/api/students"],
  });

  const students = studentsResponse?.students || [];

  // Build query params for filtering
  const buildQueryParams = () => {
    const params = new URLSearchParams();
    if (selectedStudent !== "all") {
      params.append("studentId", selectedStudent);
    }
    if (startDate) {
      params.append("startDate", startDate.toISOString());
    }
    if (endDate) {
      params.append("endDate", endDate.toISOString());
    }
    return params.toString();
  };

  // Fetch clinical metrics
  const {
    data: metricsResponse,
    isLoading: isLoadingMetrics,
    error: metricsError,
  } = useQuery<{ success: boolean; metrics: ClinicalMetrics }>({
    queryKey: ["/api/slp/clinical-metrics", selectedStudent, startDate, endDate],
    queryFn: async () => {
      const queryString = buildQueryParams();
      const response = await fetch(
        `/api/slp/clinical-metrics?${queryString}`,
        {
          credentials: "include",
        }
      );
      
      if (response.status === 403) {
        setShowUpgradeModal(true);
        throw new Error("Subscription required");
      }
      
      if (!response.ok) {
        throw new Error("Failed to fetch metrics");
      }
      
      return response.json();
    },
    retry: false,
  });

  const metrics = metricsResponse?.metrics;

  const handleExportCSV = async () => {
    setIsExporting(true);
    try {
      const queryString = buildQueryParams();
      const response = await fetch(`/api/slp/export-csv?${queryString}`, {
        credentials: "include",
      });

      if (response.status === 403) {
        setShowUpgradeModal(true);
        return;
      }

      if (!response.ok) {
        throw new Error("Export failed");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clinical-data-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Export successful",
        description: "Clinical data has been exported to CSV",
      });
    } catch (error) {
      console.error("Export error:", error);
      toast({
        title: "Export failed",
        description: "Failed to export clinical data",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleUpgrade = () => {
    window.location.href = "/purchase-credits";
  };

  // Show access denied message if there's an error
  if (metricsError && !showUpgradeModal) {
    return (
      <div className="container mx-auto p-4 max-w-6xl">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5" />
              Clinical Data Access Required
            </CardTitle>
            <CardDescription>
              This feature requires an SLP or Premium subscription
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-muted-foreground">
              Access comprehensive clinical analytics and export functionality for therapy tracking and reimbursement purposes.
            </p>
            <Button onClick={handleUpgrade} data-testid="button-upgrade-subscription">
              Upgrade Subscription
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2" data-testid="text-page-title">Clinical Data Dashboard</h1>
        <p className="text-muted-foreground">
          View and export clinical metrics for therapy tracking and reimbursement
        </p>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Filter clinical data by student and date range</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Student Selector */}
            <div>
              <label className="text-sm font-medium mb-2 block">Student</label>
              <Select value={selectedStudent} onValueChange={setSelectedStudent}>
                <SelectTrigger data-testid="select-student">
                  <SelectValue placeholder="Select AAC user" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Students</SelectItem>
                  {students?.map((student) => (
                    <SelectItem key={student.id} value={student.id}>
                      {student.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Start Date */}
            <div>
              <label className="text-sm font-medium mb-2 block">Start Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !startDate && "text-muted-foreground"
                    )}
                    data-testid="button-start-date"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {startDate ? format(startDate, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={startDate}
                    onSelect={setStartDate}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* End Date */}
            <div>
              <label className="text-sm font-medium mb-2 block">End Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !endDate && "text-muted-foreground"
                    )}
                    data-testid="button-end-date"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {endDate ? format(endDate, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={endDate}
                    onSelect={setEndDate}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Metrics Cards */}
      {isLoadingMetrics ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-3">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16 mb-2" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : metrics ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {/* Total Interpretations */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Total Sessions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="metric-total-interpretations">
                {metrics.totalInterpretations}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Interpretation sessions
              </p>
            </CardContent>
          </Card>

          {/* Average WPM */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                Average WPM
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="metric-average-wpm">
                {metrics.averageWPM !== null
                  ? metrics.averageWPM.toFixed(2)
                  : "N/A"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Words per minute
              </p>
            </CardContent>
          </Card>

          {/* Average Confidence */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Avg Confidence
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="metric-average-confidence">
                {metrics.averageConfidence !== null
                  ? `${(metrics.averageConfidence * 100).toFixed(1)}%`
                  : "N/A"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                AI confidence score
              </p>
            </CardContent>
          </Card>

          {/* Acceptance Rate */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                Acceptance Rate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="metric-acceptance-rate">
                {metrics.acceptanceRate !== null
                  ? `${metrics.acceptanceRate.toFixed(1)}%`
                  : "N/A"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Confirmed interpretations
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Feedback Distribution */}
      {metrics && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Caregiver Feedback Distribution</CardTitle>
            <CardDescription>Breakdown of interpretation feedback</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center p-4 bg-green-50 dark:bg-green-950 rounded-lg">
                <div className="text-2xl font-bold text-green-700 dark:text-green-300" data-testid="feedback-confirmed">
                  {metrics.feedbackCounts.confirmed}
                </div>
                <div className="text-sm text-muted-foreground mt-1">Confirmed</div>
              </div>
              <div className="text-center p-4 bg-yellow-50 dark:bg-yellow-950 rounded-lg">
                <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300" data-testid="feedback-corrected">
                  {metrics.feedbackCounts.corrected}
                </div>
                <div className="text-sm text-muted-foreground mt-1">Corrected</div>
              </div>
              <div className="text-center p-4 bg-red-50 dark:bg-red-950 rounded-lg">
                <div className="text-2xl font-bold text-red-700 dark:text-red-300" data-testid="feedback-rejected">
                  {metrics.feedbackCounts.rejected}
                </div>
                <div className="text-sm text-muted-foreground mt-1">Rejected</div>
              </div>
              <div className="text-center p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
                <div className="text-2xl font-bold text-gray-700 dark:text-gray-300" data-testid="feedback-no-feedback">
                  {metrics.feedbackCounts.noFeedback}
                </div>
                <div className="text-sm text-muted-foreground mt-1">No Feedback</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Export Button */}
      <Card>
        <CardHeader>
          <CardTitle>Export Data</CardTitle>
          <CardDescription>
            Download clinical data in CSV format for therapy documentation and reimbursement
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={handleExportCSV}
            disabled={isExporting || !metrics || metrics.totalInterpretations === 0}
            data-testid="button-export-csv"
            className="w-full sm:w-auto"
          >
            <Download className="mr-2 h-4 w-4" />
            {isExporting ? "Exporting..." : "Export to CSV"}
          </Button>
          {metrics && metrics.totalInterpretations === 0 && (
            <p className="text-sm text-muted-foreground mt-2">
              No data available to export. Try adjusting your filters.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Upgrade Modal */}
      <Dialog open={showUpgradeModal} onOpenChange={setShowUpgradeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-yellow-500" />
              Upgrade to Access Clinical Data
            </DialogTitle>
            <DialogDescription>
              Access comprehensive clinical analytics and export functionality for therapy tracking and reimbursement purposes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted p-4 rounded-lg">
              <h4 className="font-semibold mb-2">Premium Features Include:</h4>
              <ul className="space-y-2 text-sm">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  Comprehensive clinical metrics dashboard
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  CSV export for documentation
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  Advanced filtering by date and AAC user
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  Acceptance rate and WPM tracking
                </li>
              </ul>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleUpgrade}
                className="flex-1"
                data-testid="button-upgrade-modal"
              >
                Upgrade Now
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowUpgradeModal(false)}
                data-testid="button-cancel-upgrade"
              >
                Maybe Later
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
