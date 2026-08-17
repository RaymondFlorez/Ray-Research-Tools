import type { Metadata } from "next";
import { Suspense } from "react";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { OwnedLibrary } from "./owned-library";

export const metadata: Metadata = {
  title: "My Library",
  description:
    "Programs, manuals, video series, and audio guides you own — downloadable for offline training.",
};

export default function OwnedPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Owned content"
        title="Your library"
        description="Everything you have bought, with progress tracked and offline downloads managed here. Downloaded content stays available with no connection."
        action={
          <Button href="/store" variant="secondary">
            Browse the store
          </Button>
        }
      />
      <Suspense
        fallback={
          <div className="space-y-3 py-8">
            <Skeleton className="h-28 w-full rounded-card" />
            <Skeleton className="h-28 w-full rounded-card" />
          </div>
        }
      >
        <OwnedLibrary />
      </Suspense>
    </Container>
  );
}
