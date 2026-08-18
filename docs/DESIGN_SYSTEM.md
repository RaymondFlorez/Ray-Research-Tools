# Alpha Movement — Design System

Dark-mode-first. Light mode is a secondary, opt-in surface (`:root[data-theme="light"]`).

All tokens are declared in `@theme` in [`src/app/globals.css`](../src/app/globals.css)
and consumed as Tailwind utilities. There are no hardcoded hex values in
components — the one exception is category accents, which are read as CSS
variables through inline `style` so a movement's pillar colour can be applied
dynamically.

## Colour

### Backgrounds

| Token | Utility | Value | Use |
|---|---|---|---|
| `--color-void` | `bg-void` | `#0A0A0B` | Primary background |
| `--color-surface` | `bg-surface` | `#141416` | Cards, secondary surfaces |
| `--color-elevated` | `bg-elevated` | `#1C1C1F` | Modals, trays, popovers |
| `--color-line` | `border-line` | `#2A2A2E` | Hairline borders, dividers |
| `--color-line-strong` | `border-line-strong` | `#3A3A40` | Hover / focus borders |

> **Naming note.** The primary background is `void`, not `base`. Tailwind
> reserves `text-base` for a font-size utility, so a `base` colour token
> silently produces white-on-white text on every light button with no error.

### Text

| Token | Utility | Value |
|---|---|---|
| `--color-ink` | `text-ink` | `#F5F5F5` |
| `--color-ink-2` | `text-ink-2` | `#A1A1AA` |
| `--color-ink-3` | `text-ink-3` | `#71717A` |

### Accent & semantic

| Token | Utility | Value | Use |
|---|---|---|---|
| `--color-accent` | `text-accent` | `#C0C0C0` | Soft metallic silver |
| `--color-titanium` | `border-titanium` | `#B8B8C0` | Muted titanium |
| `--color-accent-hi` | `bg-accent-hi` | `#E4E4E7` | Hover / active |
| `--color-positive` | `text-positive` | `#8B9A7D` | Muted sage |
| `--color-warning` | `text-warning` | `#D4A574` | Soft amber |
| `--color-danger` | `text-danger` | `#C45C5C` | Muted red |

No pure white, no high-saturation colour. The brightest value in the system is
`#F5F5F5`, and it is reserved for primary text and light-button surfaces.

### Category accents

Each of the six pillars carries a muted accent used as a hairline, a dot, or a
label colour — never as a fill. They are close enough in value that a grid of
mixed categories still reads as one system.

`goata #B8B8C0` · `primal #A89A86` · `flow #8B9A7D` · `hybrid #9AA4B8` ·
`functional #B39D8A` · `cardio #A68F9C`

## Typography

Inter, loaded via `next/font` with `--font-inter`, falling back to SF Pro and
the system stack.

| Token | Size | Tracking | Weight |
|---|---|---|---|
| `text-display` | 4.25rem | −0.035em | 500 |
| `text-title` | 2.5rem | −0.025em | 500 |
| `text-heading` | 1.5rem | −0.015em | 500 |
| `text-body` | 1rem / 1.65 | — | 400 |
| `text-small` | 0.875rem | — | 400 |
| `text-micro` | 0.6875rem | +0.14em | 500 |

Large titles use `clamp()` so headings scale continuously rather than stepping
at breakpoints. Negative tracking increases with size — the athletic, precise
feel comes from tight display type against generously spaced micro-labels
(`.eyebrow`).

Numerals in stats, times, durations, and counts always use `tabular-nums` so
values do not jitter as they update.

## Surfaces & radii

| Token | Value |
|---|---|
| `--radius-card` | 14px (spec: 12–16) |
| `--radius-panel` | 18px |
| `--radius-pill` | 999px |

Three shadow levels, all soft and low-opacity, each pairing an outer shadow with
an inset 1px white highlight at 2–4.5% — that inset is what makes an elevated
surface read as lit rather than merely lighter.

`--shadow-glow` is a metallic ring reserved for the `metal` button variant and
selected states.

## Components

Primitives live in `src/components/ui/`:

- **`button.tsx`** — `primary` (solid light on dark), `secondary` (outline),
  `ghost`, `metal` (titanium border + glow), `danger`. Three sizes. Renders as
  `next/link` when given `href`, with identical visuals. Plus `IconButton`.
- **`card.tsx`** — `Card` (with `interactive` for hover lift), header/body/
  footer parts, and `Section` for consistent page rhythm.
- **`primitives.tsx`** — `Badge`, `Input`, `Textarea`, `Select`, `Field`,
  `Skeleton`, `Segmented`, `Progress`, `Stat`, `EmptyState`.
- **`overlay.tsx`** — `Modal` (bottom sheet under `sm`, focus-trapped),
  `Reveal` (scroll entrance), `Lift`, `Toast`.

## Motion

Spring-based and restrained. Nothing bounces, nothing travels far.

| Purpose | Implementation |
|---|---|
| Modal / tray entrance | spring, stiffness 380–460, damping 32–34 |
| Scroll reveal | 14px travel, 0.65s, `cubic-bezier(0.22, 1, 0.36, 1)` |
| Hover lift | −1 to −3px, 200–300ms |
| Active nav indicator | `layoutId` shared-element spring |
| Grid item entrance | staggered 35ms, capped at 300ms total |

The stagger cap matters: without it a 27-item library grid takes almost a second
to finish appearing, which reads as slow rather than considered.

`prefers-reduced-motion: reduce` collapses all animation and transition
durations to 0.01ms globally.

## Loading

Skeletons, never spinners. `.skeleton` is an elevated surface with a
low-opacity white gradient sweeping at 1.9s on an ease-in-out curve. Route-level
`loading.tsx` mirrors the shape of the page that is arriving — a header block
plus a card grid — so the layout does not shift when content lands.

## Accessibility

- Skip-to-content link, visible on focus.
- `:focus-visible` gives a 2px accent outline at 2px offset, globally.
- All icon-only controls carry `aria-label` and `title`.
- Toggles use `role="switch"` with `aria-checked`; filters use `aria-pressed`;
  the segmented control uses `role="tablist"` / `aria-selected`.
- The modal traps Tab, closes on Escape, and locks body scroll.
- Text contrast: `#A1A1AA` on `#141416` is ~7.5:1; `#71717A` is reserved for
  non-essential metadata at 12px and above.
