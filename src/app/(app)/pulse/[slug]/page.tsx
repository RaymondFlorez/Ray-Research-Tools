import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Quote } from "lucide-react";
import { Container } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/primitives";
import { ArticleActions } from "./article-actions";
import { getPulseBySlug, listPulse, listPulseSlugs } from "@/lib/data/repository";
import { FOCUS_META, TOPIC_META, posterStyle } from "@/lib/data/taxonomy";
import { PULSE_IS_SAMPLE_CONTENT } from "@/lib/data/pulse";
import { relativeTime } from "@/lib/utils";

export async function generateStaticParams() {
  const slugs = await listPulseSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await getPulseBySlug(slug);
  if (!article) return { title: "Article not found" };
  return { title: article.title, description: article.summary };
}

export default async function PulseArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = await getPulseBySlug(slug);
  if (!article) notFound();

  const all = await listPulse();
  const related = all
    .filter((a) => a.id !== article.id && a.topic === article.topic)
    .slice(0, 3);

  return (
    <Container className="max-w-3xl">
      <Link
        href="/pulse"
        className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2"
      >
        <ArrowLeft size={14} />
        Pulse
      </Link>

      <article className="mt-7">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{TOPIC_META[article.topic].label}</Badge>
          <span className="text-[12px] text-ink-3">
            {article.readMinutes} min read
          </span>
        </div>

        <h1 className="mt-5 text-[clamp(1.75rem,4.4vw,2.5rem)] leading-[1.1] font-medium tracking-[-0.03em] text-ink">
          {article.title}
        </h1>

        <p className="mt-4 text-[13px] text-ink-3">
          {article.source} · published {relativeTime(article.publishedAt)}
        </p>

        <div
          aria-hidden
          className="mt-8 h-40 rounded-panel border border-line"
          style={posterStyle(article.poster)}
        />

        <div className="mt-8">
          <ArticleActions article={article} />
        </div>

        <section className="mt-9">
          <h2 className="eyebrow">Summary</h2>
          <p className="mt-3 text-[17px] leading-[1.75] text-ink-2">
            {article.summary}
          </p>
        </section>

        {article.alphaTake && (
          <section className="mt-9 rounded-panel border border-titanium/25 bg-surface/60 p-6 sm:p-7">
            <div className="flex items-center gap-2">
              <Quote size={14} className="text-accent" />
              <h2 className="text-[11px] tracking-[0.12em] text-ink-3 uppercase">
                The Alpha Movement take
              </h2>
            </div>
            <p className="mt-4 text-[17px] leading-[1.75] text-ink">
              {article.alphaTake}
            </p>
            {article.takeAuthor && (
              <p className="mt-4 text-[13px] text-ink-3">
                — {article.takeAuthor}
              </p>
            )}
          </section>
        )}

        <section className="mt-9">
          <h2 className="eyebrow">Relevant if you train for</h2>
          <ul className="mt-3.5 space-y-2.5">
            {article.relatedFocus.map((f) => (
              <li key={f}>
                <p className="text-[14px] font-medium text-ink">
                  {FOCUS_META[f].label}
                </p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">
                  {FOCUS_META[f].description}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-9 rounded-card border border-line p-5">
          <p className="eyebrow">Source</p>
          <p className="mt-2.5 text-small text-ink-2">{article.source}</p>
          {PULSE_IS_SAMPLE_CONTENT ? (
            <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
              This is illustrative sample content written for this build — the
              source and link are placeholders rather than a real publication.
              Live items link out to the original.
            </p>
          ) : (
            <a
              href={article.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-small text-accent-hi hover:underline"
            >
              Read the original
              <ExternalLink size={13} />
            </a>
          )}
        </section>
      </article>

      {related.length > 0 && (
        <section className="mt-14 border-t border-line pt-9 pb-8">
          <h2 className="text-heading text-ink">
            More in {TOPIC_META[article.topic].short}
          </h2>
          <ul className="mt-5 space-y-2">
            {related.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/pulse/${item.slug}`}
                  className="block rounded-card border border-line bg-surface/50 px-5 py-4 transition-colors hover:border-line-strong"
                >
                  <p className="text-[14px] font-medium text-ink">
                    {item.title}
                  </p>
                  <p className="mt-1 text-[12px] text-ink-3">
                    {item.source} · {relativeTime(item.publishedAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Container>
  );
}
