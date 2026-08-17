import type { UserProfile, UserRole } from "@/types";
import { CURRENT_USER } from "@/lib/data/people";

/* ============================================================================
   AUTH ABSTRACTION
   Every route handler and server component reads identity through this module.
   The demo build resolves to a fixed athlete; wiring NextAuth (or any other
   provider) means replacing the body of getSession() — nothing above changes.

   Production wiring:
     - NextAuth with the Prisma adapter over the Account/AuthSession models.
     - Credentials + Apple + Google providers.
     - JWT strategy with a 30-day rolling session, refreshed on activity.
   ========================================================================= */

export interface AppSession {
  user: UserProfile;
  expiresAt: string;
}

export async function getSession(): Promise<AppSession | null> {
  return {
    user: CURRENT_USER,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
}

export async function requireSession(): Promise<AppSession> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

/** Role gate for admin routes and coach-only mutations. */
export async function requireRole(...roles: UserRole[]): Promise<AppSession> {
  const session = await requireSession();
  if (!roles.includes(session.user.role)) throw new ForbiddenError();
  return session;
}

export class UnauthorizedError extends Error {
  status = 401;
  constructor() {
    super("Authentication required");
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor() {
    super("Insufficient permissions");
  }
}

/** Uniform JSON error shape for every route handler. */
export function errorResponse(error: unknown) {
  const status =
    error instanceof UnauthorizedError || error instanceof ForbiddenError
      ? error.status
      : 500;
  const message =
    error instanceof Error && status !== 500 ? error.message : "Unexpected error";
  return Response.json({ error: message }, { status });
}
