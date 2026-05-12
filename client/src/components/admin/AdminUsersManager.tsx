import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/hooks/useAuth";
import {
  ADMIN_SECTIONS,
  ADMIN_WILDCARD_PERMISSION,
  type AdminSection,
} from "@shared/admin-sections";

interface AdminRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

const QUERY_KEY = ["/api/admin/admins"];

type FormState = {
  email: string;
  firstName: string;
  lastName: string;
  fullAccess: boolean;
  sections: Set<AdminSection>;
};

function emptyForm(): FormState {
  return {
    email: "",
    firstName: "",
    lastName: "",
    fullAccess: true,
    sections: new Set(),
  };
}

function formFromAdmin(admin: AdminRow): FormState {
  const fullAccess = admin.permissions.includes(ADMIN_WILDCARD_PERMISSION);
  const sections = new Set<AdminSection>();
  if (!fullAccess) {
    for (const p of admin.permissions) {
      if ((ADMIN_SECTIONS as readonly string[]).includes(p)) {
        sections.add(p as AdminSection);
      }
    }
  }
  return {
    email: admin.email ?? "",
    firstName: admin.firstName ?? "",
    lastName: admin.lastName ?? "",
    fullAccess,
    sections,
  };
}

function permissionsFromForm(form: FormState): string[] {
  if (form.fullAccess) return [ADMIN_WILDCARD_PERMISSION];
  return Array.from(form.sections);
}

export function AdminUsersManager() {
  const { t, isRTL } = useLanguage();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ success: boolean; admins: AdminRow[] }>({
    queryKey: QUERY_KEY,
    queryFn: async () => (await apiRequest("GET", "/api/admin/admins")).json(),
  });

  const createMutation = useMutation({
    mutationFn: async (payload: any) =>
      (await apiRequest("POST", "/api/admin/admins", payload)).json(),
    onSuccess: (result) => {
      if (!result?.success) {
        toast({
          title: t("common.error"),
          description: result?.message ?? t("admin.admins.errorGeneric"),
          variant: "destructive",
        });
        return;
      }
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setDialogOpen(false);
      toast({ title: t("admin.admins.createdToast") });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: any }) =>
      (await apiRequest("PATCH", `/api/admin/admins/${id}`, payload)).json(),
    onSuccess: (result) => {
      if (!result?.success) {
        toast({
          title: t("common.error"),
          description: result?.message ?? t("admin.admins.errorGeneric"),
          variant: "destructive",
        });
        return;
      }
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setDialogOpen(false);
      toast({ title: t("admin.admins.updatedToast") });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) =>
      (await apiRequest("DELETE", `/api/admin/admins/${id}`)).json(),
    onSuccess: (result) => {
      if (!result?.success) {
        toast({
          title: t("common.error"),
          description: result?.message ?? t("admin.admins.errorGeneric"),
          variant: "destructive",
        });
        return;
      }
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setConfirmDeleteId(null);
      toast({ title: t("admin.admins.deletedToast") });
    },
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEdit = (admin: AdminRow) => {
    setEditingId(admin.id);
    setForm(formFromAdmin(admin));
    setDialogOpen(true);
  };

  const submit = () => {
    const payload = {
      email: form.email.trim(),
      firstName: form.firstName.trim() || null,
      lastName: form.lastName.trim() || null,
      permissions: permissionsFromForm(form),
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const toggleSection = (section: AdminSection, checked: boolean) => {
    setForm((prev) => {
      const next = new Set(prev.sections);
      if (checked) next.add(section);
      else next.delete(section);
      return { ...prev, sections: next };
    });
  };

  const admins = data?.admins ?? [];
  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div dir={isRTL ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">{t("admin.admins.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("admin.admins.subtitle")}</p>
        </div>
        <Button onClick={openCreate} data-testid="admin-admins-add">
          <Plus className="w-4 h-4 me-2" />
          {t("admin.admins.addBtn")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin.admins.colEmail")}</TableHead>
              <TableHead>{t("admin.admins.colName")}</TableHead>
              <TableHead>{t("admin.admins.colPermissions")}</TableHead>
              <TableHead className="text-end">{t("admin.admins.colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.map((admin) => {
              const fullAccess = admin.permissions.includes(ADMIN_WILDCARD_PERMISSION);
              const isSelf = currentUser?.id === admin.id;
              return (
                <TableRow key={admin.id} data-testid={`admin-row-${admin.id}`}>
                  <TableCell className="font-medium">{admin.email}</TableCell>
                  <TableCell>
                    {[admin.firstName, admin.lastName].filter(Boolean).join(" ") || "—"}
                    {isSelf && (
                      <Badge variant="secondary" className="ms-2">
                        {t("admin.admins.youBadge")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {fullAccess ? (
                      <Badge>{t("admin.admins.fullAccess")}</Badge>
                    ) : admin.permissions.length === 0 ? (
                      <span className="text-muted-foreground">{t("admin.admins.noAccess")}</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {admin.permissions.map((p) => (
                          <Badge key={p} variant="outline">
                            {t(`admin.sections.${p}` as any) || p}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-end">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEdit(admin)}
                      data-testid={`admin-edit-${admin.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={isSelf}
                      title={isSelf ? t("admin.admins.cannotDeleteSelf") : undefined}
                      onClick={() => setConfirmDeleteId(admin.id)}
                      data-testid={`admin-delete-${admin.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t("admin.admins.editTitle") : t("admin.admins.addTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="admin-email">{t("admin.admins.fieldEmail")}</Label>
              <Input
                id="admin-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder={t("admin.admins.fieldEmailHint")}
                disabled={!!editingId}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="admin-firstName">{t("admin.admins.fieldFirstName")}</Label>
                <Input
                  id="admin-firstName"
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="admin-lastName">{t("admin.admins.fieldLastName")}</Label>
                <Input
                  id="admin-lastName"
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("admin.admins.fieldPermissions")}</Label>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="admin-full"
                  checked={form.fullAccess}
                  onCheckedChange={(c) =>
                    setForm({ ...form, fullAccess: c === true })
                  }
                />
                <Label htmlFor="admin-full" className="cursor-pointer">
                  {t("admin.admins.fullAccess")}
                </Label>
              </div>
              {!form.fullAccess && (
                <div className="grid grid-cols-2 gap-2 pt-2 ps-6">
                  {ADMIN_SECTIONS.filter((s) => s !== "admins").map((section) => (
                    <div key={section} className="flex items-center gap-2">
                      <Checkbox
                        id={`admin-section-${section}`}
                        checked={form.sections.has(section)}
                        onCheckedChange={(c) => toggleSection(section, c === true)}
                      />
                      <Label
                        htmlFor={`admin-section-${section}`}
                        className="cursor-pointer text-sm"
                      >
                        {t(`admin.sections.${section}` as any) || section}
                      </Label>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="admin-section-admins"
                      checked={form.sections.has("admins")}
                      onCheckedChange={(c) => toggleSection("admins", c === true)}
                    />
                    <Label htmlFor="admin-section-admins" className="cursor-pointer text-sm">
                      {t("admin.sections.admins")}
                    </Label>
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submit} disabled={saving || !form.email.includes("@")}>
              {saving && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!confirmDeleteId}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin.admins.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.admins.deleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeleteId && deleteMutation.mutate(confirmDeleteId)}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
