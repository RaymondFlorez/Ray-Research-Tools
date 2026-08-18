#!/usr/bin/env node
/**
 * Smoke test — boots the production server and asserts every route responds.
 *
 * This exists because a green `next build` proves the app compiles, not that it
 * renders. Several classes of failure (a bad `generateStaticParams`, a server
 * component reading something undefined, a broken route handler) only surface
 * when a request actually hits the route.
 *
 *   npm run build && npm run smoke
 *
 * Set BASE_URL to test an already-running server instead of spawning one.
 *
 * Process handling is deliberate. An earlier version spawned `npx next start`
 * and sent SIGTERM to it on the way out; that killed the npx wrapper but not
 * the `next-server` grandchild, whose open stdio pipes kept Node's event loop
 * alive. The checks passed, the script never exited, and CI burned to its job
 * timeout. Hence: spawn the real binary, own the process group, kill the group,
 * exit explicitly, and keep a watchdog so a hang fails fast and loudly.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3210);
const EXTERNAL = process.env.BASE_URL;
const BASE = EXTERNAL ?? `http://localhost:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;
/** Whole-run ceiling. Generous for the work, far below any CI job timeout. */
const WATCHDOG_MS = Number(process.env.SMOKE_WATCHDOG_MS ?? 240_000);

/** Routes that must return 200. Static pages, SSG detail pages, and the API. */
const EXPECT_200 = [
  "/",
  "/onboarding",
  "/offline",
  "/today",
  "/philosophy",
  "/library",
  "/library/flows",
  "/library/spiral-foot-tripod-reset",
  "/library/contralateral-crawl",
  "/sessions",
  "/store",
  "/store/alpha-training-tee-charcoal",
  "/store/alpha-foundations-8-week",
  "/store/cart",
  "/owned",
  "/pulse",
  "/pulse/zone-2-dose-response",
  "/profile",
  "/admin",
  "/api/movements",
  "/api/sessions",
  "/api/products",
  "/api/pulse",
  "/api/calendar/ics",
  "/manifest.webmanifest",
  "/sw.js",
];

/**
 * Routes that must 404. The dynamic ones guard against a soft 404 — rendering
 * the not-found UI with a 200 status, which misleads crawlers and clients.
 * They pass only because each `[slug]` route sets `dynamicParams = false`.
 */
const EXPECT_404 = [
  "/definitely-not-a-page",
  "/library/not-a-movement",
  "/store/not-a-product",
  "/pulse/not-an-article",
];

/**
 * Content assertions. A 200 that renders an empty shell is still a failure,
 * so each route is checked for a string only correct output contains.
 */
const EXPECT_CONTENT = [
  ["/", "Train smarter"],
  ["/philosophy", "Connection before load"],
  ["/library", "Spiral Foot Tripod Reset"],
  ["/library/spiral-foot-tripod-reset", "Why this matters"],
  ["/store", "Alpha Foundations"],
  ["/pulse", "Sample feed"],
  ["/api/movements", '"slug":"spiral-foot-tripod-reset"'],
  ["/api/calendar/ics", "BEGIN:VCALENDAR"],
];

const failures = [];
const serverLog = [];
let server = null;

const record = (message) => {
  failures.push(message);
  console.error(`  ✗ ${message}`);
};

/**
 * Kill the server's whole process group. `next start` is itself a parent of the
 * real `next-server` process, so signalling only the direct child leaves an
 * orphan holding our stdio pipes open.
 */
function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    try {
      server.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Never rely on the event loop draining — the whole point of the bug above. */
function finish(code) {
  stopServer();
  process.exit(code);
}

async function waitForServer() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) {
      throw new Error(
        `Server exited early with code ${server.exitCode}\n${serverLog.join("")}`,
      );
    }
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      // Server still starting.
    }
    await sleep(500);
  }
  throw new Error(
    `Server did not become ready within ${BOOT_TIMEOUT_MS}ms\n${serverLog.join("")}`,
  );
}

async function checkStatus(pathname, expected) {
  try {
    const response = await fetch(`${BASE}${pathname}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== expected) {
      record(`${pathname} → ${response.status}, expected ${expected}`);
      return;
    }
    console.log(`  ✓ ${pathname} → ${response.status}`);
  } catch (error) {
    record(`${pathname} → request failed: ${error.message}`);
  }
}

async function checkContent(pathname, needle) {
  try {
    const response = await fetch(`${BASE}${pathname}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    if (!body.includes(needle)) {
      record(`${pathname} did not contain ${JSON.stringify(needle)}`);
      return;
    }
    console.log(`  ✓ ${pathname} contains ${JSON.stringify(needle)}`);
  } catch (error) {
    record(`${pathname} → content check failed: ${error.message}`);
  }
}

function startServer() {
  const bin = path.resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next",
  );
  if (!existsSync(bin)) {
    throw new Error(`next binary not found at ${bin} — run npm ci first`);
  }

  console.log(`Starting production server on port ${PORT}…`);
  // detached puts the server in its own process group so we can kill the group.
  server = spawn(bin, ["start", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  server.stdout.on("data", (d) => serverLog.push(d.toString()));
  server.stderr.on("data", (d) => serverLog.push(d.toString()));
  server.on("error", (error) => record(`server spawn failed: ${error.message}`));
}

async function main() {
  // Fail fast and loudly rather than hanging until the CI job timeout.
  const watchdog = setTimeout(() => {
    console.error(
      `\nSmoke run exceeded ${WATCHDOG_MS}ms — treating as a hang.\n` +
        `Server output:\n${serverLog.join("")}`,
    );
    finish(1);
  }, WATCHDOG_MS);
  watchdog.unref();

  process.on("SIGINT", () => finish(130));
  process.on("SIGTERM", () => finish(143));

  try {
    if (!EXTERNAL) startServer();
    await waitForServer();

    console.log("\nStatus checks:");
    for (const pathname of EXPECT_200) await checkStatus(pathname, 200);
    for (const pathname of EXPECT_404) await checkStatus(pathname, 404);

    console.log("\nContent checks:");
    for (const [pathname, needle] of EXPECT_CONTENT) {
      await checkContent(pathname, needle);
    }
  } catch (error) {
    record(error.message);
  }

  clearTimeout(watchdog);

  const total = EXPECT_200.length + EXPECT_404.length + EXPECT_CONTENT.length;

  if (failures.length) {
    console.error(`\n${failures.length} of ${total} checks failed.`);
    finish(1);
  }

  console.log(`\nAll ${total} checks passed.`);
  finish(0);
}

main().catch((error) => {
  console.error(error);
  finish(1);
});
