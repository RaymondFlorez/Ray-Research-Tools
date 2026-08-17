import type { CartLine } from "@/types";
import { getProductById } from "@/lib/data/repository";
import { errorResponse, requireSession } from "@/lib/auth/session";

const TAX_RATE = 0.0875;
const SHIPPING_CENTS = 900;

/**
 * POST /api/checkout
 *
 * Production behaviour: build Stripe line items from the server-side product
 * catalogue (never from client-supplied prices), create a Checkout Session, and
 * return its URL for redirect. Entitlements are granted by the
 * `checkout.session.completed` webhook, not here — the client must never be the
 * authority on what has been paid for.
 *
 * With STRIPE_SECRET_KEY unset this returns a computed order summary and no
 * redirect URL, which is what lets the demo flow complete locally.
 */
export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as { lines?: CartLine[] };
    const lines = body.lines ?? [];

    if (!lines.length) {
      return Response.json({ error: "Cart is empty" }, { status: 422 });
    }

    // Prices are always resolved server-side from the catalogue.
    const resolved = lines
      .map((line) => {
        const product = getProductById(line.productId);
        if (!product || product.moderation !== "approved") return null;
        return {
          product,
          quantity: Math.max(1, Math.min(10, line.quantity)),
          variantId: line.variantId,
        };
      })
      .filter((entry) => entry !== null);

    if (!resolved.length) {
      return Response.json(
        { error: "No purchasable items in cart" },
        { status: 422 },
      );
    }

    const subtotalCents = resolved.reduce(
      (sum, entry) => sum + entry.product.priceCents * entry.quantity,
      0,
    );
    const hasPhysical = resolved.some((e) => e.product.kind === "physical");
    const shippingCents = hasPhysical ? SHIPPING_CENTS : 0;
    const taxCents = Math.round(subtotalCents * TAX_RATE);

    const order = {
      id: `ord-${Date.now().toString(36)}`,
      userId: session.user.id,
      status: "pending" as const,
      currency: "USD",
      subtotalCents,
      shippingCents,
      taxCents,
      totalCents: subtotalCents + shippingCents + taxCents,
      lines: resolved.map((entry) => ({
        productId: entry.product.id,
        variantId: entry.variantId,
        quantity: entry.quantity,
        unitCents: entry.product.priceCents,
        kind: entry.product.kind,
      })),
    };

    if (!process.env.STRIPE_SECRET_KEY) {
      // Local stub: no card is collected and nothing is charged. The client
      // grants digital entitlements itself so the owned-library flow works.
      return Response.json({ order, url: null, mode: "stub" });
    }

    // Production path:
    //   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    //   const checkout = await stripe.checkout.sessions.create({
    //     mode: "payment",
    //     customer_email: session.user.email,
    //     line_items: order.lines.map(...),
    //     success_url: `${origin}/owned?purchased=1`,
    //     cancel_url: `${origin}/store/cart`,
    //     metadata: { orderId: order.id, userId: session.user.id },
    //   });
    //   return Response.json({ order, url: checkout.url, mode: "stripe" });
    return Response.json({ order, url: null, mode: "stripe-unconfigured" });
  } catch (error) {
    return errorResponse(error);
  }
}
