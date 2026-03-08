import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Trash2, Mail, Building2, Briefcase, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/contexts/ThemeContext";

const ROLE_LABELS: Record<string, string> = {
  district_administrator: "District Administrator",
  special_education_director: "Special Education Director",
  speech_language_pathologist: "Speech-Language Pathologist",
  educator: "Educator",
  other: "Other",
};

interface ContactInquiry {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  organization: string;
  role: string;
  message: string | null;
  createdAt: string;
}

export function ContactInquiries() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: inquiries = [], isLoading } = useQuery<ContactInquiry[]>({
    queryKey: ["/api/admin/contacts"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/admin/contacts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts"] });
      setDeletingId(null);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Contact Inquiries</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {inquiries.length} {inquiries.length === 1 ? "inquiry" : "inquiries"}
        </p>
      </div>

      {inquiries.length === 0 ? (
        <Card className={cn(isDark && "bg-slate-900 border-slate-800")}>
          <CardContent className="py-12 text-center">
            <Mail className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground">No contact inquiries yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {inquiries.map((inquiry) => (
            <Card
              key={inquiry.id}
              className={cn(isDark && "bg-slate-900 border-slate-800")}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-lg">
                        {inquiry.firstName} {inquiry.lastName}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(inquiry.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Mail className="w-3.5 h-3.5" />
                        <a href={`mailto:${inquiry.email}`} className="hover:underline">
                          {inquiry.email}
                        </a>
                      </span>
                      <span className="flex items-center gap-1">
                        <Building2 className="w-3.5 h-3.5" />
                        {inquiry.organization}
                      </span>
                      <span className="flex items-center gap-1">
                        <Briefcase className="w-3.5 h-3.5" />
                        {ROLE_LABELS[inquiry.role] || inquiry.role}
                      </span>
                    </div>
                    {inquiry.message && (
                      <div className="mt-2 text-sm flex items-start gap-1.5">
                        <MessageSquare className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <span>{inquiry.message}</span>
                      </div>
                    )}
                  </div>
                  <div>
                    {deletingId === inquiry.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteMutation.mutate(inquiry.id)}
                          disabled={deleteMutation.isPending}
                        >
                          Confirm
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeletingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeletingId(inquiry.id)}
                      >
                        <Trash2 className="w-4 h-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
