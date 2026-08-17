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
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 3210);
const EXTERNAL = process.env.BASE_URL;
const BASE = EXTERNAL ?? `http://localhost:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;

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
const record = (message) => {
  failures.push(message);
  console.error(`  ✗ ${message}`);
};

async function waitForServer() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      // Server still starting.
    }
    await sleep(500);
  }
  throw new Error(`Server did not become ready within ${BOOT_TIMEOUT_MS}ms`);
}

async function checkStatus(path, expected) {
  try {
    const response = await fetch(`${BASE}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== expected) {
      record(`${path} → ${response.status}, expected ${expected}`);
      return;
    }
    console.log(`  ✓ ${path} → ${response.status}`);
  } catch (error) {
    record(`${path} → request failed: ${error.message}`);
  }
}

async function checkContent(path, needle) {
  try {
    const response = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    if (!body.includes(needle)) {
      record(`${path} did not contain ${JSON.stringify(needle)}`);
      return;
    }
    console.log(`  ✓ ${path} contains ${JSON.stringify(needle)}`);
  } catch (error) {
    record(`${path} → content check failed: ${error.message}`);
  }
}

async function main() {
  let server;

  if (!EXTERNAL) {
    console.log(`Starting production server on port ${PORT}…`);
    server = spawn("npx", ["next", "start", "-p", String(PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    // Surface server output only if something goes wrong.
    const log = [];
    server.stdout.on("data", (d) => log.push(d.toString()));
    server.stderr.on("data", (d) => log.push(d.toString()));
    server.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(log.join(""));
      }
    });
  }

  const stop = () => {
    if (server && !server.killed) server.kill("SIGTERM");
  };
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });

  try {
    await waitForServer();

    console.log("\nStatus checks:");
    for (const path of EXPECT_200) await checkStatus(path, 200);
    for (const path of EXPECT_404) await checkStatus(path, 404);

    console.log("\nContent checks:");
    for (const [path, needle] of EXPECT_CONTENT) await checkContent(path, needle);
  } catch (error) {
    record(error.message);
  } finally {
    stop();
  }

  const total =
    EXPECT_200.length + EXPECT_404.length + EXPECT_CONTENT.length;

  if (failures.length) {
    console.error(`\n${failures.length} of ${total} checks failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${total} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
