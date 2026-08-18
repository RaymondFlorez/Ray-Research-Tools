import type { Metadata } from "next";
import { Suspense } from "react";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { SkeletonCard } from "@/components/ui/primitives";
import { StoreBrowser } from "./store-browser";
import { listProducts } from "@/lib/data/repository";
import { LibraryBig } from "lucide-react";

export const metadata: Metadata = {
  title: "Store",
  description:
    "Alpha Movement apparel, training gear, recovery tools, programs, manuals, video series, and audio guides.",
};

export default async function StorePage() {
  const products = await listProducts();

  return (
    <Container>
      <PageHeader
        eyebrow="Store"
        title="Equipment and information, held to the same standard."
        description="Physical goods built for the way this system trains, and digital products that teach it. Everything digital lands in your library immediately and works offline."
        action={
          <Button href="/owned" variant="secondary">
            <LibraryBig size={15} />
            My library
          </Button>
        }
      />
      <Suspense
        fallback={
          <div className="grid gap-4 py-8 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        }
      >
        <StoreBrowser products={products} />
      </Suspense>
    </Container>
  );
}
