# Alpha Movement — Architecture

## 1. Shape of the system

A single Next.js 16 application (App Router, React 19, TypeScript) serving both
the marketing surface and the authenticated product, with a strict seam between
screens and persistence.

```
┌──────────────────────────────────────────────────────────────┐
│  Client                                                      │
│  ├─ Server Components (default) — content, layout, data read │
│  ├─ Client Components — interaction, calendar DnD, stores    │
│  └─ Service Worker — offline shell, media cache, push        │
├──────────────────────────────────────────────────────────────┤
│  Route Handlers  /api/*                                      │
│  ├─ auth gate (src/lib/auth/session.ts)                      │
│  └─ uniform JSON error shape                                 │
├──────────────────────────────────────────────────────────────┤
│  Repository      src/lib/data/repository.ts   ◄── THE SEAM   │
│  Every screen reads through async functions returning plain  │
│  domain objects. Nothing above this file knows about Prisma. │
├──────────────────────────────────────────────────────────────┤
│  Persistence                                                 │
│  ├─ Now:  typed seed modules (src/lib/data/*.ts)             │
│  └─ Next: PostgreSQL via Prisma (prisma/schema.prisma)       │
└──────────────────────────────────────────────────────────────┘
```

**Why the seam matters.** `prisma/schema.prisma` is the complete production
data model — 25 models covering identity, the library, scheduling, commerce,
Pulse, and analytics. The running app reads seeded arrays through the same
async signatures the Prisma implementation will have, so bringing up a database
is a matter of reimplementing one file. No screen changes.

## 2. Route map

| Route | Rendering | Purpose |
|---|---|---|
| `/` | Static | Marketing entry, philosophy-first |
| `/onboarding` | Static | Six-screen philosophy-led onboarding |
| `/today` | Dynamic | Progress dashboard, pillar balance, recommendations |
| `/philosophy` | Static | The system: principles, six pillars, session anatomy |
| `/library` | Static + client filter | Movement library |
| `/library/[slug]` | SSG (27 pages) | Movement detail: video, cues, why-it-matters |
| `/library/flows` | Static | Personal sequences and favourites |
| `/sessions` | Dynamic | Drag-and-drop calendar, builder, logging |
| `/store` | Static | Merch, gear, digital products |
| `/store/[slug]` | SSG (11 pages) | Product detail and purchase |
| `/store/cart` | Static | Cart and checkout |
| `/owned` | Static | Owned digital content, offline downloads |
| `/pulse` | Static | News and trends feed |
| `/pulse/[slug]` | SSG (12 pages) | Article with the Alpha Movement take |
| `/profile` | Static | Focus, level, timezone, calendar, reminders |
| `/admin` | Static | Moderation, coaches, content, curation, analytics |
| `/offline` | Static | Service-worker navigation fallback |

The `(app)` route group wraps every authenticated screen in `AppShell` — side
rail on desktop, bottom tab bar on mobile. Marketing, onboarding, and offline
sit outside it deliberately: they are full-bleed experiences.

### API surface

| Endpoint | Notes |
|---|---|
| `GET /api/movements` | Library, filterable. Long cache — content is stable. |
| `GET /api/sessions` | Week-scoped. `POST` creates a session request. |
| `GET /api/products` | Public. Only `APPROVED` products are ever returned. |
| `GET /api/pulse` | Carries `sampleContent: true` so clients disclose it. |
| `POST /api/checkout` | Resolves prices server-side; creates a Stripe session. |
| `GET /api/calendar/ics` | RFC 5545 feed for Google / Apple / Outlook. |

## 3. Data model highlights

Full schema in [`prisma/schema.prisma`](../prisma/schema.prisma). The parts
worth calling out:

**Movements carry their own reasoning.** Every `Movement` has `cues[]`, a `why`
field, and `chains[]`. The "why this matters" text is not marketing copy bolted
on — it is a required field, because a movement whose purpose cannot be stated
does not belong in the library.

**Sessions are structured, not free text.** A `TrainingSession` owns ordered
`SessionBlock`s, each tagged with a `MovementCategoryEnum`. This makes the
philosophy structurally enforceable: the dashboard can audit pillar balance
across a week because the pillar is a column, not a convention.

**Timezones are explicit.** `startsAt` is always UTC; `timezone` records the
IANA zone the session was authored in. Rendering converts into the viewer's
zone via `Intl`, never via date arithmetic, so DST is the platform's problem.

**Entitlements, not order history.** Digital access is a separate
`Entitlement` row written by the Stripe webhook. The client is never the
authority on what has been paid for.

**Analytics are deliberately narrow.** `AnalyticsEvent` is scoped to retention,
session completion, and product engagement. Time-in-app is not instrumented; a
session an athlete skips because they needed rest is not a failure state.

## 4. The programming feedback loop

```
Session scheduled → completed → SessionLog written
        ▲                              │
        │                              ▼
   next block  ◄── recommendFromLogs(logs) ──► rationale + confidence
```

