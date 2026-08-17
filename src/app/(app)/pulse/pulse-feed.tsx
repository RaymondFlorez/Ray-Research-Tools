"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Bookmark, Info, Quote, Search, Sparkles } from "lucide-react";
import type { PulseArticle, PulseTopic } from "@/types";
import { TOPIC_META, TOPIC_ORDER, FOCUS_META, posterStyle } from "@/lib/data/taxonomy";
import { PULSE_IS_SAMPLE_CONTENT } from "@/lib/data/pulse";
import { filterPulse } from "@/lib/data/repository";
import { Badge, EmptyState, Input, Segmented } from "@/components/ui/primitives";
import { Button, IconButton } from "@/components/ui/button";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import { cn, relativeTime } from "@/lib/utils";

type View = PulseTopic | "all" | "saved";

export function PulseFeed({ articles }: { articles: PulseArticle[] }) {
  const hydrated = useStoreHydrated();
  const focus = useAppStore((s) => s.focus);
  const personalize = useAppStore((s) => s.personalizeFeed);
  const setPersonalize = useAppStore((s) => s.setPersonalizeFeed);
  const saved = useAppStore((s) => s.savedArticles);
  const toggleSaved = useAppStore((s) => s.toggleSavedArticle);

  const [view, setView] = React.useState<View>("all");
  const [search, setSearch] = React.useState("");

  const results = React.useMemo(() => {
    if (view === "saved") {
      return filterPulse(
        articles.filter((a) => saved.includes(a.id)),
        { search },
      );
    }
    const base = filterPulse(articles, { topic: view, search });
    if (!personalize || !focus.length || view !== "all") return base;

    // Personalisation reorders rather than filters — nothing is hidden from you.
    return [...base].sort((a, b) => {
      const score = (article: PulseArticle) =>
        article.relatedFocus.filter((f) => focus.includes(f)).length;
      return score(b) - score(a);
    });
  }, [articles, view, search, saved, personalize, focus]);

  return (
    <div className="space-y-6 py-8">
      {PULSE_IS_SAMPLE_CONTENT && (
        <div className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning/6 px-5 py-4">
          <Info size={15} className="mt-0.5 shrink-0 text-warning" />
          <p className="text-[13px] leading-relaxed text-ink-2">
            <span className="font-medium text-warning">Sample feed.</span> These
            entries are illustrative content written for this build — the sources
            and headlines are placeholders, not real publications. Connecting the
            ingestion pipeline replaces them with attributed, deduplicated items
            from real feeds.
          </p>
        </div>
      )}

      {/* ---- Controls ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "all" as const, label: "All", count: articles.length },
            ...TOPIC_ORDER.map((topic) => ({
              value: topic,
              label: TOPIC_META[topic].short,
              count: articles.filter((a) => a.topic === topic).length,
            })),
            {
              value: "saved" as const,
              label: "Saved",
              count: hydrated ? saved.length : undefined,
            },
          ]}
        />
        <div className="relative min-w-[12rem] flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the feed…"
            aria-label="Search Pulse"
            className="pl-9"
          />
        </div>
      </div>

      {/* ---- Personalisation ------------------------------------------------ */}
      {hydrated && focus.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface/50 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Sparkles size={14} className="text-accent" />
            <p className="text-[13px] text-ink-2">
              {personalize
                ? "Ordered by your training focus"
                : "Ordered chronologically"}
              <span className="ml-2 text-ink-3">
                {focus.map((f) => FOCUS_META[f].label).join(" · ")}
              </span>
            </p>
          </div>
          <button
            onClick={() => setPersonalize(!personalize)}
            className="text-[13px] text-ink-3 transition-colors hover:text-ink"
          >
            {personalize ? "Show newest first" : "Personalise"}
          </button>
        </div>
      )}

      {/* ---- Feed ---------------------------------------------------------- */}
      {results.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {results.map((article, index) => {
            const isSaved = hydrated && saved.includes(article.id);
            const relevant =
              hydrated &&
              personalize &&
              article.relatedFocus.some((f) => focus.includes(f));

            return (
              <motion.article
                key={article.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.5,
                  delay: Math.min(index * 0.04, 0.3),
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="surface-card flex flex-col overflow-hidden transition-all duration-300 ease-[var(--ease-out-quint)] hover:-translate-y-1 hover:border-line-strong hover:shadow-mid"
              >
                <Link
                  href={`/pulse/${article.slug}`}
                  className="relative block h-28"
                  style={posterStyle(article.poster)}
                >
                  <span className="absolute top-3 left-3">
                    <Badge>{TOPIC_META[article.topic].short}</Badge>
                  </span>
                  {relevant && (
                    <span className="absolute top-3 right-3">
                      <Badge tone="accent">
                        <Sparkles size={10} />
                        For you
                      </Badge>
                    </span>
                  )}
                </Link>

                <div className="flex flex-1 flex-col p-5">
                  <p className="text-[12px] text-ink-3">
                    {article.source} · {relativeTime(article.publishedAt)} ·{" "}
                    {article.readMinutes} min read
                  </p>
                  <h2 className="mt-2 text-[17px] leading-snug font-medium tracking-[-0.014em] text-ink">
                    <Link
                      href={`/pulse/${article.slug}`}
                      className="hover:text-accent-hi"
                    >
                      {article.title}
                    </Link>
                  </h2>
                  <p className="mt-2.5 line-clamp-3 text-small leading-relaxed text-ink-2">
                    {article.summary}
                  </p>

                  {article.alphaTake && (
                    <div className="mt-4 rounded-[11px] border border-line bg-void/50 p-4">
                      <div className="flex items-center gap-2">
                        <Quote size={12} className="text-accent" />
                        <p className="text-[11px] tracking-[0.1em] text-ink-3 uppercase">
                          Alpha Movement take
                        </p>
                      </div>
                      <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-ink-2">
                        {article.alphaTake}
                      </p>
                      {article.takeAuthor && (
                        <p className="mt-2 text-[11px] text-ink-3">
                          — {article.takeAuthor}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                    <Link
                      href={`/pulse/${article.slug}`}
                      className="text-[13px] text-ink-2 transition-colors hover:text-accent-hi"
                    >
                      Read more
                    </Link>
                    <IconButton
                      label={isSaved ? "Remove from saved" : "Save for later"}
                      active={isSaved}
                      onClick={() => toggleSaved(article.id)}
                    >
                      <Bookmark
                        size={15}
                        fill={isSaved ? "currentColor" : "none"}
                      />
                    </IconButton>
                  </div>
                </div>
              </motion.article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Bookmark size={18} />}
          title={view === "saved" ? "Nothing saved yet" : "No matching stories"}
          description={
            view === "saved"
              ? "Use the bookmark on any card to keep it here for later."
              : "Try a different topic or clear the search."
          }
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setView("all");
                setSearch("");
              }}
            >
              Show everything
            </Button>
          }
        />
      )}
    </div>
  );
}

/** Shared topic pill, also used on the article page. */
export function TopicPill({
  topic,
  className,
}: {
  topic: PulseTopic;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-pill border border-line px-2.5 py-0.5 text-[11px] text-ink-2",
        className,
      )}
    >
      {TOPIC_META[topic].label}
    </span>
  );
}
