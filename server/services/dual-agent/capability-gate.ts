// server/services/dual-agent/capability-gate.ts
//
// Pure decision for whether a cost-saving client capability is ACTIVE for a
// session. Extracted from AgentCoordinator so the master-gate contract is
// unit-testable without instantiating the coordinator.
// See planning-docs/aac-cost-saving-spec.md §0.

export interface CapabilityGateInput {
  /** Per-student master switch. When ON, the AAC streams raw at full fidelity
   *  and ALL cost-saving substitutions are disabled. */
  fullAttentionMode: boolean;
  /** The connecting client advertised this capability at session init. */
  advertised: boolean;
}

/**
 * A capability is active when we may economize (full-attention OFF) AND the
 * client advertised it. So the default for an economizing session with an
 * updated client is ON; full-attention or an old client falls back to the safe
 * raw-streaming path. (No per-phase env flag — cost saving is the default once
 * full-attention is off.)
 */
export function isCapabilityActive(input: CapabilityGateInput): boolean {
  return !input.fullAttentionMode && input.advertised;
}
