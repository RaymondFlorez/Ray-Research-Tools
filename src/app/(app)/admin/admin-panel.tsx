"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ShieldAlert, X } from "lucide-react";
import type { Coach, Movement, Product, PulseArticle } from "@/types";
import { Badge, Segmented, Stat } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Toast } from "@/components/ui/overlay";
import { Avatar } from "@/components/layout/logo";
import { CATEGORIES, TOPIC_META } from "@/lib/data/taxonomy";
import { PRODUCT_TYPE_LABELS } from "@/lib/data/products";
import { formatPrice, relativeTime } from "@/lib/utils";

type Tab = "overview" | "moderation" | "content" | "coaches" | "curation";

export function AdminPanel({
  products,
  coaches,
  movements,
  articles,
}: {
  products: Product[];
  coaches: Coach[];
  movements: Movement[];
  articles: PulseArticle[];
}) {
  const [tab, setTab] = React.useState<Tab>("overview");
  const [decisions, setDecisions] = React.useState<Record<string, string>>({});
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const pending = products.filter(
    (p) => p.moderation === "pending" && !decisions[p.id],
  );

  const decide = (id: string, name: string, verdict: "approved" | "rejected") => {
    setDecisions((current) => ({ ...current, [id]: verdict }));
    setToast(`${name} ${verdict}`);
  };

  return (
    <div className="space-y-6 py-8">
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "overview", label: "Overview" },
          { value: "moderation", label: "Moderation", count: pending.length },
          { value: "content", label: "Movements", count: movements.length },
          { value: "coaches", label: "Coaches", count: coaches.length },
          { value: "curation", label: "Pulse", count: articles.length },
        ]}
      />

      {/* ---- Overview ------------------------------------------------------- */}
      {tab === "overview" && (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Session completion"
              value="87"
              unit="%"
              delta={{ value: "+4 pts vs last block" }}
            />
            <Stat
              label="30-day retention"
              value="71"
              unit="%"
              delta={{ value: "+2 pts" }}
            />
            <Stat
              label="Products live"
              value={products.filter((p) => p.moderation === "approved").length}
            />
            <Stat
              label="Pending review"
              value={pending.length}
              delta={{
                value: pending.length ? "Needs attention" : "Queue clear",
                positive: pending.length === 0,
              }}
            />
          </section>

          <section className="surface-card p-6">
            <h2 className="text-heading text-ink">What we measure</h2>
            <p className="mt-2 max-w-2xl text-small leading-relaxed text-ink-2">
              Analytics are scoped deliberately narrowly: retention, session
              completion, and product engagement. We do not instrument
              engagement-maximising metrics — time-in-app is not a goal, and a
              session an athlete skips because they needed rest is not a failure.
            </p>
            <ul className="mt-5 grid gap-3 sm:grid-cols-3">
              {[
                {
                  name: "Retention",
                  events: "session.completed, cycle.progressed, app.opened",
                },
                {
                  name: "Session completion",
                  events: "session.scheduled → session.logged conversion",
                },
                {
                  name: "Product engagement",
                  events: "product.viewed, checkout.completed, content.progressed",
                },
              ].map((metric) => (
                <li
                  key={metric.name}
                  className="rounded-card border border-line bg-void/40 p-4"
                >
                  <p className="text-[14px] font-medium text-ink">
                    {metric.name}
                  </p>
                  <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-ink-3">
                    {metric.events}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {/* ---- Moderation ------------------------------------------------------ */}
      {tab === "moderation" && (
        <section className="space-y-3">
          {pending.length ? (
            pending.map((product) => (
              <article key={product.id} className="surface-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="warning">
                        <ShieldAlert size={11} />
                        Pending review
                      </Badge>
                      <Badge>{PRODUCT_TYPE_LABELS[product.type]}</Badge>
                    </div>
                    <h3 className="mt-3 text-[17px] font-medium text-ink">
                      {product.name}
                    </h3>
                    <p className="mt-1 text-[12px] text-ink-3">
                      Submitted by {product.creatorName ?? "Unknown"} ·{" "}
                      {formatPrice(product.priceCents, product.currency)}
                    </p>
                    <p className="mt-3 max-w-2xl text-small leading-relaxed text-ink-2">
                      {product.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => decide(product.id, product.name, "rejected")}
                    >
                      <X size={14} />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => decide(product.id, product.name, "approved")}
                    >
                      <Check size={14} />
                      Approve
                    </Button>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-panel border border-dashed border-line px-6 py-14 text-center">
              <p className="text-[15px] font-medium text-ink">Queue clear</p>
              <p className="mt-2 text-small text-ink-3">
                Every submitted product has been reviewed.
              </p>
            </div>
          )}
        </section>
      )}

      {/* ---- Movements ------------------------------------------------------- */}
      {tab === "content" && (
        <section className="surface-card overflow-hidden">
          <table className="w-full text-left text-small">
            <thead>
              <tr className="border-b border-line text-[11px] tracking-[0.1em] text-ink-3 uppercase">
                <th className="px-5 py-3 font-medium">Movement</th>
                <th className="px-5 py-3 font-medium">Pillar</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">
                  Level
                </th>
                <th className="hidden px-5 py-3 font-medium md:table-cell">
                  Media
                </th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr
                  key={movement.id}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-5 py-3">
                    <Link
                      href={`/library/${movement.slug}`}
                      className="text-ink hover:text-accent-hi"
                    >
                      {movement.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <span
                      style={{ color: CATEGORIES[movement.category].colorVar }}
                    >
                      {CATEGORIES[movement.category].short}
                    </span>
                  </td>
                  <td className="hidden px-5 py-3 text-ink-2 capitalize sm:table-cell">
                    {movement.level}
                  </td>
                  <td className="hidden px-5 py-3 md:table-cell">
                    <span className="text-[12px] text-warning">Awaiting upload</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ---- Coaches --------------------------------------------------------- */}
      {tab === "coaches" && (
        <section className="grid gap-3 lg:grid-cols-2">
          {coaches.map((coach) => (
            <article key={coach.id} className="surface-card p-5">
              <div className="flex items-start gap-3.5">
                <Avatar seed={coach.avatarSeed} name={coach.name} size={44} />
                <div className="min-w-0">
                  <h3 className="text-[15px] font-medium text-ink">
                    {coach.name}
                  </h3>
                  <p className="text-[12px] text-ink-3">{coach.title}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="positive">Approved</Badge>
                    {coach.specialties.map((s) => (
                      <Badge key={s}>{CATEGORIES[s].short}</Badge>
                    ))}
                  </div>
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-[12px]">
                <div>
                  <dt className="text-ink-3">Session rate</dt>
                  <dd className="mt-0.5 text-ink tabular-nums">
                    {formatPrice(coach.sessionRateCents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-3">Availability windows</dt>
                  <dd className="mt-0.5 text-ink tabular-nums">
                    {coach.availability.length}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-ink-3">Credentials</dt>
                  <dd className="mt-0.5 text-ink-2">
                    {coach.credentials.join(" · ")}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </section>
      )}

      {/* ---- Pulse curation ---------------------------------------------------- */}
      {tab === "curation" && (
        <section className="space-y-3">
          {articles.map((article) => (
            <article key={article.id} className="surface-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{TOPIC_META[article.topic].short}</Badge>
                    <span className="text-[12px] text-ink-3">
                      {article.source} · {relativeTime(article.publishedAt)}
                    </span>
                  </div>
                  <h3 className="mt-2.5 text-[15px] font-medium text-ink">
                    <Link
                      href={`/pulse/${article.slug}`}
                      className="hover:text-accent-hi"
                    >
                      {article.title}
                    </Link>
                  </h3>
                  <p className="mt-1.5 text-[12px] text-ink-3">
                    {article.alphaTake
                      ? `Take by ${article.takeAuthor}`
                      : "No editorial take yet"}
                  </p>
                </div>
                <Badge tone={article.alphaTake ? "positive" : "warning"}>
                  {article.alphaTake ? "Published" : "Needs a take"}
                </Badge>
              </div>
            </article>
          ))}
        </section>
      )}

      <Toast message={toast} open={Boolean(toast)} />
    </div>
  );
}
