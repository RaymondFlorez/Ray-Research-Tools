import type {
  Movement,
  MovementCategory,
  Product,
  PulseArticle,
  PulseTopic,
  SkillLevel,
  TrainingFocus,
} from "@/types";
import { MOVEMENTS, MOVEMENTS_BY_ID, MOVEMENTS_BY_SLUG } from "./movements";
import { PRODUCTS, PRODUCTS_BY_SLUG, STOREFRONT_PRODUCTS } from "./products";
import { PULSE_ARTICLES, PULSE_BY_SLUG } from "./pulse";
import { COACHES, COACHES_BY_ID, CURRENT_USER } from "./people";
import { buildSeedLogs, buildSeedSessions, recommendFromLogs } from "./sessions";

/* ============================================================================
   REPOSITORY
   The single seam between screens and persistence. Every function here is
   async and returns plain domain objects, so replacing the seed arrays with
   PrismaClient calls requires no changes above this file.
   ========================================================================= */

/* --- Movements ----------------------------------------------------------- */

export interface MovementQuery {
  category?: MovementCategory | "all";
  level?: SkillLevel | "all";
  focus?: TrainingFocus | "all";
  search?: string;
  ids?: string[];
}

export async function listMovements(query: MovementQuery = {}) {
  return filterMovements(MOVEMENTS, query);
}

/** Pure filter, exported so client-side filtering reuses the same rules. */
export function filterMovements(source: Movement[], query: MovementQuery) {
  const term = query.search?.trim().toLowerCase();
  return source.filter((m) => {
    if (query.ids && !query.ids.includes(m.id)) return false;
    if (query.category && query.category !== "all" && m.category !== query.category)
      return false;
    if (query.level && query.level !== "all" && m.level !== query.level)
      return false;
    if (query.focus && query.focus !== "all" && !m.focus.includes(query.focus))
      return false;
    if (term) {
      const haystack = [
        m.name,
        m.summary,
        m.group,
        ...m.cues,
        ...m.chains,
        ...m.equipment,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

export async function getMovementBySlug(slug: string) {
  return MOVEMENTS_BY_SLUG.get(slug) ?? null;
}

export function getMovementById(id: string) {
  return MOVEMENTS_BY_ID.get(id) ?? null;
}

export function getMovementsByIds(ids: string[]) {
  return ids
    .map((id) => MOVEMENTS_BY_ID.get(id))
    .filter((m): m is Movement => Boolean(m));
}

export async function listMovementSlugs() {
  return MOVEMENTS.map((m) => m.slug);
}

export function countByCategory() {
  const counts = new Map<MovementCategory, number>();
  for (const m of MOVEMENTS) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  return counts;
}

/* --- People -------------------------------------------------------------- */

export async function listCoaches() {
  return COACHES;
}

export function getCoach(id: string) {
  return COACHES_BY_ID.get(id) ?? null;
}

export async function getCurrentUser() {
  return CURRENT_USER;
}

/* --- Sessions ------------------------------------------------------------ */

/** Monday 00:00 local for the week containing `date`. */
export function startOfWeek(date: Date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function listSessions(anchorISO: string) {
  return buildSeedSessions(anchorISO);
}

export async function listSessionLogs(anchorISO: string) {
  return buildSeedLogs(anchorISO);
}

export async function listRecommendations(anchorISO: string) {
  return recommendFromLogs(buildSeedLogs(anchorISO));
}

/* --- Commerce ------------------------------------------------------------ */

export async function listProducts(options: { includeUnapproved?: boolean } = {}) {
  return options.includeUnapproved ? PRODUCTS : STOREFRONT_PRODUCTS;
}

export async function getProductBySlug(slug: string) {
  const product = PRODUCTS_BY_SLUG.get(slug);
  if (!product || product.moderation !== "approved") return null;
  return product;
}

export function getProductById(id: string): Product | null {
  return PRODUCTS.find((p) => p.id === id) ?? null;
}

export async function listProductSlugs() {
  return STOREFRONT_PRODUCTS.map((p) => p.slug);
}

/* --- Pulse --------------------------------------------------------------- */

export interface PulseQuery {
  topic?: PulseTopic | "all";
  focus?: TrainingFocus[];
  search?: string;
}

export async function listPulse(query: PulseQuery = {}) {
  return filterPulse(PULSE_ARTICLES, query);
}

export function filterPulse(source: PulseArticle[], query: PulseQuery) {
  const term = query.search?.trim().toLowerCase();
  return source
    .filter((a) => {
      if (query.topic && query.topic !== "all" && a.topic !== query.topic)
        return false;
      if (query.focus?.length && !a.relatedFocus.some((f) => query.focus!.includes(f)))
        return false;
      if (term) {
        const haystack = [a.title, a.summary, a.source, a.alphaTake ?? ""]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export async function getPulseBySlug(slug: string) {
  return PULSE_BY_SLUG.get(slug) ?? null;
}

export async function listPulseSlugs() {
  return PULSE_ARTICLES.map((a) => a.slug);
}
