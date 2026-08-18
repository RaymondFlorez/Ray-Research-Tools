import type { Metadata } from "next";
import { Suspense } from "react";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { SkeletonCard } from "@/components/ui/primitives";
import { PulseFeed } from "./pulse-feed";
import { listPulse } from "@/lib/data/repository";

export const metadata: Metadata = {
  title: "Pulse",
  description:
    "Fitness science, recovery and longevity, movement culture, and mind-body research — with the Alpha Movement reading on each.",
};

export default async function PulsePage() {
  const articles = await listPulse();

  return (
    <Container>
      <PageHeader
        eyebrow="Pulse"
        title="What's moving in training, recovery, and movement culture."
        description="Curated rather than aggregated. Every item carries its source, a short summary, and — where we have something worth adding — the Alpha Movement reading on it."
      />
      <Suspense
        fallback={
          <div className="grid gap-4 py-8 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        }
      >
        <PulseFeed articles={articles} />
      </Suspense>
    </Container>
  );
}
