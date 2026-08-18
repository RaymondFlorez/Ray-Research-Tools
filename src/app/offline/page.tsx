import type { Metadata } from "next";
import Link from "next/link";
import { LogoMark, Wordmark } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Offline",
  description: "You are offline. Downloaded content is still available.",
};

export default function OfflinePage() {
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md text-center">
        <LogoMark size={34} className="mx-auto text-accent" />
        <Wordmark className="mt-4 block text-[11px]" />
        <h1 className="mt-8 text-[clamp(1.6rem,4vw,2.1rem)] leading-tight font-medium tracking-[-0.025em] text-ink">
          You&rsquo;re offline.
        </h1>
        <p className="mt-4 text-body leading-relaxed text-ink-2">
          Anything you downloaded is still here — programs, movement videos, and
          audio guides all work with no connection. Sessions and Pulse will
          refresh as soon as you&rsquo;re back.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button href="/owned">Open your library</Button>
          <Button href="/philosophy" variant="secondary">
            Read the philosophy
          </Button>
        </div>
        <p className="mt-8 text-[12px] text-ink-3">
          <Link href="/today" className="hover:text-ink-2">
            Try again
          </Link>
        </p>
      </div>
    </div>
  );
}
