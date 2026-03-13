/**
 * Memory debug logger — disabled.
 * Was writing to a local file which fails on Lambda (read-only filesystem).
 * All exports are no-ops so existing call sites don't need changes.
 */

export function memDebug(_label: string, _data?: any) {}

export function memDebugSeparator(_title?: string) {}
