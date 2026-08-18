"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  CartLine,
  Flow,
  FlowItem,
  SessionLog,
  SkillLevel,
  TrainingFocus,
  TrainingSession,
} from "@/types";

/* ============================================================================
   CLIENT STATE
   Favorites, flows, cart, saved articles, offline downloads, and locally
   authored session edits. Persisted to localStorage so the app keeps working
   offline; the production build reconciles this against the API on reconnect.
   ========================================================================= */

interface AppState {
  /* onboarding + profile */
  onboarded: boolean;
  focus: TrainingFocus[];
  level: SkillLevel;
  timezone: string;
  personalizeFeed: boolean;

  /* movement library */
  favorites: string[];
  flows: Flow[];

  /* sessions */
  sessionOverrides: Record<string, Partial<TrainingSession>>;
  createdSessions: TrainingSession[];
  cancelledSessionIds: string[];
  logs: Record<string, SessionLog>;

  /* commerce */
  cart: CartLine[];
  owned: string[];
  downloads: string[];

  /* pulse */
  savedArticles: string[];

  /* actions */
  completeOnboarding: (input: {
    focus: TrainingFocus[];
    level: SkillLevel;
    timezone: string;
  }) => void;
  resetOnboarding: () => void;
  setPersonalizeFeed: (value: boolean) => void;

  toggleFavorite: (movementId: string) => void;
  createFlow: (name: string, items: FlowItem[], description?: string) => string;
  updateFlow: (id: string, patch: Partial<Omit<Flow, "id">>) => void;
  deleteFlow: (id: string) => void;

  moveSession: (id: string, startsAt: string) => void;
  patchSession: (id: string, patch: Partial<TrainingSession>) => void;
  /** The id is minted here so components never call impure code in render. */
  addSession: (session: Omit<TrainingSession, "id">) => string;
  cancelSession: (id: string) => void;
  logSession: (log: SessionLog) => void;

  addToCart: (line: CartLine) => void;
  updateCartQuantity: (productId: string, quantity: number) => void;
  removeFromCart: (productId: string) => void;
  clearCart: () => void;
  grantOwnership: (productIds: string[]) => void;
  toggleDownload: (productId: string) => void;

  toggleSavedArticle: (articleId: string) => void;
}

