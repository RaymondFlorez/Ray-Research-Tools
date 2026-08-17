import type { PulseArticle } from "@/types";

/* ============================================================================
   PULSE — NEWS & TRENDS
   ---------------------------------------------------------------------------
   IMPORTANT: the records below are illustrative seed content written for this
   build. Sources and headlines are placeholders, not real publications, and the
   UI labels the feed as sample content until the aggregation pipeline is
   connected. See docs/ARCHITECTURE.md § Pulse ingestion for the production
   path: RSS/API ingest → dedupe → summarise → editorial review → publish.
   ========================================================================= */

export const PULSE_IS_SAMPLE_CONTENT = true;

export const PULSE_ARTICLES: PulseArticle[] = [
  {
    id: "pulse-01",
    slug: "tendon-stiffness-isometrics-review",
    title:
      "Isometric loading and tendon stiffness: what the current evidence supports",
    source: "Sample Source — Applied Strength Review",
    sourceUrl: "https://example.com/pulse/tendon-stiffness",
    publishedAt: "2026-08-15T09:00:00.000Z",
    topic: "training-science",
    summary:
      "A review of long-duration isometric protocols and their effect on tendon stiffness, with attention to how much of the reported benefit survives once training status is controlled for.",
    alphaTake:
      "This lines up with why our split squat work holds the bottom position rather than bouncing out of it. Tendon adapts to time under tension at length, and it adapts far more slowly than muscle — which is exactly why we progress range and tempo before we progress load. Nothing here changes the programme; it explains why the programme is patient.",
    takeAuthor: "Dane Whitfield",
    readMinutes: 6,
    relatedFocus: ["joint-health", "hybrid-athlete"],
    poster: "titanium",
  },
  {
    id: "pulse-02",
    slug: "zone-2-dose-response",
    title: "How much zone 2 is enough? Revisiting the dose-response question",
    source: "Sample Source — Endurance Quarterly",
    sourceUrl: "https://example.com/pulse/zone-2-dose",
    publishedAt: "2026-08-14T07:30:00.000Z",
    topic: "training-science",
    summary:
      "An examination of weekly low-intensity volume against markers of mitochondrial density, and where the returns start flattening for non-elite athletes.",
    alphaTake:
      "The useful finding for our athletes is the floor, not the ceiling. Two to three sessions a week produces most of the available adaptation for people who are also lifting. If you are training hybrid, more zone 2 is not free — it competes for the recovery your strength work needs.",
    takeAuthor: "Dane Whitfield",
    readMinutes: 8,
    relatedFocus: ["endurance", "hybrid-athlete"],
    poster: "steel",
  },
  {
    id: "pulse-03",
    slug: "hip-internal-rotation-low-back",
    title: "Hip internal rotation deficits and lumbar load: a mechanical account",
    source: "Sample Source — Journal of Movement Mechanics",
    sourceUrl: "https://example.com/pulse/hip-ir-lumbar",
    publishedAt: "2026-08-12T11:15:00.000Z",
    topic: "movement-culture",
    summary:
      "Modelling work on how restricted hip internal rotation redistributes rotational demand toward the lumbar spine during hinge and rotational tasks.",
    alphaTake:
      "This is the mechanism behind one of the most common notes we write after a hinge session: when the hip cannot rotate internally, the low back supplies the difference. It is why 90/90 work sits in the warm-up rather than the cool-down, and why we screen it quarterly.",
    takeAuthor: "Marco Ferreira",
    readMinutes: 7,
    relatedFocus: ["joint-health", "mobility-flow"],
    poster: "slate",
  },
  {
    id: "pulse-04",
    slug: "hrv-guided-training-practical-limits",
    title: "HRV-guided training: useful signal, frequently over-read",
    source: "Sample Source — Recovery Science Digest",
    sourceUrl: "https://example.com/pulse/hrv-guided",
    publishedAt: "2026-08-11T16:40:00.000Z",
    topic: "recovery-longevity",
    summary:
      "A practical assessment of daily HRV readings as an autoregulation input, including measurement noise and the trap of reacting to single-day variation.",
    alphaTake:
      "We use HRV as a trend, never as a verdict. A single low reading is noise; a week below your own baseline is information. Our programming engine deliberately looks at rolling averages for this reason, and it tells you what it read so you can disagree with it.",
    takeAuthor: "Alpha Movement Editorial",
    readMinutes: 5,
    relatedFocus: ["nervous-system", "endurance"],
    poster: "plum",
  },
  {
    id: "pulse-05",
    slug: "long-exhale-vagal-tone",
    title: "Extended exhalation and parasympathetic tone: the current picture",
    source: "Sample Source — Breath & Autonomics Review",
    sourceUrl: "https://example.com/pulse/long-exhale",
    publishedAt: "2026-08-09T08:00:00.000Z",
    topic: "mind-body",
    summary:
      "A survey of research on exhale-biased breathing patterns and measurable shifts in heart-rate variability and subjective arousal.",
    alphaTake:
      "The reason our sessions end with five minutes of long-exhale work rather than a stretch. Downshifting is a trainable skill with a measurable output, and it is the cheapest intervention in the entire system.",
    takeAuthor: "Ines Okafor",
    readMinutes: 4,
    relatedFocus: ["nervous-system"],
    poster: "sage",
  },
  {
    id: "pulse-06",
    slug: "hybrid-training-interference-effect",
    title: "The interference effect, forty years on: how much still holds?",
    source: "Sample Source — Applied Strength Review",
    sourceUrl: "https://example.com/pulse/interference-effect",
    publishedAt: "2026-08-07T13:20:00.000Z",
    topic: "training-science",
    summary:
      "Revisiting concurrent training research with modern methodology, focusing on session sequencing, recovery windows, and where interference genuinely appears.",
    alphaTake:
      "Interference is real but far more manageable than the folklore suggests — it is mostly a scheduling problem. Separate the hard aerobic session from the heavy lift by a day, keep the base work genuinely easy, and the two qualities coexist. That is the whole architecture of the Hybrid Engine cycle.",
    takeAuthor: "Dane Whitfield",
    readMinutes: 9,
    relatedFocus: ["hybrid-athlete", "endurance"],
    poster: "steel",
  },
  {
    id: "pulse-07",
    slug: "training-at-long-muscle-lengths",
    title: "Hypertrophy at long muscle lengths keeps outperforming short-range work",
    source: "Sample Source — Hypertrophy Research Notes",
    sourceUrl: "https://example.com/pulse/long-length-hypertrophy",
    publishedAt: "2026-08-05T10:05:00.000Z",
    topic: "training-science",
    summary:
      "Accumulating evidence that partial-range work biased toward the stretched position produces growth comparable to or exceeding full-range training.",
    alphaTake:
      "This is functional bodybuilding's best argument. Training at length builds shape and keeps end range strong at the same time — the joint gets safer while the muscle gets bigger. It is why our tempo work insists on a real stretch instead of a bounce.",
    takeAuthor: "Sera Lindqvist",
    readMinutes: 6,
    relatedFocus: ["aesthetics", "joint-health"],
    poster: "clay",
  },
  {
    id: "pulse-08",
    slug: "floor-sitting-populations-hip-range",
    title: "Floor-sitting populations and retained hip range through the decades",
    source: "Sample Source — Movement Anthropology Notes",
    sourceUrl: "https://example.com/pulse/floor-sitting",
    publishedAt: "2026-08-03T09:45:00.000Z",
    topic: "movement-culture",
    summary:
      "Observational work comparing hip and ankle range across populations with habitual floor-sitting versus chair-dominant cultures.",
    alphaTake:
      "The deep squat is not a mobility achievement in most of the world — it is a chair. We put it in the library as a position to inhabit rather than a test to pass, and the difference between those two framings is most of the result.",
    takeAuthor: "Marco Ferreira",
    readMinutes: 5,
    relatedFocus: ["mobility-flow", "joint-health"],
    poster: "ash",
  },
  {
    id: "pulse-09",
    slug: "sleep-and-strength-consolidation",
    title: "Sleep restriction blunts strength adaptation more than it blunts effort",
    source: "Sample Source — Recovery Science Digest",
    sourceUrl: "https://example.com/pulse/sleep-strength",
    publishedAt: "2026-08-01T12:00:00.000Z",
    topic: "recovery-longevity",
    summary:
      "Research on partial sleep restriction showing preserved session output alongside meaningfully reduced adaptation over a training block.",
    alphaTake:
      "The uncomfortable part is that you can still train well on poor sleep — you just do not keep it. This is why our engine holds progression on low-sleep weeks instead of rewarding you for grinding through them.",
    takeAuthor: "Alpha Movement Editorial",
    readMinutes: 6,
    relatedFocus: ["nervous-system", "hybrid-athlete"],
    poster: "plum",
  },
  {
    id: "pulse-10",
    slug: "walking-gait-mechanics-load-distribution",
    title: "Gait retraining and load distribution: small changes, high volume",
    source: "Sample Source — Journal of Movement Mechanics",
    sourceUrl: "https://example.com/pulse/gait-retraining",
    publishedAt: "2026-07-29T15:30:00.000Z",
    topic: "movement-culture",
    summary:
      "Analysis of how modest changes in foot contact and hip drive alter cumulative joint loading across thousands of daily steps.",
    alphaTake:
      "Gait is the highest-volume pattern in your life and the one almost nobody coaches. A small change repeated four thousand times a day outweighs anything you do in a sixty-minute session. This is why Connected Gait Walkout is in the foundation tier.",
    takeAuthor: "Marco Ferreira",
    readMinutes: 7,
    relatedFocus: ["joint-health", "endurance"],
    poster: "slate",
  },
  {
    id: "pulse-11",
    slug: "meditative-movement-and-attention",
    title: "Meditative movement practices and sustained attention: a meta-review",
    source: "Sample Source — Mind & Movement Review",
    sourceUrl: "https://example.com/pulse/meditative-movement",
    publishedAt: "2026-07-26T08:20:00.000Z",
    topic: "mind-body",
    summary:
      "Pooled findings on Tai Chi, qigong, and slow-flow yoga practices and their measured effects on attention, balance, and self-reported stress.",
    alphaTake:
      "The balance findings interest us more than the stress findings. Slow weight transfer trains the same deceleration capacity as our GOATA work with none of the impact cost — which makes internal arts a genuine training input, not a wellness garnish.",
    takeAuthor: "Ines Okafor",
    readMinutes: 8,
    relatedFocus: ["nervous-system", "mobility-flow"],
    poster: "sage",
  },
  {
    id: "pulse-12",
    slug: "vo2max-all-cause-mortality",
    title: "Cardiorespiratory fitness remains among the strongest longevity markers",
    source: "Sample Source — Longevity Evidence Brief",
    sourceUrl: "https://example.com/pulse/crf-longevity",
    publishedAt: "2026-07-22T11:00:00.000Z",
    topic: "recovery-longevity",
    summary:
      "A summary of cohort evidence linking measured cardiorespiratory fitness to all-cause mortality, with attention to the size of the effect at the low end of the distribution.",
    alphaTake:
      "The largest gains are at the bottom of the range, which is a strong argument for the unglamorous base work. If you take one thing from the Alpha Movement cardio pillar, it is that zone 2 is a longevity intervention that happens to also make you fitter.",
    takeAuthor: "Alpha Movement Editorial",
    readMinutes: 5,
    relatedFocus: ["endurance", "joint-health"],
    poster: "steel",
  },
];

export const PULSE_BY_SLUG = new Map(PULSE_ARTICLES.map((a) => [a.slug, a]));
