// Registered AAC devices for a student, with de-registration. The limit shown
// is the effective one: the sum of maxDevicesPerStudent across the licenses of
// every institute the student belongs to (-1 = unlimited).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStudentLabel } from '@/hooks/useStudentLabel';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, MonitorSmartphone, Trash2 } from 'lucide-react';

interface StudentDeviceRow {
  id: string;
  deviceId: string;
  deviceName: string | null;
  lastSeenAt: string;
  createdAt: string;
}

interface DevicesResponse {
  success: boolean;
  devices: StudentDeviceRow[];
  limit: number;
}

export function StudentDevicesCard({ studentId }: { studentId: string }) {
  const { t, isRTL, language } = useLanguage();
  const { ts } = useStudentLabel();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<StudentDeviceRow | null>(null);

  const queryKey = ['/api/students', studentId, 'devices'];
  const devicesQuery = useQuery<DevicesResponse>({
    queryKey,
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/students/${studentId}/devices`);
      if (!response.ok) throw new Error('Failed to load devices');
      return response.json();
    },
  });

  const deregisterMut = useMutation({
    mutationFn: async (recordId: string) => {
      const response = await apiRequest('DELETE', `/api/students/${studentId}/devices/${recordId}`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Failed to deregister device');
    },
    onSuccess: () => {
      toast({ title: t('student.devices.deregistered') });
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => {
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
    },
  });

  const devices = devicesQuery.data?.devices ?? [];
  const limit = devicesQuery.data?.limit ?? -1;

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return iso;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
          <MonitorSmartphone className="w-5 h-5" />
          {t('student.devices.title')}
        </CardTitle>
        <CardDescription>{ts('student.devices.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {devicesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : devicesQuery.isError ? (
          <p className="text-sm text-destructive">{t('student.devices.loadFailed')}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {limit === -1
                ? t('student.devices.countUnlimited', { count: devices.length })
                : t('student.devices.countLimited', { count: devices.length, limit })}
            </p>
            {devices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('student.devices.empty')}</p>
            ) : (
              <div className="space-y-1">
                {devices.map((device) => (
                  <div
                    key={device.id}
                    className="flex items-center justify-between p-2 rounded-md text-sm bg-muted"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate font-medium">
                        {device.deviceName || t('student.devices.unknownDevice')}
                      </span>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {t('student.devices.lastSeen', { date: formatDate(device.lastSeenAt) })}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 ms-2 text-destructive hover:text-destructive"
                      disabled={deregisterMut.isPending}
                      onClick={() => setPendingDelete(device)}
                    >
                      <Trash2 className="w-3 h-3 me-1" />
                      {t('student.devices.deregister')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('student.devices.confirmDeregisterTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {ts('student.devices.confirmDeregisterDesc', {
                device: pendingDelete?.deviceName || t('student.devices.unknownDevice'),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) deregisterMut.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              {t('student.devices.deregister')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
