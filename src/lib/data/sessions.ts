import type {
  ProgrammingRecommendation,
  SessionLog,
  TrainingSession,
} from "@/types";

/* ============================================================================
   SESSION SEED
   Sessions are generated relative to a week anchor that the server computes and
   passes to the calendar. Keeping the anchor explicit means server and client
   always agree on what "this week" is — no hydration drift.
   ========================================================================= */

interface SeedSpec {
  id: string;
  title: string;
  type: TrainingSession["type"];
  status: TrainingSession["status"];
  coachId: string;
  /** Days after the week anchor (anchor = Monday). */
  dayOffset: number;
  /** Local start time, minutes from midnight. */
  startMin: number;
  durationMin: number;
  recurrence: TrainingSession["recurrence"];
  blocks: TrainingSession["blocks"];
  location?: string;
  joinUrl?: string;
  notes?: string;
}

const SPECS: SeedSpec[] = [
  {
    id: "ses-01",
    title: "Joint Prep + Locomotion Reset",
    type: "live",
    status: "scheduled",
    coachId: "coach-01",
    dayOffset: 0,
    startMin: 7 * 60,
    durationMin: 60,
    recurrence: "weekly",
    joinUrl: "https://live.alphamovement.app/r/joint-prep-reset",
    notes:
      "Camera at 45 degrees so I can see foot contact. Barefoot for the first block.",
    blocks: [
      {
        category: "goata",
        label: "Foot & hip organisation",
        movementIds: ["mv-goata-01", "mv-goata-02"],
        durationMin: 20,
      },
      {
        category: "primal",
        label: "Ground transitions",
        movementIds: ["mv-primal-01", "mv-primal-04"],
        durationMin: 25,
      },
      {
        category: "flow",
        label: "Downshift",
        movementIds: ["mv-flow-04"],
        durationMin: 15,
      },
    ],
  },
  {
    id: "ses-02",
    title: "Hybrid Strength — Lower",
    type: "in-person",
    status: "scheduled",
    coachId: "coach-03",
    dayOffset: 1,
    startMin: 17 * 60 + 30,
    durationMin: 75,
    recurrence: "weekly",
    location: "Alpha Movement Studio — Bay 2",
    blocks: [
      {
        category: "goata",
        label: "Prep",
        movementIds: ["mv-goata-01"],
        durationMin: 10,
      },
      {
        category: "hybrid",
        label: "Primary strength",
        movementIds: ["mv-hybrid-01", "mv-hybrid-02"],
        durationMin: 45,
      },
      {
        category: "functional",
        label: "Accessory at length",
        movementIds: ["mv-fn-02"],
        durationMin: 20,
      },
    ],
  },
  {
    id: "ses-03",
    title: "Zone 2 Base — Unsupervised",
    type: "async",
    status: "scheduled",
    coachId: "coach-03",
    dayOffset: 2,
    startMin: 6 * 60 + 30,
    durationMin: 45,
    recurrence: "every-weekday",
    notes: "Nasal only. Upload the HR file afterwards and I'll review the drift.",
    blocks: [
      {
        category: "cardio",
        label: "Aerobic base",
        movementIds: ["mv-cardio-01"],
        durationMin: 45,
      },
    ],
  },
  {
    id: "ses-04",
    title: "Internal Arts — Regulation",
    type: "live",
    status: "scheduled",
    coachId: "coach-02",
    dayOffset: 2,
    startMin: 19 * 60,
    durationMin: 45,
    recurrence: "weekly",
    joinUrl: "https://live.alphamovement.app/r/internal-arts",
    blocks: [
      {
        category: "flow",
        label: "Silk reeling & standing",
        movementIds: ["mv-flow-01", "mv-flow-02", "mv-flow-05"],
        durationMin: 35,
      },
      {
        category: "flow",
        label: "Breath close",
        movementIds: ["mv-flow-04"],
        durationMin: 10,
      },
    ],
  },
  {
    id: "ses-05",
    title: "Functional Bodybuilding — Upper",
    type: "in-person",
    status: "scheduled",
    coachId: "coach-04",
    dayOffset: 3,
    startMin: 17 * 60,
    durationMin: 70,
    recurrence: "weekly",
    location: "Alpha Movement Studio — Bay 1",
    blocks: [
      {
        category: "goata",
        label: "Shoulder prep",
        movementIds: ["mv-goata-03", "mv-goata-05"],
        durationMin: 12,
      },
      {
        category: "functional",
        label: "Push / pull at length",
        movementIds: ["mv-fn-01", "mv-fn-03"],
        durationMin: 40,
      },
      {
        category: "hybrid",
        label: "Pulling ladder",
        movementIds: ["mv-hybrid-04"],
        durationMin: 18,
      },
    ],
  },
  {
    id: "ses-06",
    title: "Sprint & Power",
    type: "group",
    status: "scheduled",
    coachId: "coach-03",
    dayOffset: 5,
    startMin: 9 * 60,
    durationMin: 60,
    recurrence: "biweekly",
    location: "Marina Green — north track",
    notes: "Group of six. Full GOATA prep before any build-up runs.",
    blocks: [
      {
        category: "goata",
        label: "Full prep ladder",
        movementIds: ["mv-goata-01", "mv-goata-02", "mv-goata-04"],
        durationMin: 20,
      },
      {
        category: "cardio",
        label: "Maximal efforts",
        movementIds: ["mv-cardio-03"],
        durationMin: 30,
      },
      {
        category: "flow",
        label: "Downshift",
        movementIds: ["mv-flow-04"],
        durationMin: 10,
      },
    ],
  },
  {
    id: "ses-07",
    title: "Recovery Spin + Breath",
    type: "async",
    status: "scheduled",
    coachId: "coach-02",
    dayOffset: 6,
    startMin: 10 * 60,
    durationMin: 30,
    recurrence: "weekly",
    blocks: [
      {
        category: "cardio",
        label: "Easy spin",
        movementIds: ["mv-cardio-04"],
        durationMin: 20,
      },
      {
        category: "flow",
        label: "Long exhale",
        movementIds: ["mv-flow-04"],
        durationMin: 10,
      },
    ],
  },
  {
    id: "ses-08",
    title: "Movement Screen & Programming Review",
    type: "live",
    status: "requested",
    coachId: "coach-01",
    dayOffset: 4,
    startMin: 8 * 60,
    durationMin: 45,
    recurrence: "none",
    joinUrl: "https://live.alphamovement.app/r/screen-review",
    notes: "Quarterly re-screen. Requested — awaiting Marco's confirmation.",
    blocks: [
      {
        category: "goata",
        label: "Screen",
        movementIds: ["mv-goata-01", "mv-goata-02", "mv-goata-05"],
        durationMin: 30,
      },
      {
        category: "primal",
        label: "Transition assessment",
        movementIds: ["mv-primal-02"],
        durationMin: 15,
      },
    ],
  },
];

