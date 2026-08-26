// client-aac/src/hooks/useCaretakerGate.tsx
//
// `gate(action)` runs `action` immediately when the student has no caretaker
// PIN, and behind the PIN prompt when they do. Wrap every caretaker surface
// on the device with it: switch student, manage devices, sign out.
//
// Status is fetched once per student and cached; a failed status fetch is
// treated as "no PIN" so an offline device never locks its caretaker out —
// the PIN is a barrier against a child at the keyboard, not an auth factor.

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import CaretakerPinPrompt from "@/components/CaretakerPinPrompt";

export function useCaretakerGate(studentId: string | null | undefined) {
  const pendingRef = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);

  const status = useQuery<{ set: boolean }>({
    queryKey: ["caretaker-pin-status", studentId],
    enabled: !!studentId,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/aac/students/${studentId}/caretaker-pin`);
      if (!res.ok) return { set: false };
      const body = await res.json();
      return { set: body?.set === true };
    },
  });

  const gate = useCallback(
    (action: () => void) => {
      if (!studentId || !status.data?.set) {
        action();
        return;
      }
      pendingRef.current = action;
      setOpen(true);
    },
    [studentId, status.data?.set],
  );

  const onVerify = useCallback(
    async (pin: string): Promise<"ok" | "wrong" | "locked" | "error"> => {
      try {
        const res = await apiRequest("POST", `/api/aac/students/${studentId}/caretaker-pin/verify`, { pin });
        if (res.ok) return "ok";
        if (res.status === 429) return "locked";
        if (res.status === 403) return "wrong";
        return "error";
      } catch {
        return "error";
      }
    },
    [studentId],
  );

  const prompt: ReactNode = (
    <CaretakerPinPrompt
      open={open}
      onVerify={onVerify}
      onSuccess={() => {
        setOpen(false);
        const action = pendingRef.current;
        pendingRef.current = null;
        action?.();
      }}
      onCancel={() => {
        setOpen(false);
        pendingRef.current = null;
      }}
    />
  );

  return { gate, prompt, pinSet: status.data?.set === true };
}
