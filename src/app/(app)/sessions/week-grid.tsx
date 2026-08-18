"use client";

import * as React from "react";
import { motion } from "motion/react";
import type { Coach, TrainingSession } from "@/types";
import { CATEGORIES } from "@/lib/data/taxonomy";
import {
  DAY_LABELS,
  GRID,
  GRID_HEIGHT,
  addDays,
  columnIndex,
  formatTime,
  heightPx,
  instantFromGridPosition,
  isSameDay,
  isWithinAvailability,
  layoutDay,
  minutesFromGridStart,
  snapMinutes,
  topOffsetPx,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

/* ============================================================================
   WEEK GRID
   Drag-and-drop is built on pointer events rather than a DnD library: the drag
   target is a positioned pill inside a known grid, so the geometry is exact and
   the interaction stays smooth on touch without a dependency.
   ========================================================================= */

interface DragState {
  sessionId: string;
  pointerId: number;
  originX: number;
  originY: number;
  dx: number;
  dy: number;
  startColumn: number;
  startMinutes: number;
}

export function WeekGrid({
  weekStart,
  sessions,
  coaches,
  timezone,
  now,
  onMove,
  onSelect,
  onCreateAt,
}: {
  weekStart: Date;
  sessions: TrainingSession[];
  coaches: Coach[];
  timezone: string;
  now: Date | null;
  onMove: (sessionId: string, startsAt: string) => void;
  onSelect: (session: TrainingSession) => void;
  onCreateAt: (startsAt: string) => void;
}) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<DragState | null>(null);

  const columns = React.useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const byDay = React.useMemo(() => {
    const buckets: TrainingSession[][] = Array.from({ length: 7 }, () => []);
    for (const session of sessions) {
      const column = columnIndex(session.startsAt, timezone, weekStart);
      if (column >= 0 && column <= 6) buckets[column].push(session);
    }
    return buckets;
  }, [sessions, timezone, weekStart]);

  /* ---- Drag lifecycle ---------------------------------------------------- */

  const beginDrag = (
    event: React.PointerEvent,
    session: TrainingSession,
    column: number,
  ) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({
      sessionId: session.id,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      dx: 0,
      dy: 0,
      startColumn: column,
      startMinutes: minutesFromGridStart(session.startsAt, timezone),
    });
  };

  const updateDrag = (event: React.PointerEvent) => {
    setDrag((current) =>
      current && current.pointerId === event.pointerId
        ? {
            ...current,
            dx: event.clientX - current.originX,
            dy: event.clientY - current.originY,
          }
        : current,
    );
  };

  const endDrag = (event: React.PointerEvent) => {
    const current = drag;
    setDrag(null);
    if (!current || current.pointerId !== event.pointerId) return;

    const grid = gridRef.current;
    if (!grid) return;

    // A drag under a few pixels is a click, not a move.
    if (Math.abs(current.dx) < 4 && Math.abs(current.dy) < 4) {
      const session = sessions.find((s) => s.id === current.sessionId);
      if (session) onSelect(session);
      return;
    }

    const columnWidth = grid.clientWidth / 7;
    const columnDelta = Math.round(current.dx / columnWidth);
    const minuteDelta = (current.dy / GRID.pxPerHour) * 60;

    const nextColumn = Math.min(
      6,
      Math.max(0, current.startColumn + columnDelta),
    );
    const nextMinutes = Math.min(
      (GRID.endHour - GRID.startHour) * 60 - 15,
      Math.max(0, snapMinutes(current.startMinutes + minuteDelta)),
    );

    onMove(
      current.sessionId,
      instantFromGridPosition(weekStart, nextColumn, nextMinutes, timezone),
    );
  };

  /* ---- Click empty space to create --------------------------------------- */

  const handleGridClick = (event: React.MouseEvent, column: number) => {
    if (drag) return;
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const minutes = snapMinutes(
      ((event.clientY - rect.top) / GRID.pxPerHour) * 60,
      30,
    );
    onCreateAt(
      instantFromGridPosition(
        weekStart,
        column,
        Math.max(0, minutes),
        timezone,
      ),
    );
  };

  const hours = Array.from(
    { length: GRID.endHour - GRID.startHour + 1 },
    (_, i) => GRID.startHour + i,
  );

  const nowOffset =
    now && columns.some((day) => isSameDay(day, now))
      ? topOffsetPx(now.toISOString(), timezone)
      : null;
  const nowColumn = now
    ? columns.findIndex((day) => isSameDay(day, now))
    : -1;

  return (
    <div className="surface-card overflow-hidden">
      {/* ---- Day headers ---------------------------------------------------- */}
      <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line">
        <div />
        {columns.map((day) => {
          const today = now ? isSameDay(day, now) : false;
          return (
            <div
              key={day.toISOString()}
              className={cn(
                "border-l border-line px-2 py-3 text-center",
                today && "bg-elevated/60",
              )}
            >
              <p className="text-[11px] tracking-[0.1em] text-ink-3 uppercase">
                {DAY_LABELS[(day.getDay() + 6) % 7]}
              </p>
              <p
                className={cn(
                  "mt-1 text-[15px] tabular-nums",
                  today ? "font-medium text-ink" : "text-ink-2",
                )}
              >
                {day.getDate()}
              </p>
            </div>
          );
        })}
      </div>

      {/* ---- Scrollable grid ------------------------------------------------ */}
      <div className="max-h-[68vh] overflow-y-auto">
        <div className="relative grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
          {/* Hour gutter */}
          <div className="relative" style={{ height: GRID_HEIGHT }}>
            {hours.map((hour, i) => (
              <span
                key={hour}
                className="absolute right-2 -translate-y-1/2 text-[11px] text-ink-3 tabular-nums"
                style={{ top: i * GRID.pxPerHour }}
              >
                {hour % 12 === 0 ? 12 : hour % 12}
                {hour < 12 ? "a" : "p"}
              </span>
            ))}
          </div>

          {/* Day columns */}
          <div
            ref={gridRef}
            className="relative col-span-7 grid grid-cols-7"
            style={{ height: GRID_HEIGHT }}
          >
            {/* Hour rules */}
            {hours.map((hour, i) => (
              <div
                key={hour}
                aria-hidden
                className="pointer-events-none absolute inset-x-0 border-t border-line/70"
                style={{ top: i * GRID.pxPerHour }}
              />
            ))}

            {columns.map((day, column) => {
              const laid = layoutDay(byDay[column], timezone);
              return (
                <div
                  key={day.toISOString()}
                  onClick={(e) => handleGridClick(e, column)}
                  className="relative border-l border-line transition-colors hover:bg-elevated/25"
                >
                  {/* Coach availability shading */}
                  <AvailabilityShade
                    day={day}
                    coaches={coaches}
                    timezone={timezone}
                    weekStart={weekStart}
                    column={column}
                  />

                  {laid.map(({ session, lane, lanes }) => (
                    <SessionPill
                      key={session.id}
                      session={session}
                      timezone={timezone}
                      lane={lane}
                      lanes={lanes}
                      dragging={drag?.sessionId === session.id ? drag : null}
                      onPointerDown={(e) => beginDrag(e, session, column)}
                      onPointerMove={updateDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={() => setDrag(null)}
                    />
                  ))}
                </div>
              );
            })}

            {/* Current-time indicator */}
            {nowOffset !== null && nowColumn >= 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute z-20"
                style={{
                  top: nowOffset,
                  left: `${(nowColumn / 7) * 100}%`,
                  width: `${100 / 7}%`,
                }}
              >
                <div className="relative h-px bg-danger/70">
                  <span className="absolute top-1/2 -left-1 h-2 w-2 -translate-y-1/2 rounded-full bg-danger" />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* --- Session pill ---------------------------------------------------------- */

function SessionPill({
  session,
  timezone,
  lane,
  lanes,
  dragging,
  ...handlers
}: {
  session: TrainingSession;
  timezone: string;
  lane: number;
  lanes: number;
  dragging: DragState | null;
} & Pick<
  React.HTMLAttributes<HTMLDivElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
>) {
  const primary = session.blocks[0]?.category ?? "hybrid";
  const accent = CATEGORIES[primary].colorVar;
  const width = 100 / lanes;

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={`${session.title}, ${formatTime(session.startsAt, timezone)}`}
      {...handlers}
      animate={{
        x: dragging?.dx ?? 0,
        y: dragging?.dy ?? 0,
        scale: dragging ? 1.02 : 1,
      }}
      transition={
        dragging
          ? { duration: 0 }
          : { type: "spring", stiffness: 460, damping: 34 }
      }
      style={{
        top: topOffsetPx(session.startsAt, timezone),
        height: heightPx(session.durationMin),
        left: `calc(${lane * width}% + 3px)`,
        width: `calc(${width}% - 6px)`,
        borderLeftColor: accent,
        zIndex: dragging ? 40 : 10,
      }}
      className={cn(
        "absolute overflow-hidden rounded-[9px] border border-l-2 border-line bg-elevated px-2 py-1.5 text-left select-none",
        "touch-none transition-shadow duration-200",
        dragging ? "cursor-grabbing shadow-high" : "cursor-grab hover:shadow-mid",
        session.status === "requested" && "border-dashed opacity-80",
        session.status === "completed" && "opacity-55",
      )}
    >
      <p className="truncate text-[11px] leading-tight font-medium text-ink">
        {session.title}
      </p>
      <p className="mt-0.5 truncate text-[10px] text-ink-3 tabular-nums">
        {formatTime(session.startsAt, timezone)} · {session.durationMin}m
      </p>
      {session.status === "requested" && (
        <p className="mt-0.5 truncate text-[10px] text-warning">Requested</p>
      )}
    </motion.div>
  );
}

/* --- Availability shading -------------------------------------------------- */

/**
 * Faint shading where at least one coach is available, converted into the
 * viewer's timezone. Sampled every 30 minutes — cheap, and precise enough at
 * this grid density.
 */
function AvailabilityShade({
  coaches,
  timezone,
  weekStart,
  column,
}: {
  day: Date;
  coaches: Coach[];
  timezone: string;
  weekStart: Date;
  column: number;
}) {
  const spans = React.useMemo(() => {
    const totalMinutes = (GRID.endHour - GRID.startHour) * 60;
    const result: { top: number; height: number }[] = [];
    let openFrom: number | null = null;

    for (let m = 0; m <= totalMinutes; m += 30) {
      const iso = instantFromGridPosition(weekStart, column, m, timezone);
      const open =
        m < totalMinutes &&
        coaches.some((coach) =>
          isWithinAvailability(iso, coach.timezone, coach.availability),
        );
      if (open && openFrom === null) openFrom = m;
      if (!open && openFrom !== null) {
        result.push({
          top: (openFrom / 60) * GRID.pxPerHour,
          height: ((m - openFrom) / 60) * GRID.pxPerHour,
        });
        openFrom = null;
      }
    }
    return result;
  }, [coaches, timezone, weekStart, column]);

  return (
    <>
      {spans.map((span) => (
        <div
          key={span.top}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bg-titanium/[0.035]"
          style={{ top: span.top, height: span.height }}
        />
      ))}
    </>
  );
}
