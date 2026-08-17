import type {
  CategoryMeta,
  MovementCategory,
  PulseTopic,
  SkillLevel,
  TrainingFocus,
} from "@/types";

/* ============================================================================
   THE SIX PILLARS
   The library, the session builder, and the programming engine all read from
   this single taxonomy so the philosophy stays structurally enforced rather
   than merely described in copy.
   ========================================================================= */

export const CATEGORIES: Record<MovementCategory, CategoryMeta> = {
  goata: {
    id: "goata",
    name: "GOATA Locomotion & Joint Prep",
    short: "GOATA",
    premise:
      "Restore the joint mechanics you were built with before you load them.",
    detail:
      "GOATA reads the body as a connected chain rather than a stack of isolated parts. We train the spiral, decelerating patterns the hips, feet, and shoulders are designed to produce — so force travels through the body instead of pooling in one joint. This is the prerequisite layer. Everything else in Alpha Movement is built on top of joints that track correctly under load.",
    colorVar: "var(--color-goata)",
  },
  primal: {
    id: "primal",
    name: "Primal Patterns",
    short: "Primal",
    premise: "Reclaim the positions the floor teaches and the chair removes.",
    detail:
      "Crawling, rolling, squatting, hanging, getting up and down off the ground. These are not novelty drills — they are the movement vocabulary a body keeps only if it rehearses. Primal work rebuilds the transitions between positions, which is precisely where most people have lost range and where most injuries actually occur.",
    colorVar: "var(--color-primal)",
  },
  flow: {
    id: "flow",
    name: "Yoga & Tai Chi Flows",
    short: "Flow",
    premise:
      "Train the nervous system to stay quiet while the body works hard.",
    detail:
      "Yoga supplies the positions and the breath; Tai Chi and internal martial arts supply continuity, weight transfer, and intent. Together they regulate the autonomic system — the switch between drive and recovery. An athlete who cannot downshift does not adapt to training, they merely accumulate it.",
    colorVar: "var(--color-flow)",
  },
  hybrid: {
    id: "hybrid",
    name: "Hybrid Strength + Conditioning",
    short: "Hybrid",
    premise: "Be strong enough to matter and conditioned enough to use it.",
    detail:
      "The hybrid athlete refuses the false choice between strength and endurance. We periodise them side by side — heavy, low-fatigue strength work paired with aerobic development that supports recovery rather than competing with it. The output is a body that expresses power repeatedly, not once.",
    colorVar: "var(--color-hybrid)",
  },
  functional: {
    id: "functional",
    name: "Functional Bodybuilding",
    short: "Functional",
    premise: "Build the shape, but earn it through positions worth owning.",
    detail:
      "Aesthetic development is not vanity — muscle is armour, metabolism, and longevity. We pursue it through full-range, controlled tempo work in positions that reinforce joint health rather than erode it. Progressive overload is applied to quality first and load second.",
    colorVar: "var(--color-functional)",
  },
  cardio: {
    id: "cardio",
    name: "Smart Cardio",
    short: "Cardio",
    premise: "Cardio is dosed, not survived.",
    detail:
      "Zone 2 for the aerobic base and mitochondrial density. Tempo for the threshold that decides how long you can hold an output. Sprint for peak power and its recovery. And genuine recovery modalities — nasal-only, low-intensity, deliberately boring. Intensity is a tool with a dose, not a measure of commitment.",
    colorVar: "var(--color-cardio)",
  },
};

export const CATEGORY_ORDER: MovementCategory[] = [
  "goata",
  "primal",
  "flow",
  "hybrid",
  "functional",
  "cardio",
];

/* --- Training focus ------------------------------------------------------ */

export const FOCUS_META: Record<
  TrainingFocus,
  { label: string; description: string }
> = {
  "joint-health": {
    label: "Joint Health & Longevity",
    description: "Chain integrity, decelerating capacity, pain-free range.",
  },
  "hybrid-athlete": {
    label: "Hybrid Athlete",
    description: "Strength and endurance developed together, not traded.",
  },
  aesthetics: {
    label: "Aesthetic Development",
    description: "Muscular shape earned through quality range and tempo.",
  },
  "mobility-flow": {
    label: "Mobility & Flow",
    description: "Usable range, fluid transitions, elegant movement quality.",
  },
  "nervous-system": {
    label: "Nervous System & Clarity",
    description: "Downshifting, breath control, recovery on demand.",
  },
  endurance: {
    label: "Cardiovascular Resilience",
    description: "Aerobic base, threshold durability, repeatable output.",
  },
};

export const FOCUS_ORDER: TrainingFocus[] = [
  "joint-health",
  "mobility-flow",
  "hybrid-athlete",
  "aesthetics",
  "endurance",
  "nervous-system",
];

export const LEVEL_META: Record<SkillLevel, { label: string; note: string }> = {
  foundation: {
    label: "Foundation",
    note: "Learn the position before you load it.",
  },
  developing: {
    label: "Developing",
    note: "Position is owned; add load, range, or duration.",
  },
  advanced: {
    label: "Advanced",
    note: "Expressed under fatigue, speed, or external constraint.",
  },
};

export const TOPIC_META: Record<PulseTopic, { label: string; short: string }> = {
  "training-science": {
    label: "Fitness Science & Methodology",
    short: "Science",
  },
  "recovery-longevity": {
    label: "Health, Recovery & Longevity",
    short: "Longevity",
  },
  "movement-culture": {
    label: "Movement Culture & Performance",
    short: "Movement",
  },
  "mind-body": { label: "Wellness & Mind-Body", short: "Mind-Body" },
};

export const TOPIC_ORDER: PulseTopic[] = [
  "training-science",
  "recovery-longevity",
  "movement-culture",
  "mind-body",
];

/* --- Deterministic poster gradients -------------------------------------- */

/**
 * Media posters are generated, not fetched, so the shell renders instantly and
 * offline. Each seed maps to a fixed dark gradient in the brand range.
 */
export const POSTERS: Record<string, string> = {
  slate: "linear-gradient(145deg,#16161a 0%,#1f1f24 48%,#0d0d0f 100%)",
  titanium: "linear-gradient(145deg,#1a1a20 0%,#2b2b33 52%,#101014 100%)",
  sage: "linear-gradient(145deg,#14170f 0%,#232a1c 50%,#0c0e0a 100%)",
  amber: "linear-gradient(145deg,#1c1710 0%,#2c2418 50%,#100d09 100%)",
  ash: "linear-gradient(145deg,#141416 0%,#232326 55%,#0a0a0b 100%)",
  steel: "linear-gradient(145deg,#101318 0%,#1d232c 52%,#0a0c0f 100%)",
  clay: "linear-gradient(145deg,#1a1512 0%,#2a221c 50%,#0f0d0b 100%)",
  plum: "linear-gradient(145deg,#171319 0%,#261f2a 50%,#0e0c10 100%)",
};

export function posterStyle(seed: string) {
  return { backgroundImage: POSTERS[seed] ?? POSTERS.ash };
}

export function categoryAccent(category: MovementCategory) {
  return CATEGORIES[category].colorVar;
}
