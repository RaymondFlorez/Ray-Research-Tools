import type { AvailabilityWindow, SessionType, TrainingSession } from "@/types";

/* ============================================================================
   CALENDAR HELPERS
   All session instants are stored UTC. Everything here converts into a display
   timezone, so an athlete in Los Angeles and a coach in Lisbon see the same
   session at the correct local hour.
   ========================================================================= */

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Grid geometry — one place to change the calendar's density. */
export const GRID = {
  startHour: 5,
  endHour: 22,
  pxPerHour: 56,
} as const;

export const GRID_HEIGHT = (GRID.endHour - GRID.startHour) * GRID.pxPerHour;

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Wall-clock parts of a UTC instant as seen from `timezone`. Uses Intl rather
 * than date maths so DST transitions are handled by the platform.
 */
export function zonedParts(iso: string, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
  };
}

export function formatTime(iso: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatDayLong(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatRangeLabel(weekStart: Date) {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  const month = new Intl.DateTimeFormat("en-US", { month: "long" });
  return sameMonth
    ? `${month.format(weekStart)} ${weekStart.getDate()}–${end.getDate()}, ${end.getFullYear()}`
    : `${month.format(weekStart)} ${weekStart.getDate()} – ${month.format(end)} ${end.getDate()}, ${end.getFullYear()}`;
}

/** Short zone label, e.g. "PDT". */
export function zoneAbbrev(timezone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(at);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timezone;
}

/** Offset in minutes between two zones at a given instant. */
export function zoneOffsetDiffMinutes(from: string, to: string, at: Date) {
  const read = (timezone: string) => {
    const p = zonedParts(at.toISOString(), timezone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  return (read(to) - read(from)) / 60000;
}

/** Minutes from the grid's start hour, in the viewer's timezone. */
export function minutesFromGridStart(iso: string, timezone: string) {
  const { hour, minute } = zonedParts(iso, timezone);
  return (hour - GRID.startHour) * 60 + minute;
}

export function topOffsetPx(iso: string, timezone: string) {
  return (minutesFromGridStart(iso, timezone) / 60) * GRID.pxPerHour;
}

export function heightPx(durationMin: number) {
  return Math.max(26, (durationMin / 60) * GRID.pxPerHour);
}

/** Which column (0–6) a session lands in for the week beginning `weekStart`. */
export function columnIndex(
  iso: string,
  timezone: string,
  weekStart: Date,
): number {
  const p = zonedParts(iso, timezone);
  const sessionDay = new Date(p.year, p.month - 1, p.day);
  const start = new Date(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate(),
  );
  const diff = Math.round(
    (sessionDay.getTime() - start.getTime()) / 86_400_000,
  );
  return diff;
}

/**
 * Build the UTC instant for a dropped position: day column + minutes from the
 * top of the grid, interpreted in the viewer's timezone.
 */
export function instantFromGridPosition(
  weekStart: Date,
  dayIndex: number,
  minutesFromStart: number,
  timezone: string,
) {
  const day = addDays(weekStart, dayIndex);
  const totalMinutes = GRID.startHour * 60 + minutesFromStart;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;

  // Construct as if local, then correct by the offset between local and target.
  const naive = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    hour,
    minute,
    0,
    0,
  );
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const correction = zoneOffsetDiffMinutes(localZone, timezone, naive);
  return new Date(naive.getTime() - correction * 60_000).toISOString();
}

/** Snap to the nearest 15-minute increment. */
export function snapMinutes(minutes: number, increment = 15) {
  return Math.round(minutes / increment) * increment;
}

export function sessionsForWeek(
  sessions: TrainingSession[],
  weekStart: Date,
  timezone: string,
) {
  return sessions.filter((session) => {
    const column = columnIndex(session.startsAt, timezone, weekStart);
    return column >= 0 && column <= 6;
  });
}

/** Lays out overlapping sessions side by side within a day column. */
export function layoutDay(
  sessions: TrainingSession[],
  timezone: string,
): { session: TrainingSession; lane: number; lanes: number }[] {
  const sorted = [...sessions].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
  const placed: {
    session: TrainingSession;
    lane: number;
    start: number;
    end: number;
  }[] = [];

  for (const session of sorted) {
    const start = minutesFromGridStart(session.startsAt, timezone);
    const end = start + session.durationMin;
    const taken = new Set(
      placed.filter((p) => p.start < end && start < p.end).map((p) => p.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane++;
    placed.push({ session, lane, start, end });
  }

  // Lane count is computed per overlapping cluster so isolated sessions stay wide.
  return placed.map((entry) => {
    const cluster = placed.filter(
      (other) => other.start < entry.end && entry.start < other.end,
    );
    const lanes = Math.max(...cluster.map((c) => c.lane)) + 1;
    return { session: entry.session, lane: entry.lane, lanes };
  });
}

/** Does a coach's availability cover this instant, in the coach's own zone? */
export function isWithinAvailability(
  iso: string,
  coachTimezone: string,
  windows: AvailabilityWindow[],
) {
  const p = zonedParts(iso, coachTimezone);
  const weekday = new Date(
    Date.UTC(p.year, p.month - 1, p.day),
  ).getUTCDay();
  const minutes = p.hour * 60 + p.minute;
  return windows.some(
    (w) => w.weekday === weekday && minutes >= w.startMin && minutes < w.endMin,
  );
}

export const SESSION_TYPE_META: Record<
  SessionType,
  { label: string; short: string; hint: string }
> = {
  live: {
    label: "1-on-1 live video",
    short: "Live",
    hint: "Coached in real time over video.",
  },
  "in-person": {
    label: "In person",
    short: "Studio",
    hint: "At the studio or an agreed location.",
  },
  group: {
    label: "Group",
    short: "Group",
    hint: "Small group, capped at eight athletes.",
  },
  async: {
    label: "Asynchronous check-in",
    short: "Async",
    hint: "Train on your own; upload video for review.",
  },
};

/** Human-readable recurrence copy for the session detail panel. */
export const RECURRENCE_LABEL: Record<TrainingSession["recurrence"], string> = {
  none: "Does not repeat",
  weekly: "Repeats weekly",
  biweekly: "Repeats every two weeks",
  "every-weekday": "Repeats every weekday",
};

/* --- Calendar export ------------------------------------------------------ */

/**
 * Minimal RFC 5545 document. Google, Apple, and Outlook all consume this; the
 * production integration additionally pushes via each provider's API using the
 * tokens in CalendarConnection.
 */
export function toICS(sessions: TrainingSession[], calendarName = "Alpha Movement") {
  const stamp = (iso: string) =>
    new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const escape = (text: string) =>
    text.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");

  const rrule = (session: TrainingSession) => {
    switch (session.recurrence) {
      case "weekly":
        return ["RRULE:FREQ=WEEKLY"];
      case "biweekly":
        return ["RRULE:FREQ=WEEKLY;INTERVAL=2"];
      case "every-weekday":
        return ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"];
      default:
        return [];
    }
  };

  const events = sessions.flatMap((session) => {
    const end = new Date(
      new Date(session.startsAt).getTime() + session.durationMin * 60_000,
    ).toISOString();
    return [
      "BEGIN:VEVENT",
      `UID:${session.id}@alphamovement.app`,
      `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(session.startsAt)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${escape(session.title)}`,
      `DESCRIPTION:${escape(
        [
          session.notes ?? "",
          ...session.blocks.map((b) => `${b.label} — ${b.durationMin} min`),
        ]
          .filter(Boolean)
          .join("\n"),
      )}`,
      ...(session.location ? [`LOCATION:${escape(session.location)}`] : []),
      ...(session.joinUrl ? [`URL:${session.joinUrl}`] : []),
      ...rrule(session),
      ...session.reminders.map(
        (r) =>
          `BEGIN:VALARM\nTRIGGER:-PT${r.minutesBefore}M\nACTION:DISPLAY\nDESCRIPTION:${escape(session.title)}\nEND:VALARM`,
      ),
      "END:VEVENT",
    ];
  });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Alpha Movement//Training//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escape(calendarName)}`,
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}
