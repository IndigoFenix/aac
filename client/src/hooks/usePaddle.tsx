// src/hooks/usePaddle.tsx
//
// One paddle-js instance per APP, not per component.
//
// `initializePaddle` mutates a global (it injects Paddle's script tag and hangs
// `window.Paddle` off it), so calling it from two mounted components races: the
// second call can overwrite the first instance's eventCallback, and a checkout
// opened by the first then completes into a dead handler. The initialisation
// therefore lives in a module-level promise that every consumer awaits — the
// hook is a thin subscription over it.
//
// The event callback is likewise module-level and dispatches to whichever
// checkout is currently open, because Paddle only ever holds ONE callback and it
// is fixed at init time: a component that opens a checkout cannot install its
// own completion handler, it has to register with us.

import { useEffect, useState, useCallback } from 'react';
import {
  initializePaddle,
  CheckoutEventNames,
  type Paddle,
} from '@paddle/paddle-js';
import { apiRequest } from '@/lib/queryClient';

/** Why paddle-js is not usable. `null` while still trying, or when it worked. */
export type PaddleUnavailableReason = 'no-client-token' | 'init-failed' | 'config-failed';

export interface PaddleState {
  paddle: Paddle | null;
  ready: boolean;
  /** Non-null only when `ready` is false and we have stopped trying. */
  reason: PaddleUnavailableReason | null;
  environment: 'sandbox' | 'production' | '';
}

interface PaddleInitResult {
  paddle: Paddle | null;
  reason: PaddleUnavailableReason | null;
  environment: 'sandbox' | 'production' | '';
}

/** Handlers for the checkout that is currently open, keyed by transaction where
 *  we know it. Paddle's single global callback fans out through here. */
let completionHandlers: Array<(transactionId: string | null) => void> = [];

function notifyCompleted(transactionId: string | null) {
  const handlers = completionHandlers;
  completionHandlers = [];
  for (const h of handlers) h(transactionId);
}

let initPromise: Promise<PaddleInitResult> | null = null;

async function initPaddleOnce(): Promise<PaddleInitResult> {
  let cfg: { environment?: string; clientToken?: string | null };
  try {
    const res = await apiRequest('GET', '/api/paddle/config');
    cfg = await res.json();
  } catch (err) {
    console.error('Paddle config fetch failed:', err);
    return { paddle: null, reason: 'config-failed', environment: '' };
  }

  const environment = cfg.environment === 'production' ? 'production' : 'sandbox';

  // No token is a CONFIGURATION state, not an exception: a self-hosted or
  // invoice-only deployment simply has no Paddle. Callers render "payments
  // unavailable", they don't catch.
  if (!cfg.clientToken) {
    return { paddle: null, reason: 'no-client-token', environment };
  }

  try {
    const instance = await initializePaddle({
      environment,
      token: cfg.clientToken,
      eventCallback: (event) => {
        if (event.name === CheckoutEventNames.CHECKOUT_COMPLETED) {
          notifyCompleted(event.data?.transaction_id ?? null);
        }
      },
    });
    if (!instance) return { paddle: null, reason: 'init-failed', environment };
    return { paddle: instance, reason: null, environment };
  } catch (err) {
    console.error('Paddle init error:', err);
    return { paddle: null, reason: 'init-failed', environment };
  }
}

function getPaddle(): Promise<PaddleInitResult> {
  if (!initPromise) initPromise = initPaddleOnce();
  return initPromise;
}

export interface OpenCheckoutOptions {
  onCompleted?: (transactionId: string | null) => void;
  /** Extra data forwarded to Paddle. The WEBHOOK is the only fulfilment path,
   *  and it arrives with no session — whatever it needs must ride along here. */
  customData?: Record<string, unknown>;
}

export interface UsePaddleResult extends PaddleState {
  /** Open a checkout for a transaction the SERVER created (the license flow). */
  openCheckout: (transactionId: string, options?: OpenCheckoutOptions) => boolean;
  /** Open a checkout straight from a catalog price (the paddle-test page). */
  openCheckoutForPrice: (
    priceId: string,
    customData?: Record<string, unknown>,
    options?: OpenCheckoutOptions,
  ) => boolean;
}

export function usePaddle(): UsePaddleResult {
  const [state, setState] = useState<PaddleState>({
    paddle: null,
    ready: false,
    reason: null,
    environment: '',
  });

  useEffect(() => {
    let cancelled = false;
    void getPaddle().then((result) => {
      if (cancelled) return;
      setState({
        paddle: result.paddle,
        ready: !!result.paddle,
        reason: result.reason,
        environment: result.environment,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback((options?: OpenCheckoutOptions) => {
    if (options?.onCompleted) completionHandlers.push(options.onCompleted);
  }, []);

  const openCheckout = useCallback(
    (transactionId: string, options?: OpenCheckoutOptions) => {
      if (!state.paddle) return false;
      register(options);
      state.paddle.Checkout.open({ transactionId });
      return true;
    },
    [state.paddle, register],
  );

  const openCheckoutForPrice = useCallback(
    (priceId: string, customData?: Record<string, unknown>, options?: OpenCheckoutOptions) => {
      if (!state.paddle) return false;
      register(options);
      state.paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        ...(customData ? { customData } : {}),
      });
      return true;
    },
    [state.paddle, register],
  );

  return { ...state, openCheckout, openCheckoutForPrice };
}
