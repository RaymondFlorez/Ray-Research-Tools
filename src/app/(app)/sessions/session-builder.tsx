"use client";

import * as React from "react";
import { Check, Plus, Sparkles, X } from "lucide-react";
import type {
  Coach,
  MovementCategory,
  RecurrenceRule,
  SessionBlock,
  SessionType,
  TrainingSession,
} from "@/types";
import { Modal } from "@/components/ui/overlay";
import { Button, IconButton } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { MovementRow } from "@/components/movement/movement-card";
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/data/taxonomy";
import { MOVEMENTS } from "@/lib/data/movements";
import { getMovementsByIds } from "@/lib/data/repository";
import {
  RECURRENCE_LABEL,
  SESSION_TYPE_META,
  isWithinAvailability,
  zoneAbbrev,
} from "@/lib/calendar";
import { useAppStore } from "@/lib/store/app-store";
import { cn } from "@/lib/utils";

/* ============================================================================
   SESSION BUILDER
   Either request a session from a coach, or have the system propose one. The
   proposal is generated from the same block order the philosophy describes:
   organise → express → condition → downshift.
   ========================================================================= */

const DEFAULT_BLOCK_ORDER: MovementCategory[] = [
  "goata",
  "primal",
  "hybrid",
  "functional",
  "cardio",
  "flow",
];

export function SessionBuilder({
  open,
  seedStartsAt,
  ...rest
}: {
  open: boolean;
  onClose: () => void;
  coaches: Coach[];
  timezone: string;
  seedStartsAt: string | null;
  weekStart: Date;
  onCreated: () => void;
}) {
  if (!open) return null;
  // Remounting per open (and per seeded slot) initialises the form from the
  // seed and clears it on close, with no reset effects.
  return (
    <BuilderForm key={seedStartsAt ?? "new"} seedStartsAt={seedStartsAt} {...rest} />
  );
}

