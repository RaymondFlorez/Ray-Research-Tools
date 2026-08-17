# Alpha Movement — Implementation Plan

Where this build stands, and what each remaining phase costs. Estimates assume
two engineers and one designer.

## Phase 0 — Delivered in this repository

The complete application architecture, every key screen, the full data model,
and a working product that runs against seeded content.

| Area | State |
|---|---|
| Design system | Complete — tokens, primitives, motion, skeletons, a11y |
| Philosophy & onboarding | Complete |
| Movement library (27 movements) | Complete — filter, detail, favourites, flows |
| Sessions & calendar | Complete — DnD, recurrence, timezones, availability, logging |
| Store & owned library | Complete — catalogue, cart, checkout stub, offline downloads |
| Pulse | Complete — feed, personalisation, saved, article pages |
| Dashboard & admin | Complete |
| Data model | Complete — `prisma/schema.prisma`, 25 models |
| API | Complete — six route handlers behind an auth gate |
| PWA | Complete — manifest, service worker, offline fallback |

Verified: `tsc --noEmit` clean, `eslint` clean (0 errors, 0 warnings),
`next build` green across 70 pre-rendered pages, and every route returns 200
with zero browser console errors.

## Phase 1 — Persistence & identity (2 weeks)

The single highest-value phase, because everything after it depends on real
users and real rows.

1. Provision PostgreSQL; `prisma migrate deploy`.
2. Write a seed script that loads the existing `src/lib/data/*` content —
   the shapes already match the schema.
3. Reimplement `src/lib/data/repository.ts` against `PrismaClient`. **No screen
   changes.** This is the whole point of the seam.
4. NextAuth with the Prisma adapter (`Account` / `AuthSession` already exist).
   Credentials + Apple + Google. Replace the body of `getSession()`.
5. Move client-store data (favourites, flows, logs) to the API, keeping
   `localStorage` as the offline write buffer with reconciliation on reconnect.

**Exit criteria:** two real accounts can each hold distinct favourites, flows,
and session logs across devices.

## Phase 2 — Payments & digital delivery (1.5 weeks)

1. Stripe keys; complete the `POST /api/checkout` production branch (already
   scaffolded, prices already resolved server-side).
2. `checkout.session.completed` webhook → write `Entitlement` rows. The client
   must never be the authority on what has been paid for.
3. Subscription tier alongside one-off purchases.
4. Signed, expiring CDN URLs for digital assets.
5. Creator payouts via Stripe Connect for coach-published products.

**Exit criteria:** a real card grants real access, and refunds revoke it.

## Phase 3 — Media pipeline (2 weeks)

1. Video upload in the admin panel → transcode (Mux or CloudFront + MediaConvert)
   → HLS renditions + poster frames.
2. Set `mediaReady: true` per movement as media lands. The player already
   branches on this flag.
3. Replace generated gradient posters with real first frames at the same aspect
   ratios — no layout change required.
4. Wire the service worker's `AM_DOWNLOAD` message to real HLS segments.

**Exit criteria:** an athlete downloads a program on wifi and trains through it
in airplane mode.

## Phase 4 — Calendar & notifications (1.5 weeks)

1. Google Calendar and Microsoft Graph OAuth; store tokens in
   `CalendarConnection`.
2. Two-way sync worker with incremental `syncToken`, including reschedules and
   cancellations.
3. Web Push VAPID keys; reminder scheduler reading the `Reminder` table.
4. Transactional email (Resend or Postmark) for the 12-hour reminder, with the
   session's programming attached.

**Exit criteria:** moving a session in the app moves it in Google Calendar
within a minute, and both reminders fire.

## Phase 5 — Pulse ingestion (1.5 weeks)

1. RSS/API ingestion workers per source; canonical-URL dedupe.
2. Summarisation into the `summary` field, queued for review — never
   auto-published.
3. Editorial queue in the admin panel for writing the "Alpha Movement take".
4. Set `PULSE_IS_SAMPLE_CONTENT = false`. The sample banner, the per-article
   note, and the API's `sampleContent` flag all clear from that one constant.

**Exit criteria:** real attributed items, human-reviewed before publication.

## Phase 6 — Programming intelligence (2 weeks)

1. Keep `recommendFromLogs()` as the guardrail layer. Add a model-backed
   proposer above it.
2. **Hard constraint:** the model may not propose progression when the rule
   engine sees declining movement quality, low HRV against baseline, or sleep
   debt. Rules win.
3. Every recommendation continues to state the evidence it read and a
   confidence score. This is a product requirement, not an implementation
   detail.
4. Coach review queue for AI-generated programs before they reach an athlete.

**Exit criteria:** coaches accept ≥70% of proposals unmodified, and every
rejection is attributable to a stated input.

## Phase 7 — Mobile companion (3 weeks)

React Native (Expo), sharing `src/types` and the API contract. Native
priorities: background download, HealthKit / Health Connect for HRV and sleep,
and live-session video. The web PWA already covers offline reading and
scheduling, so the native app's job is the sensor and background work a browser
cannot do.

## Phase 8 — Analytics & hardening (1 week)

1. `AnalyticsEvent` writers on the three metrics the admin panel already names:
   retention, session completion, product engagement. Nothing else.
2. Rate limiting on write endpoints.
3. Error tracking (Sentry) and Core Web Vitals reporting.
4. Load test the calendar with 500 sessions per athlete.
5. Accessibility audit against WCAG 2.2 AA.

---

## Sequencing note

Phases 1 and 2 unblock revenue and should run first. Phase 3 (media) is the
longest lead time — start the transcoding contract during Phase 1 so it is not
the critical path. Phases 4 and 5 are independent and can run in parallel.
Phase 6 should not start until there is enough real log data to evaluate
proposals against, which realistically means eight weeks of live sessions.
