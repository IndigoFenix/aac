// client/src/components/venue-menus/MenuReviewCard.tsx
//
// CARETAKER REVIEW for captured restaurant menus.
//
// A menu photographed at the table lands as `pending_review`. Nothing reaches
// the student until a human has looked at it — this is that surface.
//
// Why review exists at all: a menu board that offers a dish the restaurant does
// not serve walks a nonverbal child into a dead end they cannot talk their way
// out of. Extraction is good, not perfect, so a person confirms it once. Only
// menus for venues THIS student is linked to appear here.
//
// Self-contained on purpose — mounted by AACSettingsPanel with one line rather
// than growing that 3,000-line file further.
//
// See planning-docs/aac-restaurant-menus.md §3, §4.8.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Check, X, Loader2, Utensils, AlertTriangle, Trash2 } from 'lucide-react';

/** One row of a captured menu, as `applyMenuRefinement` left it. */
interface MenuItem {
  name: string;
  description?: string;
  price?: number;
  priceText?: string;
  category?: string;
  kind: 'food' | 'drink' | 'condiment' | 'notice' | 'unknown';
  imageKey?: string;
  translatedName?: string;
}

interface PendingMenu {
  menu: {
    id: string;
    venueId: string;
    language: string;
    currency?: string | null;
    items: MenuItem[];
    provenance: string;
    bindingBasis: string;
    bindingBranchMatch: string;
    extractedAt: string;
  };
  venue: {
    id: string;
    name: string;
    address?: string | null;
  };
}

interface MenuReviewCardProps {
  studentId: string;
}

export function MenuReviewCard({ studentId }: MenuReviewCardProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  /** Which menu is expanded. Only one at a time — reviewing is a focused task. */
  const [openId, setOpenId] = useState<string | null>(null);
  /** Local edits, keyed by menu id, so switching menus does not lose them. */
  const [edits, setEdits] = useState<Record<string, MenuItem[]>>({});

  const queryKey = [`/api/students/${studentId}/venue-menus/pending`];

  const { data, isLoading } = useQuery<{ success: boolean; pending: PendingMenu[] }>({
    queryKey,
    enabled: !!studentId,
  });

  const pending = data?.pending ?? [];

  const itemsFor = (entry: PendingMenu): MenuItem[] =>
    edits[entry.menu.id] ?? entry.menu.items ?? [];

  const setItems = (menuId: string, items: MenuItem[]) =>
    setEdits((prev) => ({ ...prev, [menuId]: items }));

  const reviewMutation = useMutation({
    mutationFn: async ({ menuId, status }: { menuId: string; status: 'approved' | 'rejected' }) => {
      // Save corrections BEFORE the decision — the server refuses edits once a
      // menu leaves pending_review, so the order matters.
      const edited = edits[menuId];
      if (edited && status === 'approved') {
        const res = await apiRequest('PATCH', `/api/venue-menus/${menuId}/items`, {
          studentId,
          items: edited,
        });
        if (!res.ok) throw new Error((await res.json())?.message ?? 'error:MENU_EDIT_FAILED');
      }
      const res = await apiRequest('POST', `/api/venue-menus/${menuId}/review`, {
        studentId,
        status,
      });
      if (!res.ok) throw new Error((await res.json())?.message ?? 'error:MENU_REVIEW_FAILED');
      return res.json();
    },
    onSuccess: (_result, { status }) => {
      queryClient.invalidateQueries({ queryKey });
      setOpenId(null);
      toast({
        title:
          status === 'approved'
            ? t('venueMenus.review.approved')
            : t('venueMenus.review.rejected'),
      });
    },
    onError: (error: Error) => {
      const code = error.message?.startsWith('error:') ? error.message.slice(6) : null;
      toast({
        title: code ? t(`errors.${code}`) : t('errors.UNEXPECTED_ERROR'),
        variant: 'destructive',
      });
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // Nothing waiting is the normal state — say so plainly rather than showing an
  // empty box the clinician has to interpret.
  if (!pending.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Utensils className="h-4 w-4" />
            {t('venueMenus.review.title')}
          </CardTitle>
          <CardDescription>{t('venueMenus.review.empty')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Utensils className="h-4 w-4" />
          {t('venueMenus.review.title')}
          <Badge variant="secondary">{pending.length}</Badge>
        </CardTitle>
        <CardDescription>{t('venueMenus.review.description')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {pending.map((entry) => {
          const isOpen = openId === entry.menu.id;
          const items = itemsFor(entry);
          const busy = reviewMutation.isPending;

          return (
            <div key={entry.menu.id} className="rounded-lg border">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 p-3 text-start"
                onClick={() => setOpenId(isOpen ? null : entry.menu.id)}
                data-testid={`menu-review-toggle-${entry.menu.id}`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{entry.venue.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {t('venueMenus.review.itemCount', { count: String(items.length) })}
                  </div>
                </div>
                <Badge variant="outline">{t(`venueMenus.provenance.${entry.menu.provenance}`)}</Badge>
              </button>

              {isOpen && (
                <div className="border-t p-3 space-y-3">
                  {/* The chain caveat (§4.9). Caretaker-facing only — a
                      nonverbal student cannot act on a hedge. */}
                  {entry.menu.bindingBranchMatch === 'chain' && (
                    <div className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{t('venueMenus.review.branchWarning')}</span>
                    </div>
                  )}

                  <ScrollArea className="max-h-72">
                    <div className="space-y-2 pe-2">
                      {items.map((item, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            value={item.translatedName ?? item.name}
                            onChange={(e) => {
                              const next = [...items];
                              // Edit the DISPLAY name only. The original stays
                              // put — it is what gets spoken to staff.
                              next[i] = { ...item, translatedName: e.target.value };
                              setItems(entry.menu.id, next);
                            }}
                            className="h-8 text-sm"
                            data-testid={`menu-item-name-${i}`}
                          />
                          <span className="w-16 shrink-0 text-xs text-muted-foreground">
                            {item.priceText ?? ''}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            aria-label={t('venueMenus.review.removeItem')}
                            onClick={() => setItems(entry.menu.id, items.filter((_, j) => j !== i))}
                            data-testid={`menu-item-remove-${i}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        reviewMutation.mutate({ menuId: entry.menu.id, status: 'rejected' })
                      }
                      data-testid="menu-review-reject"
                    >
                      <X className="me-1 h-3.5 w-3.5" />
                      {t('venueMenus.review.reject')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || items.length === 0}
                      onClick={() =>
                        reviewMutation.mutate({ menuId: entry.menu.id, status: 'approved' })
                      }
                      data-testid="menu-review-approve"
                    >
                      {busy ? (
                        <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="me-1 h-3.5 w-3.5" />
                      )}
                      {t('venueMenus.review.approve')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
