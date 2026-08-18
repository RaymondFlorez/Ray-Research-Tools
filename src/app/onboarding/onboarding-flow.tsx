"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress, Select } from "@/components/ui/primitives";
import { LogoMark, Wordmark } from "@/components/layout/logo";
import { CATEGORIES, CATEGORY_ORDER, FOCUS_META, FOCUS_ORDER, LEVEL_META } from "@/lib/data/taxonomy";
import { useAppStore } from "@/lib/store/app-store";
import { useLocalTimezone } from "@/lib/hooks/use-client";
import type { SkillLevel, TrainingFocus } from "@/types";
import { cn } from "@/lib/utils";

/* ============================================================================
   ONBOARDING
   Teaches the philosophy first and asks for preferences second. Six screens,
   no pricing, no urgency. The athlete should leave understanding the system
   even if they never buy anything.
   ========================================================================= */

const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Stockholm",
  "Asia/Singapore",
  "Australia/Sydney",
];

const STEPS = ["welcome", "pillars", "principle", "focus", "level", "done"] as const;
type Step = (typeof STEPS)[number];

export function OnboardingFlow() {
  const router = useRouter();
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);

  const [index, setIndex] = React.useState(0);
  const [direction, setDirection] = React.useState(1);
  const [focus, setFocus] = React.useState<TrainingFocus[]>([]);
  const [level, setLevel] = React.useState<SkillLevel>("foundation");

  // Default to the athlete's detected zone; their explicit pick wins over it.
  const detectedZone = useLocalTimezone();
  const [timezoneChoice, setTimezoneChoice] = React.useState<string | null>(null);
  const timezone =
    timezoneChoice ??
    (TIMEZONES.includes(detectedZone) ? detectedZone : "America/Los_Angeles");

  const step: Step = STEPS[index];
  const canAdvance = step !== "focus" || focus.length > 0;

  const go = (delta: number) => {
    setDirection(delta);
    setIndex((i) => Math.min(STEPS.length - 1, Math.max(0, i + delta)));
  };

  const finish = () => {
    completeOnboarding({ focus, level, timezone });
    router.push("/today");
  };

  const toggleFocus = (value: TrainingFocus) =>
    setFocus((current) =>
      current.includes(value)
        ? current.filter((f) => f !== value)
        : [...current, value],
    );

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 text-ink">
          <LogoMark size={24} />
          <Wordmark className="text-[11px]" />
        </Link>
        <Link
          href="/today"
          className="text-[13px] text-ink-3 transition-colors hover:text-ink-2"
        >
          Skip for now
        </Link>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 sm:px-8">
        <Progress value={((index + 1) / STEPS.length) * 100} />
        <p className="mt-3 text-[12px] text-ink-3 tabular-nums">
          {index + 1} of {STEPS.length}
        </p>
      </div>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-5 py-10 sm:px-8">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={step}
            custom={direction}
            initial={{ opacity: 0, x: direction * 26 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction * -26 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
          >
            {step === "welcome" && <WelcomeStep />}
            {step === "pillars" && <PillarsStep />}
            {step === "principle" && <PrincipleStep />}
            {step === "focus" && (
              <FocusStep selected={focus} onToggle={toggleFocus} />
            )}
            {step === "level" && (
              <LevelStep
                level={level}
                onLevel={setLevel}
                timezone={timezone}
                onTimezone={setTimezoneChoice}
              />
            )}
            {step === "done" && <DoneStep focus={focus} level={level} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="sticky bottom-0 chrome-blur border-t border-line">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Button
            variant="ghost"
            onClick={() => go(-1)}
            disabled={index === 0}
            aria-label="Previous step"
          >
            <ArrowLeft size={15} />
            Back
          </Button>
          {step === "done" ? (
            <Button variant="metal" size="lg" onClick={finish}>
              Enter Alpha Movement
              <ArrowRight size={16} />
            </Button>
          ) : (
            <Button onClick={() => go(1)} disabled={!canAdvance} size="lg">
              Continue
              <ArrowRight size={16} />
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

/* --- Steps ---------------------------------------------------------------- */

function StepShell({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="mt-5 text-[clamp(1.85rem,4.6vw,2.7rem)] leading-[1.08] font-medium tracking-[-0.032em] text-ink">
        {title}
      </h1>
      {children}
    </div>
  );
}

function WelcomeStep() {
  return (
    <StepShell
      eyebrow="Welcome"
      title={
        <>
          <span className="text-metal">Before the training,</span>
          <br />
          the system it comes from.
        </>
      }
    >
      <p className="mt-7 max-w-xl text-[17px] leading-[1.7] text-ink-2">
        Most training apps hand you a workout and hope you keep opening them.
        This one starts by explaining what it believes, because the programming
        only makes sense once you understand the sequence behind it.
      </p>
      <p className="mt-5 max-w-xl text-body leading-relaxed text-ink-3">
        Six minutes. Four short explanations and two questions.
      </p>
    </StepShell>
  );
}

function PillarsStep() {
  return (
    <StepShell
      eyebrow="The system"
      title="Six disciplines, one architecture."
    >
      <p className="mt-6 max-w-xl text-body leading-relaxed text-ink-2">
        Each pillar does a job the others cannot. Sequenced correctly, they
        compound; mixed arbitrarily, they compete.
      </p>
      <ul className="mt-9 space-y-px overflow-hidden rounded-panel border border-line">
        {CATEGORY_ORDER.map((id, i) => {
          const meta = CATEGORIES[id];
          return (
            <li
              key={id}
              className="flex items-start gap-4 bg-surface/60 px-5 py-4"
            >
              <span
                className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[11px] tabular-nums"
                style={{
                  borderColor: `color-mix(in oklab, ${meta.colorVar} 38%, transparent)`,
                  color: meta.colorVar,
                }}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-ink">{meta.name}</p>
                <p className="mt-0.5 text-small leading-relaxed text-ink-2">
                  {meta.premise}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </StepShell>
  );
}

function PrincipleStep() {
  return (
    <StepShell
      eyebrow="The governing rule"
      title="Connection before load."
    >
      <p className="mt-7 max-w-xl text-[17px] leading-[1.7] text-ink-2">
        A joint that does not track correctly does not get stronger under load.
        It gets more efficient at compensating — and that compensation is the
        bill that arrives ten years later.
      </p>
      <p className="mt-5 max-w-xl text-body leading-relaxed text-ink-2">
        So every session opens with joint organisation, every progression is
        gated on movement quality rather than the calendar, and every hard day
        is paired with a downshift. It is slower at the start and considerably
        faster over a decade.
      </p>
      <blockquote className="mt-9 border-l border-titanium/40 pl-5 text-[17px] leading-relaxed text-ink italic">
        Training is never just harder. It is smarter, more connected, and more
        sustainable.
      </blockquote>
    </StepShell>
  );
}

function FocusStep({
  selected,
  onToggle,
}: {
  selected: TrainingFocus[];
  onToggle: (value: TrainingFocus) => void;
}) {
  return (
    <StepShell eyebrow="Question 1 of 2" title="What are you training toward?">
      <p className="mt-5 max-w-xl text-body leading-relaxed text-ink-2">
        Pick as many as apply. This orders your library, weights your session
        recommendations, and personalises your Pulse feed. You can change it any
        time.
      </p>
      <div className="mt-8 grid gap-2.5 sm:grid-cols-2">
        {FOCUS_ORDER.map((id) => {
          const meta = FOCUS_META[id];
          const active = selected.includes(id);
          return (
            <button
              key={id}
              onClick={() => onToggle(id)}
              aria-pressed={active}
              className={cn(
                "group relative rounded-card border p-5 text-left transition-all duration-250 ease-[var(--ease-out-quint)]",
                active
                  ? "border-titanium/55 bg-titanium/8 shadow-glow"
                  : "border-line bg-surface hover:-translate-y-0.5 hover:border-line-strong",
              )}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="text-[15px] font-medium text-ink">
                  {meta.label}
                </span>
                <span
                  className={cn(
                    "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors",
                    active
                      ? "border-accent-hi bg-accent-hi text-void"
                      : "border-line-strong text-transparent",
                  )}
                >
                  <Check size={12} strokeWidth={3} />
                </span>
              </span>
              <span className="mt-2 block text-small leading-relaxed text-ink-2">
                {meta.description}
              </span>
            </button>
          );
        })}
      </div>
    </StepShell>
  );
}

function LevelStep({
  level,
  onLevel,
  timezone,
  onTimezone,
}: {
  level: SkillLevel;
  onLevel: (value: SkillLevel) => void;
  timezone: string;
  onTimezone: (value: string) => void;
}) {
  return (
    <StepShell eyebrow="Question 2 of 2" title="Where are you starting?">
      <p className="mt-5 max-w-xl text-body leading-relaxed text-ink-2">
        Be honest rather than optimistic. Every athlete runs Foundations first
        regardless — this only decides how quickly the progressions open.
      </p>
      <div className="mt-8 space-y-2.5">
        {(Object.keys(LEVEL_META) as SkillLevel[]).map((id) => {
          const meta = LEVEL_META[id];
          const active = level === id;
          return (
            <button
              key={id}
              onClick={() => onLevel(id)}
              aria-pressed={active}
              className={cn(
                "flex w-full items-center justify-between gap-4 rounded-card border p-5 text-left transition-all duration-250",
                active
                  ? "border-titanium/55 bg-titanium/8"
                  : "border-line bg-surface hover:border-line-strong",
              )}
            >
              <span>
                <span className="block text-[15px] font-medium text-ink">
                  {meta.label}
                </span>
                <span className="mt-1 block text-small text-ink-2">
                  {meta.note}
                </span>
              </span>
              <span
                className={cn(
                  "grid h-5 w-5 shrink-0 place-items-center rounded-full border",
                  active
                    ? "border-accent-hi bg-accent-hi text-void"
                    : "border-line-strong text-transparent",
                )}
              >
                <Check size={12} strokeWidth={3} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-8 max-w-sm">
        <label
          htmlFor="onboarding-timezone"
          className="mb-2 block text-[13px] font-medium text-ink-2"
        >
          Time zone
        </label>
        <Select
          id="onboarding-timezone"
          value={timezone}
          onChange={(e) => onTimezone(e.target.value)}
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <p className="mt-2 text-[12px] text-ink-3">
          Sessions are scheduled in your coach&rsquo;s zone and always displayed
          in yours.
        </p>
      </div>
    </StepShell>
  );
}

function DoneStep({
  focus,
  level,
}: {
  focus: TrainingFocus[];
  level: SkillLevel;
}) {
  return (
    <StepShell eyebrow="Set" title="Your system is configured.">
      <p className="mt-6 max-w-xl text-body leading-relaxed text-ink-2">
        Everything below is adjustable from your profile. Nothing is locked, and
        no recommendation will ever be made without telling you what it read.
      </p>
      <dl className="mt-9 space-y-px overflow-hidden rounded-panel border border-line">
        <div className="grid gap-2 bg-surface/60 px-5 py-4 sm:grid-cols-[9rem_1fr]">
          <dt className="text-small text-ink-3">Focus</dt>
          <dd className="flex flex-wrap gap-1.5">
            {focus.length ? (
              focus.map((f) => (
                <span
                  key={f}
                  className="rounded-pill border border-titanium/30 bg-titanium/10 px-2.5 py-0.5 text-[12px] text-accent-hi"
                >
                  {FOCUS_META[f].label}
                </span>
              ))
            ) : (
              <span className="text-small text-ink-3">Not set</span>
            )}
          </dd>
        </div>
        <div className="grid gap-2 bg-surface/60 px-5 py-4 sm:grid-cols-[9rem_1fr]">
          <dt className="text-small text-ink-3">Starting level</dt>
          <dd className="text-small text-ink">{LEVEL_META[level].label}</dd>
        </div>
        <div className="grid gap-2 bg-surface/60 px-5 py-4 sm:grid-cols-[9rem_1fr]">
          <dt className="text-small text-ink-3">First cycle</dt>
          <dd className="text-small text-ink">
            Alpha Foundations — joint mechanics before load
          </dd>
        </div>
      </dl>
    </StepShell>
  );
}
