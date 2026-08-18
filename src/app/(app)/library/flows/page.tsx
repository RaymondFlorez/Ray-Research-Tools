import type { Metadata } from "next";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { FlowsList } from "./flows-list";

export const metadata: Metadata = {
  title: "My Flows",
  description:
    "Personal movement sequences built from the Alpha Movement library.",
};

export default function FlowsPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Personal sequences"
        title="Your flows"
        description="Sequences you have assembled from the library. Use them as warm-ups, downshifts, or standalone practice — and drop any of them straight into a session."
        action={
          <Button href="/library" variant="secondary">
            Browse the library
          </Button>
        }
      />
      <FlowsList />
    </Container>
  );
}
