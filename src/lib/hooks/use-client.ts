"use client";

import * as React from "react";

/* ============================================================================
   CLIENT-ONLY VALUES
   Time and locale are external systems, not React state. Reading them through
   useSyncExternalStore keeps the server snapshot explicit, so SSR stays
   deterministic and hydration never mismatches — without setState-in-effect.
   ========================================================================= */

const noopSubscribe = () => () => {};

/**
 * False during SSR and the first client render; true afterwards. Use it to gate
 * anything that depends on localStorage or the viewer's environment.
 */
export function useIsHydrated() {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/* --- Current time ---------------------------------------------------------- */

let cachedNow = 0;
const nowListeners = new Set<() => void>();
let nowTimer: ReturnType<typeof setInterval> | null = null;

function subscribeToNow(listener: () => void) {
  nowListeners.add(listener);
  if (!nowTimer) {
    cachedNow = Date.now();
    nowTimer = setInterval(() => {
      cachedNow = Date.now();
      nowListeners.forEach((notify) => notify());
    }, 30_000);
  }
  return () => {
    nowListeners.delete(listener);
    if (nowListeners.size === 0 && nowTimer) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  };
}

function nowSnapshot() {
  if (!cachedNow) cachedNow = Date.now();
  return cachedNow;
}

/**
 * The current time as an epoch millisecond value, refreshed every 30 seconds.
 * Returns null on the server so callers render a skeleton rather than a time
 * the viewer's clock would disagree with.
 */
export function useNowMs(): number | null {
  return React.useSyncExternalStore(
    subscribeToNow,
    nowSnapshot,
    () => null,
  );
}

/** Same value as a Date, or null before hydration. */
export function useNow(): Date | null {
  const ms = useNowMs();
  return React.useMemo(() => (ms === null ? null : new Date(ms)), [ms]);
}

/* --- Locale ---------------------------------------------------------------- */

let cachedZone: string | null = null;

function localZoneSnapshot() {
  cachedZone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  return cachedZone;
}

const SERVER_ZONE = "America/Los_Angeles";

/** The viewer's IANA zone, falling back to the platform default during SSR. */
export function useLocalTimezone() {
  return React.useSyncExternalStore(
    noopSubscribe,
    localZoneSnapshot,
    () => SERVER_ZONE,
  );
}
