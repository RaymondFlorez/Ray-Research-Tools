import { Container } from "@/components/layout/app-shell";
import { Skeleton, SkeletonCard } from "@/components/ui/primitives";

/**
 * Route-level loading state. Skeletons in dark tones rather than a spinner —
 * the shape of what is arriving, not a promise that something is happening.
 */
export default function Loading() {
  return (
    <Container>
      <div className="border-b border-line pb-7">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-4 h-10 w-2/3 max-w-lg" />
        <Skeleton className="mt-4 h-4 w-full max-w-2xl" />
        <Skeleton className="mt-2 h-4 w-4/5 max-w-xl" />
      </div>
      <div className="grid gap-4 py-8 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </Container>
  );
}