/**
 * Build the seeded schedule for a given Monday anchor (ISO string).
 * `weekOffset` shifts whole weeks, so the calendar can page forward and back.
 */
export function buildSeedSessions(
  anchorISO: string,
  clientId = "user-01",
): TrainingSession[] {
  const anchor = new Date(anchorISO);
  const sessions: TrainingSession[] = [];

  // Seed three weeks: last week (completed), this week, next week.
  for (const weekOffset of [-1, 0, 1]) {
    for (const spec of SPECS) {
      // Biweekly sessions only appear on even weeks relative to the anchor.
      if (spec.recurrence === "biweekly" && Math.abs(weekOffset) % 2 === 1) {
        continue;
      }
      // One-off sessions are not repeated across weeks.
      if (spec.recurrence === "none" && weekOffset !== 0) continue;

      const startsAt = new Date(anchor);
      startsAt.setDate(anchor.getDate() + weekOffset * 7 + spec.dayOffset);
      startsAt.setHours(0, spec.startMin, 0, 0);

      sessions.push({
        id: weekOffset === 0 ? spec.id : `${spec.id}-w${weekOffset}`,
        title: spec.title,
        type: spec.type,
        status: weekOffset < 0 ? "completed" : spec.status,
        coachId: spec.coachId,
        clientId,
        startsAt: startsAt.toISOString(),
        durationMin: spec.durationMin,
        timezone: "America/Los_Angeles",
        recurrence: spec.recurrence,
        blocks: spec.blocks,
        location: spec.location,
        joinUrl: spec.joinUrl,
        notes: spec.notes,
        reminders: [
          { channel: "push", minutesBefore: 30 },
          { channel: "email", minutesBefore: 60 * 12 },
        ],
      });
    }
  }

  return sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/* --- Completed session logs (drive the dashboard and the feedback loop) --- */

export function buildSeedLogs(anchorISO: string): SessionLog[] {
  const anchor = new Date(anchorISO);
  const dayBefore = (days: number) => {
    const d = new Date(anchor);
    d.setDate(anchor.getDate() - days);
    return d.toISOString();
  };

  return [
    {
      sessionId: "ses-01-w-1",
      completedAt: dayBefore(7),
      movementQuality: 4,
      rpe: 5,
      restingHr: 52,
      hrvMs: 74,
      sleepHours: 7.5,
      soreness: [],
      athleteNote:
        "Left foot tripod much clearer than last month. Right hip still catches on the deceleration step.",
      coachNote:
        "Agreed — right hip is the limiter. Adding an extra 90/90 block before we load the split squat again.",
    },
    {
      sessionId: "ses-02-w-1",
      completedAt: dayBefore(6),
      movementQuality: 3,
      rpe: 8,
      loadKg: 8420,
      restingHr: 58,
      hrvMs: 61,
      sleepHours: 6.2,
      soreness: ["hamstrings", "low back"],
      athleteNote:
        "Bar speed dropped on the fourth cluster. Slept badly the night before.",
      coachNote:
        "Called the set early, correctly. We keep the same load next week rather than progressing on a poor sleep week.",
    },
    {
      sessionId: "ses-04-w-1",
      completedAt: dayBefore(5),
      movementQuality: 5,
      rpe: 2,
      restingHr: 50,
      hrvMs: 82,
      sleepHours: 8.1,
      soreness: [],
      athleteNote: "Best I have slept all block. Standing post to twelve minutes.",
      coachNote: "HRV response to this session is now consistent. Keep it midweek.",
    },
    {
      sessionId: "ses-05-w-1",
      completedAt: dayBefore(4),
      movementQuality: 4,
      rpe: 7,
      loadKg: 5240,
      restingHr: 54,
      hrvMs: 70,
      sleepHours: 7.4,
      soreness: ["chest"],
      athleteNote: "Incline press stretch felt honest for the first time.",
    },
    {
      sessionId: "ses-07-w-1",
      completedAt: dayBefore(1),
      movementQuality: 5,
      rpe: 2,
      restingHr: 49,
      hrvMs: 85,
      sleepHours: 8.4,
      soreness: [],
      athleteNote: "Legs felt clean afterwards.",
    },
  ];
}

/* --- Programming recommendations ------------------------------------------ */

/**
 * A transparent, rule-based programming engine. Every recommendation states
 * the evidence it read, because a coach — and the athlete — should be able to
 * disagree with it. The production version is the same interface backed by a
 * model, with these rules retained as guardrails.
 */
export function recommendFromLogs(
  logs: SessionLog[],
): ProgrammingRecommendation[] {
  const out: ProgrammingRecommendation[] = [];
  if (!logs.length) return out;

  const recent = [...logs].sort((a, b) =>
    b.completedAt.localeCompare(a.completedAt),
  );
  const avg = (nums: number[]) =>
    nums.reduce((sum, n) => sum + n, 0) / (nums.length || 1);

  const quality = avg(recent.map((l) => l.movementQuality));
  const rpe = avg(recent.map((l) => l.rpe));
  const hrv = recent.filter((l) => l.hrvMs).map((l) => l.hrvMs!);
  const sleep = recent.filter((l) => l.sleepHours).map((l) => l.sleepHours!);
  const soreness = recent.flatMap((l) => l.soreness);

  if (quality < 3.6) {
    out.push({
      id: "rec-quality",
      headline: "Hold load — quality is the limiter this block",
      rationale: `Movement quality is averaging ${quality.toFixed(1)} of 5 across your last ${recent.length} sessions while RPE sits at ${rpe.toFixed(1)}. That combination means you are working hard in positions you do not yet own. We keep the load flat and add a joint prep block ahead of the primary lift.`,
      suggestedCategory: "goata",
      suggestedMovementIds: ["mv-goata-01", "mv-goata-02"],
      confidence: 0.82,
    });
  }

  if (hrv.length >= 3 && hrv[0] < avg(hrv) * 0.92) {
    out.push({
      id: "rec-hrv",
      headline: "Downshift before the next hard session",
      rationale: `Your most recent HRV reading (${hrv[0]}ms) is below your rolling average (${Math.round(avg(hrv))}ms). Nothing alarming — but the adaptation window is narrower right now. A regulation session before the next heavy day is worth more than pushing through it.`,
      suggestedCategory: "flow",
      suggestedMovementIds: ["mv-flow-04", "mv-flow-02"],
      confidence: 0.71,
    });
  }

  if (sleep.length && avg(sleep) < 7) {
    out.push({
      id: "rec-sleep",
      headline: "Sleep is under-supporting your strength progression",
      rationale: `Averaging ${avg(sleep).toFixed(1)}h across logged sessions. Strength adaptations are consolidated in sleep, so we hold progression on the primary lift rather than adding load you cannot yet absorb.`,
      suggestedCategory: "cardio",
      suggestedMovementIds: ["mv-cardio-04"],
      confidence: 0.68,
    });
  }

  if (soreness.filter((s) => s.includes("back")).length >= 1) {
    out.push({
      id: "rec-posterior",
      headline: "Add hip internal rotation before the next hinge day",
      rationale:
        "Low-back soreness reported after hinge work. When the hip runs out of internal rotation the lumbar spine supplies the difference. 90/90 work before the session usually resolves this within two weeks.",
      suggestedCategory: "primal",
      suggestedMovementIds: ["mv-primal-04", "mv-fn-04"],
      confidence: 0.76,
    });
  }

  if (!out.length) {
    out.push({
      id: "rec-progress",
      headline: "Green light — progress the primary lift",
      rationale: `Quality (${quality.toFixed(1)}/5), RPE (${rpe.toFixed(1)}/10) and recovery markers are all where we want them. Add load to the primary strength movement and hold everything else constant so we can attribute the response.`,
      suggestedCategory: "hybrid",
      suggestedMovementIds: ["mv-hybrid-01", "mv-hybrid-02"],
      confidence: 0.79,
    });
  }

  return out;
}
