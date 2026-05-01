// src/components/admin/CrmCustomerDetail.tsx
// Detail view for a single CRM landing-page visitor.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  Save,
  RotateCcw,
  Ban,
  Unlock,
  Trash2,
  Eye,
  X,
} from "lucide-react";
import {
  useCrmCustomer,
  useCrmCustomerMutations,
  useCrmSessionLog,
} from "@/hooks/useAdminData";

interface CrmCustomerDetailProps {
  customerId: string;
}

function formatDate(value: string | number | undefined | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface MemoryFormState {
  firstName: string;
  lastName: string;
  email: string;
  organization: string;
  role: string;
}

const EMPTY_FORM: MemoryFormState = {
  firstName: "",
  lastName: "",
  email: "",
  organization: "",
  role: "",
};

export function CrmCustomerDetail({ customerId }: CrmCustomerDetailProps) {
  const [, navigate] = useLocation();
  const { data, isLoading, error } = useCrmCustomer(customerId);
  const { updateCustomer, deleteCustomer } = useCrmCustomerMutations();

  const [form, setForm] = useState<MemoryFormState>(EMPTY_FORM);
  const [logSessionId, setLogSessionId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const customer = data?.customer;
  const sessions = data?.sessions ?? [];

  // Sync form whenever the customer payload changes (initial load + after save).
  useEffect(() => {
    if (!customer) return;
    setForm({
      firstName: customer.firstName ?? "",
      lastName: customer.lastName ?? "",
      email: customer.email ?? "",
      organization: customer.organization ?? "",
      role: customer.role ?? "",
    });
  }, [customer]);

  const dirty = useMemo(() => {
    if (!customer) return false;
    return (
      form.firstName !== (customer.firstName ?? "") ||
      form.lastName !== (customer.lastName ?? "") ||
      form.email !== (customer.email ?? "") ||
      form.organization !== (customer.organization ?? "") ||
      form.role !== (customer.role ?? "")
    );
  }, [customer, form]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={() => navigate("/admin/crm")}>
          <ArrowLeft className="w-4 h-4 me-2" />
          Back
        </Button>
        <div className="flex items-center gap-2 text-destructive py-8">
          <AlertCircle className="w-5 h-5" />
          <span>Customer not found.</span>
        </div>
      </div>
    );
  }

  const headerName =
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
    customer.email ||
    `Anonymous · ${customer.id.slice(0, 8)}`;

  const handleSaveMemory = () => {
    // Send the diff as a memory patch — empty strings clear the field at the
    // server. The repository merges these into chat_memory under the
    // Customer_* keys.
    const memory: Record<string, any> = {};
    memory.Customer_FirstName = form.firstName;
    memory.Customer_LastName = form.lastName;
    memory.Customer_Email = form.email;
    memory.Customer_Organization = form.organization;
    memory.Customer_Role = form.role;
    updateCustomer.mutate({ id: customer.id, patch: { memory } });
  };

  const handleResetMemory = () => {
    setForm({
      firstName: customer.firstName ?? "",
      lastName: customer.lastName ?? "",
      email: customer.email ?? "",
      organization: customer.organization ?? "",
      role: customer.role ?? "",
    });
  };

  const handleToggleBlock = () => {
    updateCustomer.mutate({
      id: customer.id,
      patch: { isBlocked: !customer.isBlocked },
    });
  };

  const handleDelete = () => {
    deleteCustomer.mutate(customer.id, {
      onSuccess: () => navigate("/admin/crm"),
    });
  };

  const handleClearScratchpad = () => {
    updateCustomer.mutate({
      id: customer.id,
      patch: { memory: { Customer_Scratchpad: "" } },
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/admin/crm")}
          className="mb-3 -ms-2"
          data-testid="crm-detail-back"
        >
          <ArrowLeft className="w-4 h-4 me-2" />
          Back to customers
        </Button>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2 flex-wrap">
              {headerName}
              {customer.isBlocked && (
                <Badge variant="destructive" className="text-xs gap-1">
                  <Ban className="w-3 h-3" />
                  Blocked
                </Badge>
              )}
              {customer.countryCode && (
                <Badge variant="outline" className="text-xs">
                  {customer.countryCode}
                </Badge>
              )}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              First seen {formatDate(customer.firstSeenAt)} · Last seen {formatDate(customer.lastSeenAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={customer.isBlocked ? "outline" : "secondary"}
              size="sm"
              onClick={handleToggleBlock}
              disabled={updateCustomer.isPending}
              data-testid="crm-detail-toggle-block"
            >
              {customer.isBlocked ? (
                <><Unlock className="w-4 h-4 me-2" />Unblock</>
              ) : (
                <><Ban className="w-4 h-4 me-2" />Block</>
              )}
            </Button>
            {confirmingDelete ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleteCustomer.isPending}
                  data-testid="crm-detail-confirm-delete"
                >
                  {deleteCustomer.isPending ? (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4 me-2" />
                  )}
                  Confirm delete
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmingDelete(true)}
                data-testid="crm-detail-delete"
              >
                <Trash2 className="w-4 h-4 me-2 text-destructive" />
                Delete
              </Button>
            )}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="crm-first-name">First name</Label>
              <Input
                id="crm-first-name"
                value={form.firstName}
                onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                data-testid="crm-detail-first-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="crm-last-name">Last name</Label>
              <Input
                id="crm-last-name"
                value={form.lastName}
                onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                data-testid="crm-detail-last-name"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="crm-email">Email</Label>
              <Input
                id="crm-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                data-testid="crm-detail-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="crm-org">Organization</Label>
              <Input
                id="crm-org"
                value={form.organization}
                onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value }))}
                data-testid="crm-detail-organization"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="crm-role">Role</Label>
              <Input
                id="crm-role"
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                data-testid="crm-detail-role"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetMemory}
              disabled={!dirty || updateCustomer.isPending}
            >
              <RotateCcw className="w-4 h-4 me-2" />
              Reset
            </Button>
            <Button
              size="sm"
              onClick={handleSaveMemory}
              disabled={!dirty || updateCustomer.isPending}
              data-testid="crm-detail-save"
            >
              {updateCustomer.isPending ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 me-2" />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-lg">Scratchpad</CardTitle>
            {customer.scratchpad && customer.scratchpad.trim().length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearScratchpad}
                disabled={updateCustomer.isPending}
                data-testid="crm-detail-clear-scratchpad"
              >
                <X className="w-4 h-4 me-1" />
                Clear
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!customer.scratchpad || customer.scratchpad.trim().length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Empty. The AI updates this scratchpad as the visitor shares pain points and context.
            </p>
          ) : (
            <pre className="text-sm whitespace-pre-wrap break-words bg-muted/40 rounded-md px-3 py-2 font-sans">
              {customer.scratchpad}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sessions ({sessions.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6">
              No chat sessions yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{formatDate(s.started)}</TableCell>
                    <TableCell>{formatDate(s.lastUpdate)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      ${s.creditsUsed.toFixed(4)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setLogSessionId(s.id)}
                        aria-label="View session log"
                        data-testid={`crm-detail-view-log-${s.id}`}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Raw Memory</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            readOnly
            value={JSON.stringify(customer.memory, null, 2)}
            className="font-mono text-xs h-48"
          />
        </CardContent>
      </Card>

      <CrmSessionLogDialog
        sessionId={logSessionId}
        onClose={() => setLogSessionId(null)}
      />
    </div>
  );
}

interface CrmSessionLogDialogProps {
  sessionId: string | null;
  onClose: () => void;
}

function CrmSessionLogDialog({ sessionId, onClose }: CrmSessionLogDialogProps) {
  const open = sessionId !== null;
  const { data, isLoading } = useCrmSessionLog(sessionId ?? undefined);
  const messages = data?.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Session Log</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No messages in this session.
          </p>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto pr-4">
            {messages.map((msg, i) => (
              <CrmLogMessage key={i} msg={msg} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CrmLogMessage({ msg }: { msg: any }) {
  const role = msg.role || "unknown";
  let content: string;
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (msg.content && typeof msg.content === "object") {
    content = msg.content.text ?? msg.content.md ?? msg.content.html ?? JSON.stringify(msg.content);
  } else if (msg.toolCalls?.length) {
    content = msg.toolCalls
      .map((tc: any) => `${tc.name}(${tc.arguments ?? ""})`)
      .join("\n");
  } else {
    content = "";
  }

  return (
    <div className="flex gap-2 py-2 border-b last:border-b-0">
      <Badge
        variant={role === "user" ? "default" : role === "tool" ? "outline" : "secondary"}
        className="h-5 text-xs shrink-0"
      >
        {role}
      </Badge>
      <div className="flex-1 min-w-0">
        <p className="text-sm whitespace-pre-wrap break-words">{content || "—"}</p>
        {msg.timestamp && (
          <p className="text-xs text-muted-foreground mt-1">{formatDate(msg.timestamp)}</p>
        )}
      </div>
    </div>
  );
}
