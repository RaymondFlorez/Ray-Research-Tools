# Alpha Movement

A personal training and lifestyle platform built around a modern synthesis
training system: GOATA joint mechanics, primal patterns, yoga and internal
arts, hybrid strength, functional bodybuilding, and dosed cardio — sequenced
deliberately rather than mixed.

The system prioritises long-term joint health, elegant movement quality,
aesthetic muscular development, cardiovascular resilience, and mental clarity.
Training is never simply harder here; it is more connected, more precise, and
built to be repeated for decades.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm run build      # production build
npm run start      # serve the production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run smoke      # boot the built app and assert every route responds
npm run verify     # typecheck → lint → build → smoke (what CI runs)
```

`npm run smoke` is the check a green build does not give you: it starts the
production server and asserts each route returns the right status *and*
contains the content it should. It caught a soft 404 — unknown `[slug]` routes
rendering the not-found page with a 200 — that the build reported as fine.

No database or API keys are required to run the app. Content is served from a
typed seed layer behind the same async interface a Prisma implementation will
use — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § 1.

## What's here

| Section | Route | What it does |
|---|---|---|
| **Philosophy** | `/philosophy` | The three governing principles, the six pillars in sequence, and what one hour of it actually looks like |
| **Onboarding** | `/onboarding` | Six screens that teach the system before asking for anything. No pricing, no urgency |
| **Movement Library** | `/library` | 27 movements across six pillars, each with ordered coaching cues, a "why this matters" note, chains organised, and a progression map. Favourite anything; string movements into personal flows |
| **Sessions** | `/sessions` | Drag-and-drop week calendar with recurrence, timezone conversion, coach availability shading, conflict lanes, and `.ics` export. Build sessions by hand or have the system propose one |
| **Progress** | `/today` | Movement quality, RPE, load, and a pillar-balance audit of the week — plus recommendations that state the evidence they read |
| **Store** | `/store` | Apparel, gear, and recovery tools alongside programs, manuals, video series, and audio guides |
| **My Library** | `/owned` | Owned digital content with progress and offline downloads |
| **Pulse** | `/pulse` | Training science, recovery and longevity, movement culture, and mind-body — each with source attribution and, where we have one, the Alpha Movement take |
| **Admin** | `/admin` | Product moderation, coach onboarding, content management, news curation, and platform analytics |

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 ·
Motion · Zustand · Prisma (schema) · PWA with a hand-written service worker

## Design

Dark-mode-first throughout. Near-black surfaces, muted metallic accents, no
pure white and no saturated colour. Spring-based micro-animations, skeleton
loading in dark tones, and typography that reads as athletic rather than
decorative.

Tokens map 1:1 to the brand specification and live in `@theme` in
`src/app/globals.css`. See [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md).

## Layout

```
prisma/schema.prisma       Production data model (25 models)
src/app/                   Routes — (app) group is the authenticated shell
src/components/            ui/ primitives, layout/ shell, movement/ media
src/lib/
  data/                    Seed content + the repository seam
  store/                   Zustand client state (persisted, offline-capable)
  auth/                    Session abstraction and role gates
  calendar.ts              Grid geometry, timezone maths, ICS export
  hooks/use-client.ts      Time and locale via useSyncExternalStore
public/sw.js               Service worker — offline shell, media cache, push
docs/                      Architecture, design system, implementation plan
```

## Content status

Two things in this build are deliberately marked as placeholder rather than
dressed up as real:

- **Pulse articles** are illustrative sample content. Sources and headlines are
  placeholders, not real publications. `PULSE_IS_SAMPLE_CONTENT` drives a
  visible banner, a per-article note, and a `sampleContent` field in the API
  response, so the disclosure travels with the data.
- **Movement videos** are not yet uploaded. Every movement has `mediaReady:
  false`, so the player shows its poster surface and an honest note instead of
  requesting a file that isn't there. Cues and coaching content are complete.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — system shape, data model, calendar,
  offline strategy, the feedback loop
- [Design System](docs/DESIGN_SYSTEM.md) — tokens, typography, components,
  motion, accessibility
- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) — what's done, and the
  eight phases to production with estimates