function BuilderForm({
  onClose,
  coaches,
  timezone,
  seedStartsAt,
  weekStart,
  onCreated,
}: {
  onClose: () => void;
  coaches: Coach[];
  timezone: string;
  seedStartsAt: string | null;
  weekStart: Date;
  onCreated: () => void;
}) {
  const addSession = useAppStore((s) => s.addSession);
  const focus = useAppStore((s) => s.focus);

  const [title, setTitle] = React.useState("");
  const [coachId, setCoachId] = React.useState(coaches[0]?.id ?? "");
  const [type, setType] = React.useState<SessionType>("live");
  const [recurrence, setRecurrence] = React.useState<RecurrenceRule>("none");
  const [durationMin, setDurationMin] = React.useState(60);
  const [notes, setNotes] = React.useState("");
  const [blocks, setBlocks] = React.useState<SessionBlock[]>([]);
  const [pickerCategory, setPickerCategory] =
    React.useState<MovementCategory | null>(null);

  // Local datetime string for the <input type="datetime-local"> control.
  // Seeded from the clicked grid slot, or the week's default morning slot.
  const [when, setWhen] = React.useState(() =>
    toLocalInput(
      seedStartsAt ? new Date(seedStartsAt) : defaultSlot(weekStart),
    ),
  );

  const coach = coaches.find((c) => c.id === coachId);
  const startsAt = when ? new Date(when).toISOString() : null;

  const availabilityOk =
    coach && startsAt
      ? isWithinAvailability(startsAt, coach.timezone, coach.availability)
      : true;

  const programmedMin = blocks.reduce((sum, b) => sum + b.durationMin, 0);

  /* ---- AI-assisted proposal ---------------------------------------------- */

  const proposeSession = () => {
    // Grounded in the philosophy's block order, weighted by the athlete's focus.
    const wanted: MovementCategory[] = ["goata"];
    if (focus.includes("mobility-flow") || focus.includes("joint-health"))
      wanted.push("primal");
    if (focus.includes("hybrid-athlete")) wanted.push("hybrid");
    if (focus.includes("aesthetics")) wanted.push("functional");
    if (focus.includes("endurance")) wanted.push("cardio");
    wanted.push("flow");

    const unique = DEFAULT_BLOCK_ORDER.filter((c) => wanted.includes(c));
    const chosen = unique.length > 2 ? unique : ["goata", "hybrid", "flow"];

    const proposed: SessionBlock[] = (chosen as MovementCategory[]).map(
      (category, index) => {
        const pool = MOVEMENTS.filter((m) => m.category === category);
        const take = category === "goata" ? 2 : index === chosen.length - 1 ? 1 : 2;
        return {
          category,
          label: blockLabel(category),
          movementIds: pool.slice(0, take).map((m) => m.id),
          durationMin: category === "goata" ? 12 : category === "flow" ? 10 : 20,
        };
      },
    );

    setBlocks(proposed);
    setTitle(title || "Alpha Movement — proposed session");
    setDurationMin(proposed.reduce((sum, b) => sum + b.durationMin, 0));
  };

  const addBlock = (category: MovementCategory) => {
    setBlocks((current) => [
      ...current,
      {
        category,
        label: blockLabel(category),
        movementIds: [],
        durationMin: 15,
      },
    ]);
    setPickerCategory(category);
  };

  const toggleMovement = (blockIndex: number, movementId: string) =>
    setBlocks((current) =>
      current.map((block, i) =>
        i === blockIndex
          ? {
              ...block,
              movementIds: block.movementIds.includes(movementId)
                ? block.movementIds.filter((id) => id !== movementId)
                : [...block.movementIds, movementId],
            }
          : block,
      ),
    );

  const submit = () => {
    if (!startsAt || !coachId) return;
    const session: Omit<TrainingSession, "id"> = {
      title: title.trim() || "Training session",
      type,
      status: "requested",
      coachId,
      clientId: "user-01",
      startsAt,
      durationMin: Math.max(durationMin, programmedMin || durationMin),
      timezone,
      recurrence,
      blocks,
      notes: notes.trim() || undefined,
      reminders: [
        { channel: "push", minutesBefore: 30 },
        { channel: "email", minutesBefore: 720 },
      ],
    };
    addSession(session);
    onCreated();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Build a session"
      description="Request a session with a coach, or let the system propose one grounded in Alpha Movement's block order."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!startsAt || !coachId}>
            Request session
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" className="sm:col-span-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Joint prep + lower body"
            />
          </Field>

          <Field label="Coach" required>
            <Select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.specialties.map((s) => CATEGORIES[s].short).join(", ")}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Session type">
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as SessionType)}
            >
              {(Object.keys(SESSION_TYPE_META) as SessionType[]).map((t) => (
                <option key={t} value={t}>
                  {SESSION_TYPE_META[t].label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Starts"
            required
            hint={`Shown in ${zoneAbbrev(timezone)}`}
          >
            <Input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </Field>

          <Field label="Duration">
            <Select
              value={String(durationMin)}
              onChange={(e) => setDurationMin(Number(e.target.value))}
            >
              {[30, 45, 60, 75, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Repeats" className="sm:col-span-2">
            <Select
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as RecurrenceRule)}
            >
              {(Object.keys(RECURRENCE_LABEL) as RecurrenceRule[]).map((r) => (
                <option key={r} value={r}>
                  {RECURRENCE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {coach && !availabilityOk && (
          <div className="rounded-[11px] border border-warning/35 bg-warning/8 px-4 py-3">
            <p className="text-[13px] text-warning">
              Outside {coach.name}&rsquo;s posted availability
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
              You can still send the request — it will go through as a proposal
              rather than a confirmed booking.
            </p>
          </div>
        )}

        {/* ---- Blocks ------------------------------------------------------ */}
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[15px] font-medium text-ink">Programming</h3>
              <p className="mt-0.5 text-[12px] text-ink-3 tabular-nums">
                {blocks.length} blocks · {programmedMin} min
              </p>
            </div>
            <Button variant="metal" size="sm" onClick={proposeSession}>
              <Sparkles size={14} />
              Propose for me
            </Button>
          </div>

          <div className="mt-4 space-y-3">
            {blocks.map((block, index) => {
              const meta = CATEGORIES[block.category];
              const movements = getMovementsByIds(block.movementIds);
              const expanded = pickerCategory === block.category;
              return (
                <div
                  key={`${block.category}-${index}`}
                  className="rounded-card border border-line bg-surface/50 p-4"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: meta.colorVar }}
                    />
                    <Input
                      value={block.label}
                      onChange={(e) =>
                        setBlocks((current) =>
                          current.map((b, i) =>
                            i === index ? { ...b, label: e.target.value } : b,
                          ),
                        )
                      }
                      className="h-8 flex-1 border-transparent bg-transparent px-1 text-[13px] font-medium"
                      aria-label="Block label"
                    />
                    <Select
                      value={String(block.durationMin)}
                      onChange={(e) =>
                        setBlocks((current) =>
                          current.map((b, i) =>
                            i === index
                              ? { ...b, durationMin: Number(e.target.value) }
                              : b,
                          ),
                        )
                      }
                      className="h-8 w-24 text-[12px]"
                      aria-label="Block duration"
                    >
                      {[5, 10, 12, 15, 20, 25, 30, 40, 45].map((m) => (
                        <option key={m} value={m}>
                          {m} min
                        </option>
                      ))}
                    </Select>
                    <IconButton
                      label="Remove block"
                      onClick={() =>
                        setBlocks((current) => current.filter((_, i) => i !== index))
                      }
                    >
                      <X size={14} />
                    </IconButton>
                  </div>

                  {movements.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      {movements.map((movement) => (
                        <MovementRow
                          key={movement.id}
                          movement={movement}
                          right={
                            <button
                              onClick={() => toggleMovement(index, movement.id)}
                              aria-label={`Remove ${movement.name}`}
                              className="text-ink-3 hover:text-danger"
                            >
                              <X size={13} />
                            </button>
                          }
                        />
                      ))}
                    </div>
                  )}

                  <button
                    onClick={() =>
                      setPickerCategory(expanded ? null : block.category)
                    }
                    className="mt-3 text-[12px] text-ink-3 hover:text-ink-2"
                  >
                    {expanded ? "Done choosing" : "Choose movements"}
                  </button>

                  {expanded && (
                    <div className="mt-3 grid max-h-52 gap-1.5 overflow-y-auto rounded-[10px] border border-line bg-void/40 p-2">
                      {MOVEMENTS.filter((m) => m.category === block.category).map(
                        (movement) => {
                          const selected = block.movementIds.includes(movement.id);
                          return (
                            <button
                              key={movement.id}
                              onClick={() => toggleMovement(index, movement.id)}
                              className={cn(
                                "flex items-center justify-between gap-3 rounded-[9px] px-3 py-2 text-left text-[13px] transition-colors",
                                selected
                                  ? "bg-elevated text-ink"
                                  : "text-ink-2 hover:bg-elevated/60",
                              )}
                            >
                              <span className="truncate">{movement.name}</span>
                              {selected && (
                                <Check size={13} className="shrink-0 text-positive" />
                              )}
                            </button>
                          );
                        },
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-4">
            <p className="eyebrow mb-2">Add a block</p>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_ORDER.map((category) => (
                <button
                  key={category}
                  onClick={() => addBlock(category)}
                  className="inline-flex items-center gap-1.5 rounded-pill border border-line px-3 py-1 text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
                >
                  <Plus size={12} />
                  {CATEGORIES[category].short}
                </button>
              ))}
            </div>
          </div>
        </section>

        <Field label="Note for your coach" hint="Optional">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Right hip has been catching. Happy to keep load flat this week."
          />
        </Field>

        {coach && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Badge tone="accent">{coach.name}</Badge>
            {coach.specialties.map((s) => (
              <Badge key={s}>{CATEGORIES[s].short}</Badge>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* --- helpers --------------------------------------------------------------- */

function blockLabel(category: MovementCategory) {
  const labels: Record<MovementCategory, string> = {
    goata: "Joint organisation",
    primal: "Ground transitions",
    flow: "Downshift",
    hybrid: "Primary strength",
    functional: "Accessory at length",
    cardio: "Conditioning",
  };
  return labels[category];
}

function defaultSlot(weekStart: Date) {
  const slot = new Date(weekStart);
  slot.setDate(slot.getDate() + 1);
  slot.setHours(8, 0, 0, 0);
  return slot;
}

function toLocalInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
