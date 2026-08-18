import { cn } from "@/lib/utils";

/**
 * The Alpha mark: an ascending chevron pair inside a hairline ring — the
 * spiral principle reduced to two strokes. Rendered as inline SVG so it stays
 * crisp, themeable, and available offline.
 */
export function LogoMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <circle
        cx="16"
        cy="16"
        r="14.5"
        stroke="currentColor"
        strokeOpacity="0.24"
        strokeWidth="1"
      />
      <path
        d="M8.5 21.5L16 9l7.5 12.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.4 21.5L16 15.6l3.6 5.9"
        stroke="currentColor"
        strokeOpacity="0.45"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 leading-none whitespace-nowrap",
        className,
      )}
    >
      <span className="font-medium tracking-[0.16em] text-ink uppercase">
        Alpha
      </span>
      <span className="font-light tracking-[0.16em] text-ink-3 uppercase">
        Movement
      </span>
    </span>
  );
}

/** Small deterministic avatar — a brushed metal disc, no external requests. */
export function Avatar({
  seed,
  name,
  size = 32,
  className,
}: {
  seed: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const gradients: Record<string, string> = {
    titanium: "linear-gradient(140deg,#3a3a42,#1c1c22)",
    sage: "linear-gradient(140deg,#2b3326,#151a12)",
    steel: "linear-gradient(140deg,#242c36,#11151a)",
    clay: "linear-gradient(140deg,#332a22,#181310)",
  };
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("");

  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        backgroundImage: gradients[seed] ?? gradients.titanium,
        fontSize: size * 0.36,
      }}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full border border-line font-medium text-ink-2",
        className,
      )}
    >
      {initials}
    </span>
  );
}
