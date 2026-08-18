import type { Metadata } from "next";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { CartView } from "./cart-view";

export const metadata: Metadata = {
  title: "Cart",
  description: "Review your Alpha Movement order before checkout.",
};

export default function CartPage() {
  return (
    <Container className="max-w-4xl">
      <PageHeader
        eyebrow="Checkout"
        title="Your cart"
        description="Digital products are granted immediately on payment. Physical goods ship within two business days."
      />
      <CartView />
    </Container>
  );
}
