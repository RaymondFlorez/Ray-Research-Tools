import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/overlay";
import { LogoMark, Wordmark } from "@/components/layout/logo";
import { CATEGORIES, CATEGORY_ORDER, posterStyle } from "@/lib/data/taxonomy";
import { MOVEMENTS } from "@/lib/data/movements";
import { COACHES } from "@/lib/data/people";
import { Avatar } from "@/components/layout/logo";

const OUTCOMES = [
  {
    value: "Joint health",
    label: "Chains that track correctly under load, for decades.",
  },
  {
    value: "Movement quality",
    label: "Range you can use, transitions you actually own.",
  },
  {
    value: "Aesthetic development",
    label: "Muscle earned through positions worth keeping.",
  },
  {
    value: "Cardiovascular resilience",
    label: "An aerobic base that funds everything else.",
  },
  {
    value: "Mental clarity",
    label: "The capacity to downshift on demand.",
  },
];

export default function LandingPage() {
  return (
    <div className="relative">
      {/* ---- Marketing chrome ------------------------------------------- */}
      <header className="chrome-blur sticky top-0 z-50 border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5 text-ink">
            <LogoMark size={26} />
            <Wordmark className="text-[12px]" />
          </Link>
          <nav className="hidden items-center gap-7 text-small text-ink-2 md:flex">
            <Link href="/philosophy" className="transition-colors hover:text-ink">
              Philosophy
            </Link>
            <Link href="/library" className="transition-colors hover:text-ink">
              Library
            </Link>
            <Link href="/store" className="transition-colors hover:text-ink">
              Store
            </Link>
            <Link href="/pulse" className="transition-colors hover:text-ink">
              Pulse
            </Link>
          </nav>
          <div className="flex items-center gap-2.5">
            <Button href="/today" variant="ghost" size="sm" className="hidden sm:inline-flex">
              Sign in
            </Button>
            <Button href="/onboarding" size="sm" variant="metal">
              Begin
            </Button>
          </div>
        </div>
      </header>

      {/* ---- Hero -------------------------------------------------------- */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="animate-breathe pointer-events-none absolute top-[-22rem] left-1/2 h-[46rem] w-[46rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(184,184,192,0.13),transparent_66%)] blur-2xl"
        />
        <div className="relative mx-auto max-w-6xl px-5 pt-20 pb-24 sm:px-8 sm:pt-32 sm:pb-32">
          <Reveal>
            <p className="eyebrow">A modern synthesis training system</p>
          </Reveal>
          <Reveal delay={0.06}>
            <h1 className="mt-6 max-w-4xl text-[clamp(2.6rem,7.4vw,4.75rem)] leading-[1.01] font-medium tracking-[-0.04em]">
              <span className="text-metal">Train smarter.</span>
              <br />
              <span className="text-ink">Move better.</span>
              <br />
              <span className="text-ink-3">Last longer.</span>
            </h1>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mt-8 max-w-xl text-[17px] leading-[1.7] text-ink-2">
              Alpha Movement fuses GOATA joint mechanics, primal patterns,
              internal arts, hybrid strength, and dosed cardio into one coherent
              system. Training is never simply harder here — it is more
              connected, more precise, and built to be repeated for decades.
            </p>
          </Reveal>
          <Reveal delay={0.18}>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Button href="/onboarding" size="lg">
                Start with the philosophy
                <ArrowRight size={16} />
              </Button>
              <Button href="/library" size="lg" variant="secondary">
                Explore the movement library
              </Button>
            </div>
          </Reveal>
          <Reveal delay={0.24}>
            <dl className="mt-16 grid gap-x-8 gap-y-6 border-t border-line pt-8 sm:grid-cols-3">
              {[
                ["Six pillars", "One connected system, not six programmes."],
                [
                  `${MOVEMENTS.length} movements`,
                  "Every one with cues and a reason it exists.",
                ],
                ["Coach-led", "Live, in-person, group, or asynchronous."],
              ].map(([term, detail]) => (
                <div key={term}>
                  <dt className="text-[15px] font-medium text-ink">{term}</dt>
                  <dd className="mt-1 text-small leading-relaxed text-ink-3">
                    {detail}
                  </dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </section>

      <div className="rule-metal mx-auto max-w-6xl" />

      {/* ---- The six pillars --------------------------------------------- */}
      <section className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <p className="eyebrow">The system</p>
          <h2 className="mt-4 max-w-2xl text-[clamp(1.75rem,4vw,2.5rem)] leading-[1.1] font-medium tracking-[-0.028em] text-ink">
            Six pillars, sequenced deliberately.
          </h2>
          <p className="mt-4 max-w-xl text-body leading-relaxed text-ink-2">
            The order matters. Joints are organised before they are loaded;
            the nervous system is regulated before it is stressed. Nothing here
            is optional decoration.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORY_ORDER.map((id, index) => {
            const meta = CATEGORIES[id];
            const count = MOVEMENTS.filter((m) => m.category === id).length;
            return (
              <Reveal key={id} delay={index * 0.05}>
                <Link
                  href={`/library?category=${id}`}
                  className="group surface-card block h-full p-6 transition-all duration-300 ease-[var(--ease-out-quint)] hover:-translate-y-1 hover:border-line-strong hover:shadow-mid"
                >
                  <div className="flex items-start justify-between">
                    <span
                      className="grid h-8 w-8 place-items-center rounded-full border text-[11px] font-medium tabular-nums"
                      style={{
                        borderColor: `color-mix(in oklab, ${meta.colorVar} 35%, transparent)`,
                        color: meta.colorVar,
                      }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <ArrowUpRight
                      size={16}
                      className="text-ink-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                    />
                  </div>
                  <h3 className="mt-5 text-[17px] leading-snug font-medium tracking-[-0.012em] text-ink">
                    {meta.name}
                  </h3>
                  <p className="mt-2.5 text-small leading-relaxed text-ink-2">
                    {meta.premise}
                  </p>
                  <p className="mt-5 text-[12px] text-ink-3 tabular-nums">
                    {count} movements
                  </p>
                </Link>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* ---- What it produces --------------------------------------------- */}
      <section className="border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
          <Reveal>
            <p className="eyebrow">What the system prioritises</p>
            <h2 className="mt-4 max-w-2xl text-[clamp(1.75rem,4vw,2.5rem)] leading-[1.1] font-medium tracking-[-0.028em] text-ink">
              Five outcomes. Every decision serves one of them.
            </h2>
          </Reveal>
          <ul className="mt-12 divide-y divide-line border-y border-line">
            {OUTCOMES.map((outcome, index) => (
              <Reveal key={outcome.value} delay={index * 0.04}>
                <li className="grid gap-2 py-6 sm:grid-cols-[minmax(0,18rem)_1fr] sm:gap-10">
                  <span className="text-[17px] font-medium tracking-[-0.012em] text-ink">
                    {outcome.value}
                  </span>
                  <span className="text-body leading-relaxed text-ink-2">
                    {outcome.label}
                  </span>
                </li>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      {/* ---- Coaches ------------------------------------------------------ */}
      <section className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <p className="eyebrow">Coaching</p>
          <h2 className="mt-4 max-w-2xl text-[clamp(1.75rem,4vw,2.5rem)] leading-[1.1] font-medium tracking-[-0.028em] text-ink">
            Programmed by people who specialise narrowly.
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {COACHES.map((coach, index) => (
            <Reveal key={coach.id} delay={index * 0.05}>
              <article className="surface-card h-full p-6">
                <div className="flex items-center gap-3.5">
                  <Avatar seed={coach.avatarSeed} name={coach.name} size={42} />
                  <div>
                    <h3 className="text-[15px] font-medium text-ink">
                      {coach.name}
                    </h3>
                    <p className="text-[13px] text-ink-3">{coach.title}</p>
                  </div>
                </div>
                <p className="mt-4 text-small leading-relaxed text-ink-2">
                  {coach.bio}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---- Closing ------------------------------------------------------ */}
      <section className="relative overflow-hidden border-t border-line">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-70"
          style={posterStyle("titanium")}
        />
        <div className="relative mx-auto max-w-3xl px-5 py-28 text-center sm:px-8">
          <Reveal>
            <LogoMark size={38} className="mx-auto text-accent" />
            <h2 className="mt-8 text-[clamp(1.85rem,4.6vw,2.75rem)] leading-[1.08] font-medium tracking-[-0.03em] text-ink">
              Begin with the philosophy, not the workout.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-body leading-relaxed text-ink-2">
              Six minutes of onboarding that teaches you the system and sets your
              training focus. No pitch, no urgency timer.
            </p>
            <div className="mt-9 flex justify-center">
              <Button href="/onboarding" size="lg" variant="metal">
                Start onboarding
                <ArrowRight size={16} />
              </Button>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-[13px] text-ink-3 sm:px-8">
          <div className="flex items-center gap-2.5">
            <LogoMark size={20} />
            <span>© {new Date().getFullYear()} Alpha Movement</span>
          </div>
          <nav className="flex flex-wrap gap-6">
            <Link href="/philosophy" className="transition-colors hover:text-ink-2">
              Philosophy
            </Link>
            <Link href="/library" className="transition-colors hover:text-ink-2">
              Library
            </Link>
            <Link href="/sessions" className="transition-colors hover:text-ink-2">
              Sessions
            </Link>
            <Link href="/store" className="transition-colors hover:text-ink-2">
              Store
            </Link>
            <Link href="/pulse" className="transition-colors hover:text-ink-2">
              Pulse
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
