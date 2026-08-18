import type { OwnedItem, Product } from "@/types";

/* ============================================================================
   STORE — merch, gear, and information products.
   Physical goods ship; digital goods grant an Entitlement and appear in the
   athlete's owned library, available offline.
   ========================================================================= */

const sizes = (inStockLabels: string[] = ["S", "M", "L", "XL"]) =>
  ["XS", "S", "M", "L", "XL", "XXL"].map((label) => ({
    id: label.toLowerCase(),
    label,
    inStock: inStockLabels.includes(label),
  }));

export const PRODUCTS: Product[] = [
  /* --- Apparel ---------------------------------------------------------- */
  {
    id: "prd-01",
    slug: "alpha-training-tee-charcoal",
    name: "Alpha Training Tee",
    type: "apparel",
    kind: "physical",
    tagline: "Weighted cotton-modal, cut for range.",
    description:
      "A training tee designed around overhead range rather than a mannequin. Drop shoulder, gusseted underarm, and a hem that stays put through crawling and ground work. Garment-dyed in charcoal so it fades the way good cotton should.",
    priceCents: 6800,
    currency: "USD",
    variants: sizes(["S", "M", "L", "XL"]),
    moderation: "approved",
    poster: "ash",
    featured: true,
  },
  {
    id: "prd-02",
    slug: "movement-short-7in",
    name: "Movement Short — 7″",
    type: "apparel",
    kind: "physical",
    tagline: "Four-way stretch, no liner, deep squat approved.",
    description:
      "Built for sessions that start on the floor and end on the track. Four-way stretch woven shell, zero liner, and a waistband that does not fold over in a deep squat. Two zip pockets that stay flat under a belt.",
    priceCents: 8200,
    currency: "USD",
    variants: sizes(["S", "M", "L", "XL", "XXL"]),
    moderation: "approved",
    poster: "slate",
  },
  {
    id: "prd-03",
    slug: "titanium-lifting-belt",
    name: "Titanium Series Lifting Belt",
    type: "gear",
    kind: "physical",
    tagline: "13mm vegetable-tanned leather, brushed hardware.",
    description:
      "A 13mm belt with a single-prong brushed titanium-finish buckle. Stiff enough to brace against on day one and broken in by month three. Sized by waist measurement rather than trouser size — the guide is on the sizing tab.",
    priceCents: 16500,
    compareAtCents: 19500,
    currency: "USD",
    variants: sizes(["S", "M", "L"]),
    moderation: "approved",
    poster: "titanium",
  },
  {
    id: "prd-04",
    slug: "ground-mat",
    name: "Ground Mat",
    type: "gear",
    kind: "physical",
    tagline: "8mm natural rubber. Grips when you sweat.",
    description:
      "Most mats are built for stillness. This one is built for crawling, rolling, and getting up off the floor a hundred times. 8mm natural rubber base, closed-cell top, 190cm long so tall athletes can actually lie down on it.",
    priceCents: 12800,
    currency: "USD",
    moderation: "approved",
    poster: "sage",
  },
  {
    id: "prd-05",
    slug: "recovery-kit",
    name: "Recovery Kit",
    type: "recovery",
    kind: "physical",
    tagline: "Ball, band, and the protocol card that makes them useful.",
    description:
      "A lacrosse-density ball, a long-loop band, and a laminated protocol card mapping each tool to the joint prep sequences in the library. Tools without a protocol are just objects — this ships with the protocol.",
    priceCents: 7400,
    currency: "USD",
    moderation: "approved",
    poster: "clay",
  },

  /* --- Digital: programs, books, series, audio -------------------------- */
  {
    id: "prd-10",
    slug: "alpha-foundations-8-week",
    name: "Alpha Foundations — 8 Week Cycle",
    type: "program",
    kind: "digital",
    tagline: "The entry point. Joint mechanics before load.",
    description:
      "Eight weeks that rebuild the base: foot and hip organisation, ground transitions, one aerobic thread, and an introduction to tempo strength. Three to four sessions a week, each between 35 and 60 minutes. This is the cycle every Alpha Movement athlete runs first, regardless of training age.",
    priceCents: 12000,
    currency: "USD",
    contents: [
      "32 programmed sessions with video for every movement",
      "Weekly joint-prep ladders that progress with you",
      "Printable session cards and an offline-capable player",
      "Movement screen at weeks 1, 4, and 8",
    ],
    moderation: "approved",
    poster: "titanium",
    featured: true,
  },
  {
    id: "prd-11",
    slug: "hybrid-engine-12-week",
    name: "Hybrid Engine — 12 Week Cycle",
    type: "program",
    kind: "digital",
    tagline: "Strength and aerobic capacity, developed together.",
    description:
      "Twelve weeks of concurrent training built so the two qualities support rather than sabotage each other. Heavy cluster work, one weekly threshold session, a zone 2 base that expands across the block, and a deload that is actually a deload. Requires Foundations or an equivalent base.",
    priceCents: 18500,
    currency: "USD",
    contents: [
      "48 sessions across a 3:1 loading structure",
      "Heart-rate zone calculator and drift-test protocol",
      "Strength progression that auto-adjusts to logged bar speed",
      "Two coach-reviewed check-in points",
    ],
    moderation: "approved",
    poster: "steel",
    featured: true,
  },
  {
    id: "prd-12",
    slug: "connected-athlete-manual",
    name: "The Connected Athlete",
    type: "ebook",
    kind: "digital",
    tagline: "A 180-page manual on joint mechanics and why they decide everything.",
    description:
      "The written foundation of the Alpha Movement system. Chapters on the foot tripod, hip spiral, scapular organisation, and deceleration, each paired with the drills that address them. Written for athletes and coaches, illustrated throughout, and deliberately free of the mystique that usually surrounds this material.",
    priceCents: 4200,
    currency: "USD",
    contents: [
      "180-page PDF and EPUB",
      "Illustrated joint-mechanics reference",
      "Screening protocol with scoring sheet",
      "Lifetime updates",
    ],
    moderation: "approved",
    poster: "ash",
  },
  {
    id: "prd-13",
    slug: "internal-arts-masterclass",
    name: "Internal Arts for Athletes — Masterclass",
    type: "video-series",
    kind: "digital",
    tagline: "Six sessions with Ines Okafor on regulation and weight transfer.",
    description:
      "A six-part series translating eighteen years of Chen-style practice into something a strength athlete can use on a Tuesday evening. Silk reeling, standing post, weight transfer, and the breath work that closes a hard session. Filmed slowly and deliberately, with no music.",
    priceCents: 9800,
    currency: "USD",
    contents: [
      "6 sessions, 35–50 minutes each",
      "Follow-along and instructional cuts of every session",
      "Downloadable audio-only versions",
      "Practice log template",
    ],
    creatorId: "coach-02",
    creatorName: "Ines Okafor",
    moderation: "approved",
    poster: "sage",
  },
  {
    id: "prd-14",
    slug: "downshift-audio-guides",
    name: "Downshift — Audio Guides",
    type: "audio",
    kind: "digital",
    tagline: "Nine guided sessions for the nervous system.",
    description:
      "Nine audio guides between six and twenty-five minutes: post-session downshifts, pre-sleep protocols, and two longer sessions for travel days. No ambient music, no affirmations — just pacing, breath counts, and enough silence to actually settle.",
    priceCents: 3400,
    currency: "USD",
    contents: [
      "9 guided audio sessions",
      "Offline download for the whole set",
      "Breath-pacing visual for the on-screen version",
    ],
    creatorId: "coach-02",
    creatorName: "Ines Okafor",
    moderation: "approved",
    poster: "plum",
  },
  {
    id: "prd-15",
    slug: "aesthetic-architecture-10-week",
    name: "Aesthetic Architecture — 10 Week Cycle",
    type: "program",
    kind: "digital",
    tagline: "Functional bodybuilding that does not cost you your shoulders.",
    description:
      "Ten weeks of tempo-driven, full-range hypertrophy work organised around positions worth keeping. Four sessions a week, upper/lower split, with joint prep built into every warm-up rather than bolted on. Progression is applied to range and tempo before load.",
    priceCents: 15500,
    currency: "USD",
    contents: [
      "40 sessions with prescribed tempo on every set",
      "Range-first progression model",
      "Photo and measurement tracking that is optional by default",
      "Deload week built in at week 6",
    ],
    creatorId: "coach-04",
    creatorName: "Sera Lindqvist",
    moderation: "approved",
    poster: "clay",
  },
  {
    id: "prd-16",
    slug: "deceleration-clinic",
    name: "Deceleration Clinic",
    type: "video-series",
    kind: "digital",
    tagline: "Four hours on the skill that keeps knees intact.",
    description:
      "Marco Ferreira's clinic on absorbing force: what deceleration actually is, how to screen for it, and the progression from spiral step to full change of direction. Includes the screening protocol he uses with every new athlete.",
    priceCents: 8800,
    currency: "USD",
    contents: [
      "4 hours across 11 chapters",
      "Screening protocol and scoring rubric",
      "Return-to-sprint progression",
    ],
    creatorId: "coach-01",
    creatorName: "Marco Ferreira",
    moderation: "pending",
    poster: "titanium",
  },
];

