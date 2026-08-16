import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { ensureDeviceId, getDeviceName } from "@/lib/device-id";

export interface RegisteredDevice {
  id: string;
  deviceId: string;
  deviceName: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export type DeviceRegistrationStatus =
  | "idle"
  | "checking"
  | "allowed"
  | "blocked"
  /**
   * The server said 403: this account has no access to this student. Unlike a
   * network failure this is a definitive answer, so it must NOT fail open —
   * it means the locally-cached student belongs to some other account (e.g. a
   * previous login on a shared device) and should be dropped.
   */
  | "denied";

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
        // Resolves the durable (native-stored) id, so a wiped localStorage
        // re-uses this device's slot instead of claiming another one.
        deviceId: await ensureDeviceId(),
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
    } catch (err) {
      if (seq !== checkSeq.current) return;
      // apiRequest throws `Error("<status>: <body>")` on non-ok responses.
      // 403 is a definitive access answer, not a connectivity problem.
      if (err instanceof Error && err.message.startsWith("403:")) {
        setStatus("denied");
      } else {
        // Fail open: an unreachable server must not brick the device.
        setStatus("allowed");
      }
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
