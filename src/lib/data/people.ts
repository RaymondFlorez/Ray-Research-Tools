import type { Coach, UserProfile } from "@/types";

/* ============================================================================
   PEOPLE — coaches and the demo athlete.
   In production these come from User/Coach in prisma/schema.prisma; the shape
   here is identical so the repository swap is mechanical.
   ========================================================================= */

/** Weekday availability helper — hours are local to the coach's timezone. */
const window = (weekday: number, startHour: number, endHour: number) => ({
  weekday,
  startMin: startHour * 60,
  endMin: endHour * 60,
});

export const COACHES: Coach[] = [
  {
    id: "coach-01",
    name: "Marco Ferreira",
    title: "Head of Movement · GOATA & Locomotion",
    bio: "Marco came to Alpha Movement from twelve years in track and field rehab, where he watched the same knee and hip presentations arrive season after season. He now spends his coaching hours upstream of that — rebuilding foot and hip mechanics before load is ever added. Sessions with Marco are quiet, precise, and slower than most athletes expect.",
    specialties: ["goata", "primal"],
    timezone: "America/Los_Angeles",
    availability: [
      window(1, 6, 12),
      window(2, 6, 12),
      window(3, 6, 12),
      window(4, 6, 12),
      window(5, 7, 11),
    ],
    sessionRateCents: 21000,
    avatarSeed: "titanium",
    credentials: ["GOATA Certified", "CSCS", "MSc Sports Rehabilitation"],
  },
  {
    id: "coach-02",
    name: "Ines Okafor",
    title: "Internal Arts & Nervous System",
    bio: "Ines trained in Chen-style Tai Chi for eighteen years before bringing internal-arts methodology into performance settings. Her work is the regulation layer of the system: breath, weight transfer, and the ability to downshift on demand. Athletes who arrive unable to sleep after hard sessions usually end up here first.",
    specialties: ["flow", "primal"],
    timezone: "Europe/Lisbon",
    availability: [
      window(1, 8, 13),
      window(3, 8, 13),
      window(4, 15, 19),
      window(6, 9, 12),
    ],
    sessionRateCents: 18500,
    avatarSeed: "sage",
    credentials: [
      "Chen-style Tai Chi — 18 yrs",
      "Registered Yoga Teacher 500",
      "Oxygen Advantage Instructor",
    ],
  },
  {
    id: "coach-03",
    name: "Dane Whitfield",
    title: "Hybrid Performance & Programming",
    bio: "Dane built his coaching practice around athletes who refuse to pick a lane — the marathoner who wants a double-bodyweight deadlift, the lifter who wants to run a half without falling apart. He handles the periodisation that keeps strength and aerobic work from eating each other.",
    specialties: ["hybrid", "cardio", "functional"],
    timezone: "America/New_York",
    availability: [
      window(1, 6, 10),
      window(2, 6, 10),
      window(2, 16, 20),
      window(4, 6, 10),
      window(4, 16, 20),
      window(6, 8, 12),
    ],
    sessionRateCents: 19500,
    avatarSeed: "steel",
    credentials: ["CSCS", "UESCA Endurance Coach", "Precision Nutrition L2"],
  },
  {
    id: "coach-04",
    name: "Sera Lindqvist",
    title: "Functional Bodybuilding & Aesthetics",
    bio: "Sera's programming is where the aesthetic side of Alpha Movement lives — full-range, tempo-driven work that builds shape without quietly costing you your shoulders. She is unusually rigorous about position and unusually patient about load.",
    specialties: ["functional", "hybrid"],
    timezone: "Europe/Stockholm",
    availability: [
      window(1, 15, 20),
      window(2, 15, 20),
      window(3, 15, 20),
      window(5, 9, 14),
    ],
    sessionRateCents: 17500,
    avatarSeed: "clay",
    credentials: ["NASM-CPT", "Functional Bodybuilding L2", "BSc Kinesiology"],
  },
];

export const COACHES_BY_ID = new Map(COACHES.map((c) => [c.id, c]));

/** The signed-in athlete for the demo experience. */
export const CURRENT_USER: UserProfile = {
  id: "user-01",
  name: "Ray Florez",
  email: "rlf21287@gmail.com",
  role: "client",
  timezone: "America/Los_Angeles",
  focus: ["joint-health", "hybrid-athlete", "mobility-flow"],
  level: "developing",
  joinedAt: "2026-02-11T00:00:00.000Z",
  avatarSeed: "titanium",
};
