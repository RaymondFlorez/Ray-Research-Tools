"use client";

import * as React from "react";
import {
  Bell,
  CalendarCheck,
  MapPin,
  Repeat,
  Trash2,
  Video,
} from "lucide-react";
import type { Coach, SessionLog, TrainingSession } from "@/types";
import { Modal } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Badge, Field, Progress, Select, Textarea } from "@/components/ui/primitives";
import { MovementRow } from "@/components/movement/movement-card";
import { Avatar } from "@/components/layout/logo";
import { CATEGORIES } from "@/lib/data/taxonomy";
import { getMovementsByIds } from "@/lib/data/repository";
import {
  RECURRENCE_LABEL,
  SESSION_TYPE_META,
  formatDayLong,
  formatTime,
  zoneAbbrev,
} from "@/lib/calendar";
import { useAppStore } from "@/lib/store/app-store";
import { cn } from "@/lib/utils";

/* ============================================================================
   SESSION DETAIL
   Two modes in one panel: the programming (before) and the log (after). The
   log is the feedback loop — what it captures is exactly what the programming
   engine reads back.
   ========================================================================= */

export function SessionDetail({
  session,
  ...rest
}: {
  session: TrainingSession | null;
  coaches: Coach[];
  timezone: string;
  log: SessionLog | null;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  if (!session) return null;
  // Keying by session id remounts the panel per session, so its local view
  // state (programming vs. log) resets without an effect.
  return <SessionDetailPanel key={session.id} session={session} {...rest} />;
}

function SessionDetailPanel({
  session,
  coaches,
  timezone,
  log,
  onClose,
  onToast,
}: {
  session: TrainingSession;
  coaches: Coach[];
  timezone: string;
  log: SessionLog | null;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const cancelSession = useAppStore((s) => s.cancelSession);
  const logSession = useAppStore((s) => s.logSession);
  const [logging, setLogging] = React.useState(false);

  const coach = coaches.find((c) => c.id === session.coachId);
  const typeMeta = SESSION_TYPE_META[session.type];
  const start = new Date(session.startsAt);
  const totalBlockMin = session.blocks.reduce((sum, b) => sum + b.durationMin, 0);

  return (
    <Modal
      open
      onClose={onClose}
      title={session.title}
      description={`${formatDayLong(start)} · ${formatTime(session.startsAt, timezone)} ${zoneAbbrev(timezone, start)} · ${session.durationMin} min`}
      size="lg"
      footer={
        logging ? undefined : (
          <>
            <Button
              variant="danger"
              onClick={() => {
                cancelSession(session.id);
                onClose();
                onToast("Session cancelled");
              }}
            >
              <Trash2 size={14} />
              Cancel session
            </Button>
            <div className="flex-1" />
            {session.status === "completed" && !log ? (
              <Button onClick={() => setLogging(true)}>Log this session</Button>
            ) : session.joinUrl ? (
              <Button href={session.joinUrl}>
                <Video size={15} />
                Join session
              </Button>
            ) : (
              <Button onClick={() => setLogging(true)} variant="secondary">
                Log session
              </Button>
            )}
          </>
        )
      }
    >
      {logging ? (
        <LogForm
          session={session}
          existing={log}
          onCancel={() => setLogging(false)}
          onSave={(entry) => {
            logSession(entry);
            setLogging(false);
            onClose();
            onToast("Session logged — feedback added to your programming");
          }}
        />
      ) : (
        <div className="space-y-6">
          {/* ---- Meta --------------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={session.status === "requested" ? "warning" : "accent"}>
              {session.status}
            </Badge>
            <Badge>{typeMeta.label}</Badge>
            {session.recurrence !== "none" && (
              <Badge>
                <Repeat size={11} />
                {RECURRENCE_LABEL[session.recurrence]}
              </Badge>
            )}
          </div>

          {coach && (
            <div className="flex items-start gap-3.5 rounded-card border border-line bg-surface/50 p-4">
              <Avatar seed={coach.avatarSeed} name={coach.name} size={40} />
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-ink">{coach.name}</p>
                <p className="text-[12px] text-ink-3">{coach.title}</p>
                <p className="mt-1.5 text-[12px] text-ink-3">
                  Coaching from {coach.timezone.split("/")[1]?.replace(/_/g, " ")} ·{" "}
                  {formatTime(session.startsAt, coach.timezone)}{" "}
                  {zoneAbbrev(coach.timezone, start)} their time
                </p>
              </div>
            </div>
          )}

          {(session.location || session.joinUrl) && (
            <div className="flex items-center gap-2 text-small text-ink-2">
              {session.location ? (
                <>
                  <MapPin size={14} className="text-ink-3" />
                  {session.location}
                </>
              ) : (
                <>
                  <Video size={14} className="text-ink-3" />
                  Live video session
                </>
              )}
            </div>
          )}

          {session.notes && (
            <div className="rounded-card border border-line bg-surface/50 p-4">
              <p className="eyebrow">Session note</p>
              <p className="mt-2 text-small leading-relaxed text-ink-2">
                {session.notes}
              </p>
            </div>
          )}

          {/* ---- Programming --------------------------------------------- */}
          <section>
            <div className="flex items-baseline justify-between">
              <h3 className="text-[15px] font-medium text-ink">Programming</h3>
              <span className="text-[12px] text-ink-3 tabular-nums">
                {totalBlockMin} min programmed
              </span>
            </div>
            <div className="mt-4 space-y-4">
              {session.blocks.map((block, index) => {
                const meta = CATEGORIES[block.category];
                const movements = getMovementsByIds(block.movementIds);
                return (
                  <div key={`${block.label}-${index}`}>
                    <div className="mb-2.5 flex items-center gap-2.5">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: meta.colorVar }}
                      />
                      <p className="text-[13px] font-medium text-ink">
                        {block.label}
                      </p>
                      <span className="text-[12px] text-ink-3">
                        {meta.short}
                      </span>
                      <span className="ml-auto text-[12px] text-ink-3 tabular-nums">
                        {block.durationMin} min
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {movements.map((movement) => (
                        <MovementRow key={movement.id} movement={movement} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ---- Reminders ------------------------------------------------ */}
          <section className="rounded-card border border-line p-4">
            <div className="flex items-center gap-2">
              <Bell size={14} className="text-ink-3" />
              <p className="text-[13px] font-medium text-ink">Reminders</p>
            </div>
            <ul className="mt-2.5 space-y-1.5">
              {session.reminders.map((reminder) => (
                <li key={`${reminder.channel}-${reminder.minutesBefore}`} className="text-[12px] text-ink-2">
                  {reminder.channel === "push" ? "Push" : "Email"} ·{" "}
                  {reminder.minutesBefore >= 60
                    ? `${Math.round(reminder.minutesBefore / 60)} hours before`
                    : `${reminder.minutesBefore} minutes before`}
                </li>
              ))}
            </ul>
          </section>

          {/* ---- Existing log --------------------------------------------- */}
          {log && (
            <section className="rounded-card border border-line bg-surface/50 p-5">
              <div className="flex items-center gap-2">
                <CalendarCheck size={14} className="text-positive" />
                <p className="text-[13px] font-medium text-ink">Session log</p>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <LogStat label="Quality" value={`${log.movementQuality}/5`} />
                <LogStat label="RPE" value={`${log.rpe}/10`} />
                {log.hrvMs && <LogStat label="HRV" value={`${log.hrvMs}ms`} />}
                {log.sleepHours && (
                  <LogStat label="Sleep" value={`${log.sleepHours}h`} />
                )}
              </dl>
              {log.athleteNote && (
                <p className="mt-4 text-small leading-relaxed text-ink-2">
                  <span className="text-ink-3">You — </span>
                  {log.athleteNote}
                </p>
              )}
              {log.coachNote && (
                <p className="mt-2.5 text-small leading-relaxed text-ink-2">
                  <span className="text-ink-3">{coach?.name ?? "Coach"} — </span>
                  {log.coachNote}
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

function LogStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] tracking-[0.1em] text-ink-3 uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-[17px] font-medium text-ink tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/* --- Log form -------------------------------------------------------------- */

const SORENESS_OPTIONS = [
  "hamstrings",
  "quads",
  "glutes",
  "low back",
  "shoulders",
  "chest",
  "calves",
  "hips",
];

function LogForm({
  session,
  existing,
  onSave,
  onCancel,
}: {
  session: TrainingSession;
  existing: SessionLog | null;
  onSave: (log: SessionLog) => void;
  onCancel: () => void;
}) {
  const [quality, setQuality] = React.useState(existing?.movementQuality ?? 4);
  const [rpe, setRpe] = React.useState(existing?.rpe ?? 6);
  const [sleep, setSleep] = React.useState(existing?.sleepHours ?? 7.5);
  const [hrv, setHrv] = React.useState(existing?.hrvMs ?? 70);
  const [soreness, setSoreness] = React.useState<string[]>(
    existing?.soreness ?? [],
  );
  const [note, setNote] = React.useState(existing?.athleteNote ?? "");

  const submit = () =>
    onSave({
      sessionId: session.id,
      completedAt: new Date().toISOString(),
      movementQuality: quality,
      rpe,
      sleepHours: sleep,
      hrvMs: hrv,
      soreness,
      athleteNote: note.trim() || undefined,
    });

  return (
    <div className="space-y-6">
      <p className="text-small leading-relaxed text-ink-2">
        Answer honestly rather than favourably. These five inputs are what the
        programming engine reads, and an inflated quality score buys you a
        progression you are not ready for.
      </p>

      <ScaleInput
        label="Movement quality"
        hint="How well did you own the positions? Not how hard it felt."
        value={quality}
        min={1}
        max={5}
        onChange={setQuality}
        labels={["Poor", "Owned"]}
      />

      <ScaleInput
        label="RPE"
        hint="Rate of perceived exertion across the whole session."
        value={rpe}
        min={1}
        max={10}
        onChange={setRpe}
        labels={["Easy", "Maximal"]}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sleep last night" hint="Hours">
          <Select
            value={String(sleep)}
            onChange={(e) => setSleep(Number(e.target.value))}
          >
            {[5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map((h) => (
              <option key={h} value={h}>
                {h}h
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Morning HRV" hint="Milliseconds — optional">
          <Select
            value={String(hrv)}
            onChange={(e) => setHrv(Number(e.target.value))}
          >
            {[45, 50, 55, 60, 65, 70, 75, 80, 85, 90].map((v) => (
              <option key={v} value={v}>
                {v}ms
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <p className="mb-2 text-[13px] font-medium text-ink-2">Soreness</p>
        <div className="flex flex-wrap gap-1.5">
          {SORENESS_OPTIONS.map((area) => {
            const active = soreness.includes(area);
            return (
              <button
                key={area}
                onClick={() =>
                  setSoreness((current) =>
                    active
                      ? current.filter((s) => s !== area)
                      : [...current, area],
                  )
                }
                aria-pressed={active}
                className={cn(
                  "rounded-pill border px-3 py-1 text-[12px] transition-colors",
                  active
                    ? "border-warning/45 bg-warning/12 text-warning"
                    : "border-line text-ink-3 hover:border-line-strong hover:text-ink-2",
                )}
              >
                {area}
              </button>
            );
          })}
        </div>
      </div>

      <Field label="Note for your coach" hint="Optional">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Right hip still catches on the deceleration step."
        />
      </Field>

      <div className="flex items-center justify-end gap-3 border-t border-line pt-5">
        <Button variant="ghost" onClick={onCancel}>
          Back
        </Button>
        <Button onClick={submit}>Save log</Button>
      </div>
    </div>
  );
}

function ScaleInput({
  label,
  hint,
  value,
  min,
  max,
  onChange,
  labels,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  labels: [string, string];
}) {
  const steps = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-[13px] font-medium text-ink-2">{label}</p>
        <p className="text-[15px] font-medium text-ink tabular-nums">
          {value}
          <span className="text-ink-3">/{max}</span>
        </p>
      </div>
      <p className="mt-0.5 text-[12px] text-ink-3">{hint}</p>
      <div className="mt-3 flex gap-1">
        {steps.map((step) => (
          <button
            key={step}
            onClick={() => onChange(step)}
            aria-label={`${label} ${step}`}
            aria-pressed={value === step}
            className={cn(
              "h-8 flex-1 rounded-[7px] border text-[12px] tabular-nums transition-all duration-200",
              value === step
                ? "border-accent-hi bg-accent-hi font-medium text-void"
                : value > step
                  ? "border-line bg-elevated text-ink-2"
                  : "border-line text-ink-3 hover:border-line-strong",
            )}
          >
            {step}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-3">
        <span>{labels[0]}</span>
        <span>{labels[1]}</span>
      </div>
      <Progress
        className="mt-3"
        value={((value - min) / (max - min)) * 100}
        tone={value / max > 0.75 ? "warning" : "accent"}
      />
    </div>
  );
}
