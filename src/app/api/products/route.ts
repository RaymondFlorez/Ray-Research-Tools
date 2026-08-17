import { listProducts } from "@/lib/data/repository";
import { errorResponse, getSession } from "@/lib/auth/session";

/**
 * GET /api/products
 *
 * The storefront is public — no session required. Only APPROVED products are
 * ever returned here; the moderation queue is served from the admin API.
 */
export async function GET() {
  try {
    const session = await getSession();
    const products = await listProducts();

    return Response.json(
      {
        products,
        owned: session ? [] : undefined,
      },
      {
        headers: {
          "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
