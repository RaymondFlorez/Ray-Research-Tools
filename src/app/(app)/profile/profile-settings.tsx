"use client";

import * as React from "react";
import { Bell, Calendar, Check, HardDrive, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Select } from "@/components/ui/primitives";
import { Toast } from "@/components/ui/overlay";
import { Avatar } from "@/components/layout/logo";
import { FOCUS_META, FOCUS_ORDER, LEVEL_META } from "@/lib/data/taxonomy";
import { CURRENT_USER } from "@/lib/data/people";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import type { SkillLevel, TrainingFocus } from "@/types";
import { cn } from "@/lib/utils";

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

const CALENDARS = [
  { id: "google", name: "Google Calendar", connected: true },
  { id: "apple", name: "Apple Calendar", connected: false },
  { id: "outlook", name: "Outlook", connected: false },
];

export function ProfileSettings() {
  const hydrated = useStoreHydrated();
  const focus = useAppStore((s) => s.focus);
  const level = useAppStore((s) => s.level);
  const timezone = useAppStore((s) => s.timezone);
  const downloads = useAppStore((s) => s.downloads);
  const favorites = useAppStore((s) => s.favorites);
  const flows = useAppStore((s) => s.flows);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const toggleDownload = useAppStore((s) => s.toggleDownload);

  const [toast, setToast] = React.useState<string | null>(null);
  const [pushEnabled, setPushEnabled] = React.useState(true);
  const [emailEnabled, setEmailEnabled] = React.useState(true);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const update = (patch: {
    focus?: TrainingFocus[];
    level?: SkillLevel;
    timezone?: string;
  }) => {
    completeOnboarding({
      focus: patch.focus ?? focus,
      level: patch.level ?? level,
      timezone: patch.timezone ?? timezone,
    });
    setToast("Preferences updated");
  };

  const toggleFocus = (value: TrainingFocus) =>
    update({
      focus: focus.includes(value)
        ? focus.filter((f) => f !== value)
        : [...focus, value],
    });

  return (
    <div className="space-y-6 py-8">
      {/* ---- Identity ------------------------------------------------------ */}
      <section className="surface-card flex flex-wrap items-center gap-5 p-6">
        <Avatar seed={CURRENT_USER.avatarSeed} name={CURRENT_USER.name} size={64} />
        <div className="min-w-0">
          <h2 className="text-[19px] font-medium text-ink">
            {CURRENT_USER.name}
          </h2>
          <p className="text-small text-ink-3">{CURRENT_USER.email}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Badge tone="accent">{CURRENT_USER.role}</Badge>
            {hydrated && <Badge>{LEVEL_META[level].label}</Badge>}
          </div>
        </div>
      </section>

      {/* ---- Training focus ------------------------------------------------- */}
      <section className="surface-card p-6">
        <h2 className="text-heading text-ink">Training focus</h2>
        <p className="mt-2 text-small text-ink-2">
          Orders your library, weights session proposals, and personalises Pulse.
        </p>
        <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {FOCUS_ORDER.map((id) => {
            const active = hydrated && focus.includes(id);
            return (
              <button
                key={id}
                onClick={() => toggleFocus(id)}
                aria-pressed={active}
                className={cn(
                  "flex items-start justify-between gap-3 rounded-card border p-4 text-left transition-all duration-250",
                  active
                    ? "border-titanium/50 bg-titanium/8"
                    : "border-line hover:border-line-strong",
                )}
              >
                <span>
                  <span className="block text-[14px] font-medium text-ink">
                    {FOCUS_META[id].label}
                  </span>
                  <span className="mt-1 block text-[12px] leading-relaxed text-ink-3">
                    {FOCUS_META[id].description}
                  </span>
                </span>
                <span
                  className={cn(
                    "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border",
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
      </section>

      {/* ---- Level & timezone ------------------------------------------------ */}
      <section className="surface-card grid gap-5 p-6 sm:grid-cols-2">
        <Field label="Starting level">
          <Select
            value={level}
            onChange={(e) => update({ level: e.target.value as SkillLevel })}
          >
            {(Object.keys(LEVEL_META) as SkillLevel[]).map((id) => (
              <option key={id} value={id}>
                {LEVEL_META[id].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Time zone"
          hint="Sessions are always shown in this zone."
        >
          <Select
            value={timezone}
            onChange={(e) => update({ timezone: e.target.value })}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      {/* ---- Calendar connections --------------------------------------------- */}
      <section className="surface-card p-6">
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-ink-3" />
          <h2 className="text-heading text-ink">Calendar sync</h2>
        </div>
        <p className="mt-2 text-small text-ink-2">
          Two-way sync keeps your training calendar and your working calendar in
          agreement, including reschedules.
        </p>
        <ul className="mt-5 space-y-2">
          {CALENDARS.map((calendar) => (
            <li
              key={calendar.id}
              className="flex items-center justify-between gap-4 rounded-card border border-line px-5 py-3.5"
            >
              <div>
                <p className="text-[14px] font-medium text-ink">
                  {calendar.name}
                </p>
                <p className="text-[12px] text-ink-3">
                  {calendar.connected
                    ? "Connected · syncing every 15 minutes"
                    : "Not connected"}
                </p>
              </div>
              <Button
                variant={calendar.connected ? "secondary" : "primary"}
                size="sm"
                onClick={() =>
                  setToast(
                    calendar.connected
                      ? `${calendar.name} would disconnect here`
                      : `OAuth flow for ${calendar.name} starts here`,
                  )
                }
              >
                {calendar.connected ? "Disconnect" : "Connect"}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- Reminders --------------------------------------------------------- */}
      <section className="surface-card p-6">
        <div className="flex items-center gap-2">
          <Bell size={16} className="text-ink-3" />
          <h2 className="text-heading text-ink">Reminders</h2>
        </div>
        <div className="mt-5 space-y-2">
          <ToggleRow
            label="Push notifications"
            hint="30 minutes before each session."
            checked={pushEnabled}
            onChange={setPushEnabled}
          />
          <ToggleRow
            label="Email reminders"
            hint="Evening before, with the session's programming attached."
            checked={emailEnabled}
            onChange={setEmailEnabled}
          />
        </div>
      </section>

      {/* ---- Offline storage ----------------------------------------------------- */}
      <section className="surface-card p-6">
        <div className="flex items-center gap-2">
          <HardDrive size={16} className="text-ink-3" />
          <h2 className="text-heading text-ink">Offline storage</h2>
        </div>
        <p className="mt-2 text-small text-ink-2">
          {hydrated
            ? `${downloads.length} downloaded products · ${favorites.length} favourite movements · ${flows.length} saved flows`
            : "Reading local storage…"}
        </p>
        {hydrated && downloads.length > 0 && (
          <Button
            variant="danger"
            size="sm"
            className="mt-4"
            onClick={() => {
              downloads.forEach(toggleDownload);
              setToast("Offline storage cleared");
            }}
          >
            <Trash2 size={14} />
            Clear downloads
          </Button>
        )}
      </section>

      <Toast message={toast} open={Boolean(toast)} />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-card border border-line px-5 py-3.5">
      <div>
        <p className="text-[14px] font-medium text-ink">{label}</p>
        <p className="text-[12px] text-ink-3">{hint}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-pill border transition-colors duration-250",
          checked ? "border-accent-hi bg-accent-hi" : "border-line bg-elevated",
        )}
      >
        <span
          className={cn(
            "absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all duration-250 ease-[var(--ease-out-quint)]",
            checked ? "left-6 bg-void" : "left-1 bg-ink-3",
          )}
        />
      </button>
    </div>
  );
}