`recommendFromLogs()` in `src/lib/data/sessions.ts` is a transparent rule
engine. Each recommendation carries the evidence it read ("quality is averaging
3.4 of 5 across your last 5 sessions") and a confidence score. That is a design
requirement, not a nicety: an athlete who cannot interrogate a recommendation
should not follow it.

The production path replaces the rules with a model and **retains them as
guardrails** — the model may not propose progression when the rule engine sees
declining movement quality.

## 5. Calendar

`src/lib/calendar.ts` holds all geometry and timezone maths.

- **Drag and drop** is built on pointer events, not a DnD library. The drag
  target is an absolutely positioned pill inside a grid of known dimensions, so
  the geometry is exact, touch works without a shim, and there is no dependency.
  A drag under 4px is treated as a click.
- **Overlap layout** (`layoutDay`) assigns lanes per overlapping cluster, so an
  isolated session stays full width while a genuine conflict splits.
- **Coach availability** is sampled at 30-minute resolution and converted from
  each coach's zone into the viewer's, then shaded faintly.
- **Export** produces RFC 5545 with `RRULE` and `VALARM` blocks. The
  OAuth-based two-way sync (`CalendarConnection`) is the richer path; the ICS
  feed is the fallback that works everywhere with zero integration.

## 6. Offline & PWA

`public/sw.js` applies a different strategy per asset class:

| Class | Strategy | Reasoning |
|---|---|---|
| App shell, chunks | stale-while-revalidate | Instant paint, updates in background |
| Library / product / Pulse API | stale-while-revalidate | Content is stable |
| Session API | network-first | A stale schedule is worse than none |
| Media (mp4, m4a) | cache-first, **explicit download only** | Never fill a device unasked |

Media is cached only when the athlete taps download in `/owned`, which posts an
`AM_DOWNLOAD` message to the worker. Push notifications for session reminders
are handled in the same worker.

## 7. Client state

`src/lib/store/app-store.ts` (Zustand + `persist`) holds favourites, flows,
cart, saved articles, downloads, and locally authored session edits. It is
persisted to `localStorage` so the app keeps working offline; production
reconciles against the API on reconnect.

**Hydration discipline.** Persisted state is unavailable during SSR, so
components gate on `useIsHydrated()` and render neutral state until then. Time
and locale are read through `useSyncExternalStore` (`src/lib/hooks/use-client.ts`)
rather than `useState` + effect — they are external systems, and this keeps the
server snapshot explicit, satisfies the React 19 compiler lint rules, and makes
hydration mismatch structurally impossible.

## 8. Design system

Tokens live in `@theme` in `src/app/globals.css` and map 1:1 to the brand
specification. See [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md).

One naming decision worth recording: the primary background token is
`--color-void`, not `--color-base`. Tailwind reserves `text-base` for a
font-size utility, so a `base` colour token silently loses the text colour on
every light button — white-on-white, no error. `void` avoids the collision.

## 9. Content honesty

Pulse ships with `PULSE_IS_SAMPLE_CONTENT = true`. The sources and headlines are
placeholders written for this build, not real publications, and the flag drives
a visible banner in the feed, a note on each article, and a `sampleContent`
field in the API response — so the disclosure travels with the data rather than
living in one component.

**Production ingestion path:** RSS/API pull → dedupe by canonical URL →
summarise → editorial or AI-curated "Alpha Movement take" → human review →
publish. Flip the flag when the pipeline is connected.

Movement demonstration videos are likewise unpublished (`mediaReady: false` on
every seeded movement). The player renders its poster surface and an honest
note rather than firing a 404 per page view.

## 10. CI

`.github/workflows/ci.yml` runs on pushes to `main` and `claude/**`, and on PRs
into `main`: `typecheck` → `lint --max-warnings=0` → `build` → `smoke`.

The smoke step (`scripts/smoke.mjs`) boots the production server and asserts
every route's status and a content string that only correct output contains. A
green build proves the app compiles, not that it renders — a broken server
component, a bad `generateStaticParams`, or a failing route handler all compile
cleanly. It earned its place immediately by catching a **soft 404**: unknown
`[slug]` params rendered the not-found UI with an HTTP 200, which misleads
crawlers and any client that checks status rather than body.

The fix is `export const dynamicParams = false` on the three `[slug]` routes.
Every slug is known at build time, so anything else is a genuine 404. **When
content moves to the database and slugs are no longer build-time-known, this
must flip back to `true`** — and the soft-404 behaviour needs re-testing, since
`notFound()` alone did not produce a 404 status here.

## 11. Production readiness checklist

Implemented in this build:

- [x] Complete route surface and screens
- [x] Full data model (Prisma schema)
- [x] Repository seam with async signatures
- [x] Auth abstraction with role gates
- [x] REST API with uniform error shape
- [x] Service worker, manifest, offline fallback
- [x] Design system, motion, skeleton loading
- [x] Accessibility: skip link, focus rings, ARIA, reduced-motion

Requires infrastructure before launch:

- [ ] PostgreSQL + `prisma migrate deploy`; reimplement `repository.ts`
- [ ] NextAuth with the Prisma adapter (models already present)
- [ ] Stripe keys + `checkout.session.completed` webhook → `Entitlement`
- [ ] Google/Microsoft OAuth for two-way calendar sync
- [ ] Video CDN + transcoding; set `mediaReady` per movement
- [ ] Pulse ingestion pipeline; clear `PULSE_IS_SAMPLE_CONTENT`
- [ ] Web Push VAPID keys and the reminder scheduler
- [ ] Rate limiting on write endpoints
