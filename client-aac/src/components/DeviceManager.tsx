import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, MonitorSmartphone, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiRequest } from "@/lib/queryClient";
import { getDeviceId } from "@/lib/device-id";
import type { RegisteredDevice } from "@/hooks/useDeviceRegistration";

function formatLastSeen(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function DeviceList({
  devices,
  onDeregister,
  busy,
}: {
  devices: RegisteredDevice[];
  onDeregister: (recordId: string) => void;
  busy: boolean;
}) {
  const { t, language } = useLanguage();
  const currentDeviceId = getDeviceId();

  if (devices.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">{t("devices.empty")}</p>;
  }

  return (
    <div className="space-y-2">
      {devices.map((device) => (
        <div
          key={device.id}
          className="flex items-center gap-3 rounded-lg border dark:border-gray-700 p-3 bg-white dark:bg-gray-800"
        >
          <MonitorSmartphone className="h-5 w-5 text-purple-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
              {device.deviceName || t("devices.unknownDevice")}
              {device.deviceId === currentDeviceId && (
                <span className="ms-2 text-xs rounded-full bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-2 py-0.5">
                  {t("devices.thisDevice")}
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t("devices.lastSeen", { date: formatLastSeen(device.lastSeenAt, language) })}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onDeregister(device.id)}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950 shrink-0"
            aria-label={t("devices.deregister")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function limitLabel(t: (key: string, params?: Record<string, string | number>) => string, count: number, limit: number) {
  return limit === -1
    ? t("devices.countUnlimited", { count })
    : t("devices.countLimited", { count, limit });
}

/**
 * Full-screen blocker shown when this device may not use the selected student:
 * either every slot is taken by another device, or the student's limit shrank
 * (e.g. they left an institute) and the registered set no longer fits.
 * data-dwell-trap keeps eye-gaze dwell from falling through to the AAC behind.
 */
export function DeviceLimitOverlay({
  devices,
  limit,
  isRegistered,
  busy,
  checking,
  onDeregister,
  onRetry,
  onExitStudent,
}: {
  devices: RegisteredDevice[];
  limit: number;
  isRegistered: boolean;
  busy: boolean;
  checking: boolean;
  onDeregister: (recordId: string) => void;
  onRetry: () => void;
  onExitStudent: () => void;
}) {
  const { t, direction } = useLanguage();

  return (
    <div
      data-dwell-trap
      dir={direction}
      className="fixed inset-0 z-[100] bg-gradient-to-br from-purple-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4 overflow-y-auto"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <TriangleAlert className="h-10 w-10 text-amber-500 mx-auto mb-2" />
          <CardTitle className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {t("devices.limitReachedTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {isRegistered
              ? t("devices.overLimitDesc", { count: devices.length, limit })
              : t("devices.limitFullDesc", { limit })}
          </p>
          <DeviceList devices={devices} onDeregister={onDeregister} busy={busy} />
          <div className="flex gap-2 pt-2">
            <Button onClick={onRetry} disabled={busy || checking} className="flex-1">
              {checking ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <RefreshCw className="h-4 w-4 me-2" />}
              {t("devices.retry")}
            </Button>
            <Button variant="outline" onClick={onExitStudent} disabled={busy} className="flex-1">
              {t("devices.switchStudent")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Voluntary device management, opened from the caretaker toolbar while a
 * student is active. Self-fetching so it stays decoupled from the
 * registration gate in App.tsx.
 */
export function DeviceManagerModal({
  studentId,
  isOpen,
  onClose,
}: {
  studentId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t, direction } = useLanguage();
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [limit, setLimit] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await apiRequest("GET", `/api/students/${studentId}/devices`);
      const data = await res.json();
      if (data?.success) {
        setDevices(Array.isArray(data.devices) ? data.devices : []);
        setLimit(typeof data.limit === "number" ? data.limit : -1);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  const handleDeregister = async (recordId: string) => {
    setBusy(true);
    try {
      await apiRequest("DELETE", `/api/students/${studentId}/devices/${recordId}`);
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent dir={direction} className="max-w-md" data-dwell-trap>
        <DialogHeader>
          <DialogTitle>{t("devices.title")}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
          </div>
        ) : error ? (
          <p className="text-sm text-red-600 dark:text-red-400 text-center py-4">{t("devices.loadFailed")}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">{limitLabel(t, devices.length, limit)}</p>
            <DeviceList devices={devices} onDeregister={handleDeregister} busy={busy} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
