import type { Metadata } from "next";
import { Suspense } from "react";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { SkeletonCard } from "@/components/ui/primitives";
import { LibraryBrowser } from "./library-browser";
import { MOVEMENTS } from "@/lib/data/movements";
import { ListMusic } from "lucide-react";

export const metadata: Metadata = {
  title: "Movement Library",
  description:
    "Every movement in the Alpha Movement system, organised by pillar, with coaching cues and the reason it exists.",
};

export default function LibraryPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Movement library"
        title="Every movement, with the reason it exists."
        description="Organised by pillar rather than by body part, because the pillar is what decides where a movement sits in a session. Favourite anything to pin it, or string movements together into a personal flow."
        action={
          <Button href="/library/flows" variant="secondary">
            <ListMusic size={15} />
            My flows
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
        <LibraryBrowser movements={MOVEMENTS} />
      </Suspense>
    </Container>
  );
}