const uid = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      onboarded: false,
      focus: [],
      level: "foundation",
      timezone:
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : "America/Los_Angeles",
      personalizeFeed: true,

      favorites: ["mv-goata-01", "mv-primal-04", "mv-flow-04"],
      flows: [],

      sessionOverrides: {},
      createdSessions: [],
      cancelledSessionIds: [],
      logs: {},

      cart: [],
      owned: ["prd-10", "prd-12", "prd-11", "prd-14"],
      downloads: ["prd-10", "prd-12", "prd-14"],

      savedArticles: ["pulse-03"],

      completeOnboarding: ({ focus, level, timezone }) =>
        set({ onboarded: true, focus, level, timezone }),

      resetOnboarding: () => set({ onboarded: false, focus: [] }),

      setPersonalizeFeed: (personalizeFeed) => set({ personalizeFeed }),

      toggleFavorite: (movementId) =>
        set((state) => ({
          favorites: state.favorites.includes(movementId)
            ? state.favorites.filter((id) => id !== movementId)
            : [...state.favorites, movementId],
        })),

      createFlow: (name, items, description) => {
        const id = uid("flow");
        set((state) => ({
          flows: [
            ...state.flows,
            { id, name, description, items, createdAt: new Date().toISOString() },
          ],
        }));
        return id;
      },

      updateFlow: (id, patch) =>
        set((state) => ({
          flows: state.flows.map((f) => (f.id === id ? { ...f, ...patch } : f)),
        })),

      deleteFlow: (id) =>
        set((state) => ({ flows: state.flows.filter((f) => f.id !== id) })),

      moveSession: (id, startsAt) =>
        set((state) => ({
          sessionOverrides: {
            ...state.sessionOverrides,
            [id]: { ...state.sessionOverrides[id], startsAt },
          },
          createdSessions: state.createdSessions.map((s) =>
            s.id === id ? { ...s, startsAt } : s,
          ),
        })),

      patchSession: (id, patch) =>
        set((state) => ({
          sessionOverrides: {
            ...state.sessionOverrides,
            [id]: { ...state.sessionOverrides[id], ...patch },
          },
          createdSessions: state.createdSessions.map((s) =>
            s.id === id ? { ...s, ...patch } : s,
          ),
        })),

      addSession: (session) => {
        const id = uid("ses-local");
        set((state) => ({
          createdSessions: [...state.createdSessions, { ...session, id }],
        }));
        return id;
      },

      cancelSession: (id) =>
        set((state) => ({
          cancelledSessionIds: [...new Set([...state.cancelledSessionIds, id])],
        })),

      logSession: (log) =>
        set((state) => ({ logs: { ...state.logs, [log.sessionId]: log } })),

      addToCart: (line) =>
        set((state) => {
          const existing = state.cart.find((l) => l.productId === line.productId);
          if (existing) {
            return {
              cart: state.cart.map((l) =>
                l.productId === line.productId
                  ? { ...l, quantity: l.quantity + line.quantity, variantId: line.variantId ?? l.variantId }
                  : l,
              ),
            };
          }
          return { cart: [...state.cart, line] };
        }),

      updateCartQuantity: (productId, quantity) =>
        set((state) => ({
          cart:
            quantity <= 0
              ? state.cart.filter((l) => l.productId !== productId)
              : state.cart.map((l) =>
                  l.productId === productId ? { ...l, quantity } : l,
                ),
        })),

      removeFromCart: (productId) =>
        set((state) => ({
          cart: state.cart.filter((l) => l.productId !== productId),
        })),

      clearCart: () => set({ cart: [] }),

      grantOwnership: (productIds) =>
        set((state) => ({ owned: [...new Set([...state.owned, ...productIds])] })),

      toggleDownload: (productId) =>
        set((state) => ({
          downloads: state.downloads.includes(productId)
            ? state.downloads.filter((id) => id !== productId)
            : [...state.downloads, productId],
        })),

      toggleSavedArticle: (articleId) =>
        set((state) => ({
          savedArticles: state.savedArticles.includes(articleId)
            ? state.savedArticles.filter((id) => id !== articleId)
            : [...state.savedArticles, articleId],
        })),
    }),
    {
      name: "alpha-movement.v1",
      version: 1,
      // Persist data only — action functions are re-created on every load.
      partialize: (state) => ({
        onboarded: state.onboarded,
        focus: state.focus,
        level: state.level,
        timezone: state.timezone,
        personalizeFeed: state.personalizeFeed,
        favorites: state.favorites,
        flows: state.flows,
        sessionOverrides: state.sessionOverrides,
        createdSessions: state.createdSessions,
        cancelledSessionIds: state.cancelledSessionIds,
        logs: state.logs,
        cart: state.cart,
        owned: state.owned,
        downloads: state.downloads,
        savedArticles: state.savedArticles,
      }),
    },
  ),
);

/**
 * Guards against hydration mismatch: persisted state is not available during
 * SSR, so components that depend on it render their neutral state until this
 * returns true.
 */
export function useStoreHydrated() {
  return useAppStore.persist?.hasHydrated?.() ?? true;
}

/** Applies local edits (moves, cancellations, additions) over server sessions. */
export function applyLocalSessionEdits(
  sessions: TrainingSession[],
  state: Pick<
    AppState,
    "sessionOverrides" | "createdSessions" | "cancelledSessionIds"
  >,
): TrainingSession[] {
  const merged = sessions
    .filter((s) => !state.cancelledSessionIds.includes(s.id))
    .map((s) => ({ ...s, ...(state.sessionOverrides[s.id] ?? {}) }));

  const extras = state.createdSessions.filter(
    (s) => !state.cancelledSessionIds.includes(s.id),
  );

  return [...merged, ...extras].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
}

/** Reads useAppStore without subscribing — for event handlers. */
export const appStore = useAppStore;
