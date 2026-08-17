import type { Metadata } from "next";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { AdminPanel } from "./admin-panel";
import { listCoaches, listProducts } from "@/lib/data/repository";
import { MOVEMENTS } from "@/lib/data/movements";
import { PULSE_ARTICLES } from "@/lib/data/pulse";

export const metadata: Metadata = {
  title: "Admin",
  description:
    "Content management, coach onboarding, product moderation, news curation, and platform analytics.",
};

export default async function AdminPage() {
  const [products, coaches] = await Promise.all([
    listProducts({ includeUnapproved: true }),
    listCoaches(),
  ]);

  return (
    <Container>
      <PageHeader
        eyebrow="Admin"
        title="Platform operations"
        description="Content management, coach onboarding, product moderation, and news curation. Access is gated on the ADMIN role; this build renders it openly for review."
      />
      <AdminPanel
        products={products}
        coaches={coaches}
        movements={MOVEMENTS}
        articles={PULSE_ARTICLES}
      />
    </Container>
  );
}
