"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import {
  CalendarDays,
  Compass,
  Gauge,
  Library,
  Newspaper,
  Search,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store/app-store";
import { Avatar, LogoMark, Wordmark } from "./logo";
import { CURRENT_USER } from "@/lib/data/people";

/* ============================================================================
   APP SHELL
   Side rail on desktop, bottom tab bar on mobile — both minimal, both with a
   single spring-animated active indicator rather than per-item transitions.
   ========================================================================= */

const NAV = [
  { href: "/today", label: "Today", icon: Gauge },
  { href: "/philosophy", label: "Philosophy", icon: Compass },
  { href: "/library", label: "Library", icon: Library },
  { href: "/sessions", label: "Sessions", icon: CalendarDays },
  { href: "/store", label: "Store", icon: ShoppingBag },
  { href: "/pulse", label: "Pulse", icon: Newspaper },
] as const;

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const cartCount = useAppStore((s) =>
    s.cart.reduce((sum, line) => sum + line.quantity, 0),
  );

  return (
    <div className="flex min-h-dvh">
      {/* ---- Desktop side rail ------------------------------------------ */}
      <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col border-r border-line px-4 py-6 lg:flex">
        <Link
          href="/today"
          className="mb-9 flex items-center gap-2.5 px-2 text-ink transition-opacity hover:opacity-80"
        >
          <LogoMark size={28} />
          <Wordmark className="text-[13px]" />
        </Link>

        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-3 rounded-[11px] px-3 py-2.5 text-small transition-colors duration-200",
                  active ? "text-ink" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="rail-active"
                    transition={{ type: "spring", stiffness: 400, damping: 34 }}
                    className="absolute inset-0 -z-10 rounded-[11px] border border-line bg-surface"
                  />
                )}
                <Icon size={17} strokeWidth={active ? 1.9 : 1.6} />
                <span className={active ? "font-medium" : undefined}>
                  {item.label}
                </span>
                {item.href === "/store" && cartCount > 0 && (
                  <span className="ml-auto rounded-pill bg-accent-hi px-1.5 text-[11px] leading-4 font-medium text-void tabular-nums">
                    {cartCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-1">
          <Link
            href="/admin"
            className="flex items-center gap-3 rounded-[11px] px-3 py-2.5 text-small text-ink-3 transition-colors hover:text-ink-2"
          >
            <Sparkles size={17} strokeWidth={1.6} />
            Admin
          </Link>
          <Link
            href="/profile"
            className="flex items-center gap-3 rounded-[11px] border border-line bg-surface px-3 py-2.5 transition-colors hover:border-line-strong"
          >
            <Avatar seed={CURRENT_USER.avatarSeed} name={CURRENT_USER.name} size={28} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-ink">
                {CURRENT_USER.name}
              </span>
              <span className="block text-[11px] text-ink-3">View profile</span>
            </span>
          </Link>
        </div>
      </aside>

      {/* ---- Main column ------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar />
        <main className="min-w-0 flex-1 pb-24 lg:pb-0">{children}</main>
        <MobileTabBar pathname={pathname} cartCount={cartCount} />
      </div>
    </div>
  );
}

function MobileTopBar() {
  return (
    <header className="chrome-blur sticky top-0 z-50 flex items-center justify-between border-b border-line px-4 py-3 lg:hidden">
      <Link href="/today" className="flex items-center gap-2 text-ink">
        <LogoMark size={24} />
        <Wordmark className="text-[11px]" />
      </Link>
      <div className="flex items-center gap-2">
        <Link
          href="/library?focus=search"
          aria-label="Search the library"
          className="grid h-9 w-9 place-items-center rounded-[10px] border border-line text-ink-3"
        >
          <Search size={16} />
        </Link>
        <Link href="/profile" aria-label="Profile">
          <Avatar seed={CURRENT_USER.avatarSeed} name={CURRENT_USER.name} size={30} />
        </Link>
      </div>
    </header>
  );
}

function MobileTabBar({
  pathname,
  cartCount,
}: {
  pathname: string;
  cartCount: number;
}) {
  return (
    <nav className="chrome-blur fixed inset-x-0 bottom-0 z-50 border-t border-line pb-[env(safe-area-inset-bottom)] lg:hidden">
      <div className="flex items-stretch justify-around">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className="relative flex flex-1 flex-col items-center gap-1 py-2.5"
            >
              {active && (
                <motion.span
                  layoutId="tab-active"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="absolute top-0 h-px w-8 bg-accent-hi"
                />
              )}
              <span className="relative">
                <Icon
                  size={19}
                  strokeWidth={active ? 1.9 : 1.5}
                  className={active ? "text-ink" : "text-ink-3"}
                />
                {item.href === "/store" && cartCount > 0 && (
                  <span className="absolute -top-1 -right-1.5 grid h-3.5 min-w-3.5 place-items-center rounded-pill bg-accent-hi px-1 text-[9px] font-semibold text-void">
                    {cartCount}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "text-[10px] tracking-[0.02em]",
                  active ? "text-ink" : "text-ink-3",
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** Consistent page container + header used by every screen inside the shell. */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-5 border-b border-line pb-7">
      <div className="max-w-2xl">
        {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
        <h1 className="text-[clamp(1.9rem,4vw,2.6rem)] leading-[1.06] font-medium tracking-[-0.028em] text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-3.5 text-body leading-relaxed text-ink-2">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-5 py-8 sm:px-8", className)}>
      {children}
    </div>
  );
}
