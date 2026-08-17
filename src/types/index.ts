/* ============================================================================
   ALPHA MOVEMENT — DOMAIN TYPES
   These mirror prisma/schema.prisma one-for-one. The app layer imports from
   here so screens stay decoupled from the persistence client.
   ========================================================================= */

/* --- Taxonomy ------------------------------------------------------------ */

export const MOVEMENT_CATEGORIES = [
  "goata",
  "primal",
  "flow",
  "hybrid",
  "functional",
  "cardio",
] as const;

export type MovementCategory = (typeof MOVEMENT_CATEGORIES)[number];

export interface CategoryMeta {
  id: MovementCategory;
  name: string;
  short: string;
  /** One-line articulation of what this pillar trains and why. */
  premise: string;
  /** Longer philosophy copy shown on the category page. */
  detail: string;
  colorVar: string;
}

export type SkillLevel = "foundation" | "developing" | "advanced";

export type TrainingFocus =
  | "joint-health"
  | "hybrid-athlete"
  | "aesthetics"
  | "mobility-flow"
  | "nervous-system"
  | "endurance";

/* --- Movement library ---------------------------------------------------- */

export interface Movement {
  id: string;
  slug: string;
  name: string;
  category: MovementCategory;
  /** e.g. "Locomotion", "Joint Prep", "Zone 2" */
  group: string;
  level: SkillLevel;
  /** Prescribed working duration in seconds (per side where relevant). */
  durationSec: number;
  summary: string;
  /** Coaching cues, ordered as they should be taught. */
  cues: string[];
  /** The "why this matters" panel — the philosophy made concrete. */
  why: string;
  /** Joints/chains the movement organises. Drives the joint-health filter. */
  chains: string[];
  equipment: string[];
  focus: TrainingFocus[];
  videoUrl: string;
  /**
   * Whether the demonstration video has been uploaded to the CDN. False for
   * every seeded movement, which is what lets the player skip the request
   * entirely rather than firing a 404 on each page view.
   */
  mediaReady?: boolean;
  /** Deterministic gradient seed so posters render identically on server/client. */
  poster: string;
  /** Movements that should precede this one. */
  prerequisites?: string[];
  regressions?: string[];
  progressions?: string[];
}

export interface FlowItem {
  movementId: string;
  durationSec: number;
  note?: string;
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  items: FlowItem[];
  createdAt: string;
}

/* --- People -------------------------------------------------------------- */

export type UserRole = "client" | "coach" | "admin";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  timezone: string;
  focus: TrainingFocus[];
  level: SkillLevel;
  /** ISO date the athlete joined — drives the dashboard streak baseline. */
  joinedAt: string;
  avatarSeed: string;
}

export interface AvailabilityWindow {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Minutes from local midnight. */
  startMin: number;
  endMin: number;
}

export interface Coach {
  id: string;
  name: string;
  title: string;
  bio: string;
  specialties: MovementCategory[];
  timezone: string;
  availability: AvailabilityWindow[];
  sessionRateCents: number;
  avatarSeed: string;
  credentials: string[];
}

/* --- Sessions & calendar -------------------------------------------------- */

export type SessionType = "live" | "in-person" | "group" | "async";

export type SessionStatus =
  | "requested"
  | "scheduled"
  | "completed"
  | "cancelled";

export type RecurrenceRule = "none" | "weekly" | "biweekly" | "every-weekday";

export interface SessionBlock {
  /** Which pillar this block draws from — keeps programming legible. */
  category: MovementCategory;
  label: string;
  movementIds: string[];
  durationMin: number;
}

export interface TrainingSession {
  id: string;
  title: string;
  type: SessionType;
  status: SessionStatus;
  coachId: string;
  clientId: string;
  /** UTC instant. All rendering converts into the viewer's timezone. */
  startsAt: string;
  durationMin: number;
  /** IANA zone the session was authored in. */
  timezone: string;
  recurrence: RecurrenceRule;
  blocks: SessionBlock[];
  location?: string;
  joinUrl?: string;
  notes?: string;
  reminders: { channel: "push" | "email"; minutesBefore: number }[];
}

/** Post-session log — the feedback loop that feeds future programming. */
export interface SessionLog {
  sessionId: string;
  completedAt: string;
  /** 1–5 subjective movement quality. */
  movementQuality: number;
  /** Rate of perceived exertion, 1–10. */
  rpe: number;
  /** Total external load moved, kg. Optional for flow/cardio work. */
  loadKg?: number;
  restingHr?: number;
  hrvMs?: number;
  sleepHours?: number;
  soreness: string[];
  athleteNote?: string;
  coachNote?: string;
}

/** What the programming engine returns after reading the logs. */
export interface ProgrammingRecommendation {
  id: string;
  headline: string;
  rationale: string;
  suggestedCategory: MovementCategory;
  suggestedMovementIds: string[];
  confidence: number;
}

/* --- Commerce ------------------------------------------------------------- */

export type ProductType =
  | "apparel"
  | "gear"
  | "recovery"
  | "ebook"
  | "video-series"
  | "program"
  | "audio";

export type ProductKind = "physical" | "digital";

export interface ProductVariant {
  id: string;
  label: string;
  inStock: boolean;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  type: ProductType;
  kind: ProductKind;
  tagline: string;
  description: string;
  priceCents: number;
  compareAtCents?: number;
  currency: string;
  variants?: ProductVariant[];
  /** Digital goods: what lands in the owned library after purchase. */
  contents?: string[];
  creatorId?: string;
  creatorName?: string;
  moderation: "approved" | "pending" | "rejected";
  poster: string;
  featured?: boolean;
}

export interface CartLine {
  productId: string;
  variantId?: string;
  quantity: number;
}

export interface OwnedItem {
  productId: string;
  purchasedAt: string;
  progressPct: number;
  /** Whether the asset has been cached for offline use. */
  downloaded: boolean;
}

/* --- Pulse (news & trends) ------------------------------------------------ */

export type PulseTopic =
  | "training-science"
  | "recovery-longevity"
  | "movement-culture"
  | "mind-body";

export interface PulseArticle {
  id: string;
  slug: string;
  title: string;
  source: string;
  sourceUrl: string;
  publishedAt: string;
  topic: PulseTopic;
  summary: string;
  /** Editorial or AI-curated position, always attributed as our reading. */
  alphaTake?: string;
  takeAuthor?: string;
  readMinutes: number;
  relatedFocus: TrainingFocus[];
  poster: string;
}
