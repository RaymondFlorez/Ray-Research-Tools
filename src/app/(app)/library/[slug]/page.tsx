import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Container } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/primitives";
import { MoviePlayer } from "@/components/movement/movement-player";
import { MovementActions } from "./movement-actions";
import {
  getMovementBySlug,
  getMovementsByIds,
  listMovementSlugs,
} from "@/lib/data/repository";
import { MOVEMENTS } from "@/lib/data/movements";
import { CATEGORIES, FOCUS_META, LEVEL_META } from "@/lib/data/taxonomy";
import { MovementCard } from "@/components/movement/movement-card";
import { formatDuration } from "@/lib/utils";

// Every slug is known at build time, so anything else is a genuine 404 rather
// than a page to render on demand. Without this, Next serves the not-found UI
// with a 200 (a soft 404) for unknown params.
export const dynamicParams = false;

export async function generateStaticParams() {
  const slugs = await listMovementSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const movement = await getMovementBySlug(slug);
  if (!movement) return { title: "Movement not found" };
  return { title: movement.name, description: movement.summary };
}

export default async function MovementPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const movement = await getMovementBySlug(slug);
  if (!movement) notFound();

  const meta = CATEGORIES[movement.category];
  const prerequisites = getMovementsByIds(movement.prerequisites ?? []);
  const progressions = getMovementsByIds(movement.progressions ?? []);
  const regressions = getMovementsByIds(movement.regressions ?? []);
  const related = MOVEMENTS.filter(
    (m) => m.category === movement.category && m.id !== movement.id,
  ).slice(0, 3);

  return (
    <Container>
      {/* ---- Breadcrumb --------------------------------------------------- */}
      <nav className="flex items-center gap-2 text-[13px] text-ink-3">
        <Link href="/library" className="inline-flex items-center gap-1.5 hover:text-ink-2">
          <ArrowLeft size={14} />
          Library
        </Link>
        <ChevronRight size={13} />
        <Link
          href={`/library?category=${movement.category}`}
          className="hover:text-ink-2"
        >
          {meta.short}
        </Link>
        <ChevronRight size={13} />
        <span className="text-ink-2">{movement.group}</span>
      </nav>

      <div className="mt-7 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
        {/* ---- Main column ------------------------------------------------ */}
        <div className="min-w-0">
          <p
            className="text-[11px] font-medium tracking-[0.12em] uppercase"
            style={{ color: meta.colorVar }}
          >
            {meta.name}
          </p>
          <h1 className="mt-3.5 text-[clamp(1.9rem,4.4vw,2.75rem)] leading-[1.06] font-medium tracking-[-0.03em] text-ink">
            {movement.name}
          </h1>
          <p className="mt-4 max-w-2xl text-[17px] leading-[1.65] text-ink-2">
            {movement.summary}
          </p>

          <div className="mt-7">
            <MoviePlayer movement={movement} />
          </div>

          {/* ---- Why this matters — the philosophy made concrete --------- */}
          <section className="mt-10 rounded-panel border border-line bg-surface/50 p-6 sm:p-7">
            <p className="eyebrow">Why this matters</p>
            <p className="mt-4 max-w-2xl text-[17px] leading-[1.7] text-ink">
              {movement.why}
            </p>
          </section>

          {/* ---- Cues ---------------------------------------------------- */}
          <section className="mt-10">
            <h2 className="text-heading text-ink">Coaching cues</h2>
            <p className="mt-2 text-small text-ink-3">
              In the order they should be taught. Own each one before adding the
              next.
            </p>
            <ol className="mt-6 space-y-px overflow-hidden rounded-panel border border-line">
              {movement.cues.map((cue, index) => (
                <li
                  key={cue}
                  className="flex items-start gap-4 bg-surface/60 px-5 py-4"
                >
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line text-[11px] text-ink-3 tabular-nums">
                    {index + 1}
                  </span>
                  <span className="text-body leading-relaxed text-ink-2">
                    {cue}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {/* ---- Progression map ------------------------------------------ */}
          {(prerequisites.length || progressions.length || regressions.length) > 0 && (
            <section className="mt-10">
              <h2 className="text-heading text-ink">Progression map</h2>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <ProgressionColumn
                  label="Prerequisites"
                  hint="Own these first"
                  movements={prerequisites}
                />
                <ProgressionColumn
                  label="Regressions"
                  hint="If the position is not available yet"
                  movements={regressions}
                />
                <ProgressionColumn
                  label="Progressions"
                  hint="Once this is owned"
                  movements={progressions}
                />
              </div>
            </section>
          )}
        </div>

        {/* ---- Sidebar ------------------------------------------------------ */}
        <aside className="min-w-0 space-y-4 lg:sticky lg:top-8 lg:self-start">
          <MovementActions movement={movement} />

          <dl className="overflow-hidden rounded-card border border-line">
            <SpecRow label="Level" value={LEVEL_META[movement.level].label} />
            <SpecRow
              label="Prescribed"
              value={formatDuration(Math.max(1, Math.round(movement.durationSec / 60)))}
            />
            <SpecRow label="Pillar" value={meta.short} />
            <SpecRow
              label="Equipment"
              value={movement.equipment.length ? movement.equipment.join(", ") : "None"}
            />
          </dl>

          <div className="rounded-card border border-line p-5">
            <p className="eyebrow">Chains organised</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {movement.chains.map((chain) => (
                <Badge key={chain}>{chain}</Badge>
              ))}
            </div>
          </div>

          <div className="rounded-card border border-line p-5">
            <p className="eyebrow">Serves</p>
            <ul className="mt-3 space-y-2.5">
              {movement.focus.map((f) => (
                <li key={f}>
                  <p className="text-[13px] font-medium text-ink">
                    {FOCUS_META[f].label}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">
                    {FOCUS_META[f].description}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {/* ---- Related ------------------------------------------------------- */}
      {related.length > 0 && (
        <section className="mt-16 border-t border-line pt-10 pb-8">
          <h2 className="text-heading text-ink">More from {meta.short}</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((m, i) => (
              <MovementCard key={m.id} movement={m} index={i} />
            ))}
          </div>
        </section>
      )}
    </Container>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="text-right text-[13px] text-ink capitalize">{value}</dd>
    </div>
  );
}

function ProgressionColumn({
  label,
  hint,
  movements,
}: {
  label: string;
  hint: string;
  movements: { id: string; slug: string; name: string }[];
}) {
  return (
    <div className="rounded-card border border-line p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-1.5 text-[12px] text-ink-3">{hint}</p>
      <ul className="mt-3.5 space-y-2">
        {movements.length ? (
          movements.map((m) => (
            <li key={m.id}>
              <Link
                href={`/library/${m.slug}`}
                className="text-[13px] text-ink-2 transition-colors hover:text-accent-hi"
              >
                {m.name}
              </Link>
            </li>
          ))
        ) : (
          <li className="text-[13px] text-ink-3">—</li>
        )}
      </ul>
    </div>
  );
}
