import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/overlay";
import { Badge } from "@/components/ui/primitives";
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/data/taxonomy";
import { MOVEMENTS } from "@/lib/data/movements";

export const metadata: Metadata = {
  title: "Philosophy",
  description:
    "The Alpha Movement system: six pillars sequenced so joints are organised before they are loaded and the nervous system is regulated before it is stressed.",
};

/** The three principles that govern how the six pillars are combined. */
const PRINCIPLES = [
  {
    title: "Connection before load",
    body: "A joint that does not track correctly does not get stronger under load — it gets more efficient at compensating. Every session in this system opens with joint organisation, and every progression is gated on quality rather than on the calendar.",
  },
  {
    title: "Dose, don't survive",
    body: "Intensity is a tool with a prescription. Zone 2 has a purpose that sprinting cannot serve, and sprinting has a purpose that zone 2 cannot. Training that mixes everything into one hard blur produces fatigue, not adaptation.",
  },
  {
    title: "Downshift is training",
    body: "Adaptation happens in recovery, so the ability to leave a high-arousal state is a trainable athletic quality, not a lifestyle accessory. Internal arts and breath work are in the programme for the same reason the deadlift is.",
  },
];

export default function PhilosophyPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="The Alpha Movement system"
        title="Training is not harder here. It is more connected."
        description="Six disciplines, one architecture. GOATA supplies the joint mechanics, primal patterns supply the vocabulary, internal arts supply regulation, and hybrid and functional work supply the output. The order they are applied in is the actual method."
        action={
          <Button href="/library" variant="secondary">
            Open the library
            <ArrowRight size={15} />
          </Button>
        }
      />

      {/* ---- Governing principles ---------------------------------------- */}
      <section className="py-14">
        <div className="grid gap-4 lg:grid-cols-3">
          {PRINCIPLES.map((principle, index) => (
            <Reveal key={principle.title} delay={index * 0.06}>
              <article className="surface-card h-full p-6">
                <span className="eyebrow">Principle {index + 1}</span>
                <h2 className="mt-4 text-[19px] leading-snug font-medium tracking-[-0.018em] text-ink">
                  {principle.title}
                </h2>
                <p className="mt-3.5 text-small leading-relaxed text-ink-2">
                  {principle.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <div className="rule-metal" />

      {/* ---- The six pillars, in order ------------------------------------ */}
      <section className="py-14">
        <div className="max-w-2xl">
          <p className="eyebrow">The six pillars</p>
          <h2 className="mt-3.5 text-[clamp(1.6rem,3.4vw,2.2rem)] leading-[1.12] font-medium tracking-[-0.025em] text-ink">
            Read top to bottom. That is the sequence a session follows.
          </h2>
        </div>

        <ol className="mt-12 space-y-3">
          {CATEGORY_ORDER.map((id, index) => {
            const meta = CATEGORIES[id];
            const movements = MOVEMENTS.filter((m) => m.category === id);
            return (
              <Reveal key={id} delay={index * 0.04}>
                <li className="surface-card group overflow-hidden">
                  <div className="grid gap-6 p-6 sm:p-7 lg:grid-cols-[7rem_1fr_auto] lg:items-start">
                    <div className="flex items-center gap-3 lg:block">
                      <span
                        className="grid h-10 w-10 place-items-center rounded-full border text-[13px] font-medium tabular-nums"
                        style={{
                          borderColor: `color-mix(in oklab, ${meta.colorVar} 38%, transparent)`,
                          color: meta.colorVar,
                        }}
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="eyebrow lg:mt-3 lg:block">
                        {meta.short}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <h3 className="text-[19px] leading-snug font-medium tracking-[-0.018em] text-ink">
                        {meta.name}
                      </h3>
                      <p
                        className="mt-2 text-small font-medium"
                        style={{ color: meta.colorVar }}
                      >
                        {meta.premise}
                      </p>
                      <p className="mt-4 max-w-2xl text-body leading-relaxed text-ink-2">
                        {meta.detail}
                      </p>
                      <div className="mt-5 flex flex-wrap gap-1.5">
                        {[...new Set(movements.map((m) => m.group))].map((group) => (
                          <Badge key={group}>{group}</Badge>
                        ))}
                      </div>
                    </div>

                    <Link
                      href={`/library?category=${id}`}
                      className="inline-flex items-center gap-1.5 self-start rounded-pill border border-line px-3.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
                    >
                      {movements.length} movements
                      <ArrowUpRight size={14} />
                    </Link>
                  </div>
                </li>
              </Reveal>
            );
          })}
        </ol>
      </section>

      <div className="rule-metal" />

      {/* ---- How a session is built --------------------------------------- */}
      <section className="py-14">
        <div className="max-w-2xl">
          <p className="eyebrow">Applied</p>
          <h2 className="mt-3.5 text-[clamp(1.6rem,3.4vw,2.2rem)] leading-[1.12] font-medium tracking-[-0.025em] text-ink">
            What this looks like inside one hour.
          </h2>
          <p className="mt-4 text-body leading-relaxed text-ink-2">
            Every Alpha Movement session — whether a coach writes it or the
            programming engine proposes it — is assembled from blocks in this
            order. The proportions change; the sequence does not.
          </p>
        </div>

        <div className="mt-10 overflow-hidden rounded-panel border border-line">
          {[
            {
              phase: "Organise",
              minutes: "10–15 min",
              pillars: "GOATA · Primal",
              body: "Foot, hip, and scapular organisation. Ground transitions to wake the cross-body pattern. Nothing here is a warm-up in the traditional sense — it is the part of the session that determines whether the rest is safe.",
            },
            {
              phase: "Express",
              minutes: "25–40 min",
              pillars: "Hybrid · Functional",
              body: "The primary strength or hypertrophy work, in full range, at prescribed tempo. Progression is applied to quality first, then range, then load — in that order, without exception.",
            },
            {
              phase: "Condition",
              minutes: "10–30 min",
              pillars: "Cardio",
              body: "Dosed to the day: zone 2 to build the base, tempo to raise the threshold, or short sprints with full recovery. Never all three, never as punishment.",
            },
            {
              phase: "Downshift",
              minutes: "5–10 min",
              pillars: "Flow",
              body: "Long-exhale breathing or a short internal-arts sequence. This is the block most people skip and the one that decides whether today's work becomes tomorrow's adaptation.",
            },
          ].map((phase, index, all) => (
            <div
              key={phase.phase}
              className={`grid gap-4 p-6 sm:grid-cols-[10rem_1fr] sm:gap-8 sm:p-7 ${
                index < all.length - 1 ? "border-b border-line" : ""
              }`}
            >
              <div>
                <p className="text-[15px] font-medium text-ink">{phase.phase}</p>
                <p className="mt-1 text-[13px] text-ink-3 tabular-nums">
                  {phase.minutes}
                </p>
                <p className="mt-2.5 text-[12px] text-ink-3">{phase.pillars}</p>
              </div>
              <p className="text-body leading-relaxed text-ink-2">{phase.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- CTA ----------------------------------------------------------- */}
      <section className="pb-16">
        <div className="surface-elevated flex flex-wrap items-center justify-between gap-6 p-8">
          <div className="max-w-lg">
            <h2 className="text-heading text-ink">
              Set your focus and the system adapts to it.
            </h2>
            <p className="mt-2.5 text-small leading-relaxed text-ink-2">
              Onboarding takes about six minutes and shapes your library
              ordering, session recommendations, and Pulse feed.
            </p>
          </div>
          <Button href="/onboarding" variant="metal" size="lg">
            Set training focus
            <ArrowRight size={16} />
          </Button>
        </div>
      </section>
    </Container>
  );
}
