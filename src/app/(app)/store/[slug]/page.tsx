import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check, Download, Truck } from "lucide-react";
import { Container } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/primitives";
import { ProductPurchase } from "./product-purchase";
import {
  getProductBySlug,
  listProductSlugs,
  listProducts,
} from "@/lib/data/repository";
import { PRODUCT_TYPE_LABELS } from "@/lib/data/products";
import { posterStyle } from "@/lib/data/taxonomy";
import { formatPrice } from "@/lib/utils";

// Every slug is known at build time, so anything else is a genuine 404 rather
// than a page to render on demand. Without this, Next serves the not-found UI
// with a 200 (a soft 404) for unknown params.
export const dynamicParams = false;

export async function generateStaticParams() {
  const slugs = await listProductSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: "Product not found" };
  return { title: product.name, description: product.tagline };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const all = await listProducts();
  const related = all
    .filter((p) => p.id !== product.id && p.kind === product.kind)
    .slice(0, 3);

  return (
    <Container>
      <Link
        href="/store"
        className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2"
      >
        <ArrowLeft size={14} />
        Store
      </Link>

      <div className="mt-7 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-12">
        <div className="min-w-0">
          <div
            className="relative aspect-4/3 overflow-hidden rounded-panel border border-line"
            style={posterStyle(product.poster)}
          >
            <span className="absolute top-4 left-4">
              <Badge tone="accent">{PRODUCT_TYPE_LABELS[product.type]}</Badge>
            </span>
          </div>

          <div className="mt-8">
            <h1 className="text-[clamp(1.8rem,4vw,2.5rem)] leading-[1.08] font-medium tracking-[-0.03em] text-ink">
              {product.name}
            </h1>
            <p className="mt-3 text-[17px] leading-relaxed text-ink-2">
              {product.tagline}
            </p>
            {product.creatorName && (
              <p className="mt-3 text-small text-ink-3">
                Published by {product.creatorName}
              </p>
            )}
          </div>

          <div className="mt-8 max-w-2xl text-body leading-[1.75] text-ink-2">
            {product.description}
          </div>

          {product.contents && product.contents.length > 0 && (
            <section className="mt-10">
              <h2 className="text-heading text-ink">What&rsquo;s included</h2>
              <ul className="mt-5 space-y-px overflow-hidden rounded-panel border border-line">
                {product.contents.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3.5 bg-surface/60 px-5 py-3.5"
                  >
                    <Check size={15} className="mt-0.5 shrink-0 text-positive" />
                    <span className="text-small leading-relaxed text-ink-2">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-10 rounded-panel border border-line bg-surface/50 p-6">
            <div className="flex items-center gap-2.5">
              {product.kind === "digital" ? (
                <Download size={15} className="text-ink-3" />
              ) : (
                <Truck size={15} className="text-ink-3" />
              )}
              <h2 className="text-[15px] font-medium text-ink">
                {product.kind === "digital" ? "Delivery" : "Shipping & returns"}
              </h2>
            </div>
            <p className="mt-3 max-w-2xl text-small leading-relaxed text-ink-2">
              {product.kind === "digital"
                ? "Access is granted the moment payment clears and appears in your library immediately. Every asset can be downloaded for offline use, including on the mobile app, and updates are free for life."
                : "Ships within two business days from Portland, Oregon. Free returns within 30 days on unworn items — the sizing guide is worth reading first, particularly for the belt."}
            </p>
          </section>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-8 lg:self-start">
          <ProductPurchase product={product} />
        </aside>
      </div>

      {related.length > 0 && (
        <section className="mt-16 border-t border-line pt-10 pb-8">
          <h2 className="text-heading text-ink">You might also want</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {related.map((item) => (
              <Link
                key={item.id}
                href={`/store/${item.slug}`}
                className="surface-card group overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:border-line-strong"
              >
                <span
                  aria-hidden
                  className="block aspect-4/3"
                  style={posterStyle(item.poster)}
                />
                <span className="block p-4">
                  <span className="block text-[14px] font-medium text-ink">
                    {item.name}
                  </span>
                  <span className="mt-1 block text-[13px] text-ink-3 tabular-nums">
                    {formatPrice(item.priceCents, item.currency)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </Container>
  );
}
