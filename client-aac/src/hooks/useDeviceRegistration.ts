import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { getDeviceId, getDeviceName } from "@/lib/device-id";

export interface RegisteredDevice {
  id: string;
  deviceId: string;
  deviceName: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export type DeviceRegistrationStatus = "idle" | "checking" | "allowed" | "blocked";

export interface DeviceRegistrationState {
  status: DeviceRegistrationStatus;
  /** Effective limit across all the student's institutes; -1 = unlimited. */
  limit: number;
  devices: RegisteredDevice[];
  /** Whether THIS device holds a slot (true + blocked = the limit shrank). */
  isRegistered: boolean;
  busy: boolean;
  retry: () => void;
  deregister: (recordId: string) => Promise<void>;
}

/**
 * Registers this device to the active student and re-checks the limit.
 * Runs on every student selection AND on startup with a restored student —
 * the startup run is what catches a limit that shrank after the student was
 * removed from an institute. Fails OPEN on network errors so an offline
 * device is never locked out by connectivity alone.
 */
export function useDeviceRegistration(studentId: string | null): DeviceRegistrationState {
  const [status, setStatus] = useState<DeviceRegistrationStatus>(studentId ? "checking" : "idle");
  const [limit, setLimit] = useState(-1);
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [isRegistered, setIsRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  // Guards against a stale response landing after the student changed.
  const checkSeq = useRef(0);

  const check = useCallback(async () => {
    if (!studentId) return;
    const seq = ++checkSeq.current;
    setStatus("checking");
    try {
      const res = await apiRequest("POST", `/api/students/${studentId}/devices/register`, {
        deviceId: getDeviceId(),
        deviceName: getDeviceName(),
      });
      const data = await res.json();
      if (seq !== checkSeq.current) return;
      if (data?.success) {
        setLimit(typeof data.limit === "number" ? data.limit : -1);
        setDevices(Array.isArray(data.devices) ? data.devices : []);
        setIsRegistered(!!data.isRegistered);
        setStatus(data.allowed ? "allowed" : "blocked");
      } else {
        setStatus("allowed");
      }
    } catch {
      // Fail open: an unreachable server must not brick the device.
      if (seq === checkSeq.current) setStatus("allowed");
    }
  }, [studentId]);

  useEffect(() => {
    if (studentId) {
      void check();
    } else {
      checkSeq.current++;
      setStatus("idle");
      setDevices([]);
      setIsRegistered(false);
    }
  }, [studentId, check]);

  const deregister = useCallback(
    async (recordId: string) => {
      if (!studentId) return;
      setBusy(true);
      try {
        await apiRequest("DELETE", `/api/students/${studentId}/devices/${recordId}`);
        await check();
      } catch {
        // Keep current state; the user can retry.
      } finally {
        setBusy(false);
      }
    },
    [studentId, check],
  );

  return { status, limit, devices, isRegistered, busy, retry: () => void check(), deregister };
}