export const PRODUCTS_BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));
export const PRODUCTS_BY_SLUG = new Map(PRODUCTS.map((p) => [p.slug, p]));

/** Only approved products are ever surfaced in the storefront. */
export const STOREFRONT_PRODUCTS = PRODUCTS.filter(
  (p) => p.moderation === "approved",
);

/** What the demo athlete already owns — populates the offline library. */
export const OWNED_ITEMS: OwnedItem[] = [
  {
    productId: "prd-10",
    purchasedAt: "2026-02-12T18:04:00.000Z",
    progressPct: 100,
    downloaded: true,
  },
  {
    productId: "prd-12",
    purchasedAt: "2026-02-12T18:04:00.000Z",
    progressPct: 64,
    downloaded: true,
  },
  {
    productId: "prd-11",
    purchasedAt: "2026-05-03T14:22:00.000Z",
    progressPct: 41,
    downloaded: false,
  },
  {
    productId: "prd-14",
    purchasedAt: "2026-06-21T09:10:00.000Z",
    progressPct: 22,
    downloaded: true,
  },
];

export const PRODUCT_TYPE_LABELS: Record<Product["type"], string> = {
  apparel: "Apparel",
  gear: "Training Gear",
  recovery: "Recovery",
  ebook: "Manual",
  "video-series": "Video Series",
  program: "Program",
  audio: "Audio",
};
