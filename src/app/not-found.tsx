import Link from "next/link";
import { LogoMark } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md text-center">
        <LogoMark size={32} className="mx-auto text-accent" />
        <p className="eyebrow mt-6">404</p>
        <h1 className="mt-4 text-[clamp(1.6rem,4vw,2.1rem)] leading-tight font-medium tracking-[-0.025em] text-ink">
          Not on the map.
        </h1>
        <p className="mt-4 text-body leading-relaxed text-ink-2">
          That page doesn&rsquo;t exist. The library, your calendar, and the
          philosophy are all still where you left them.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button href="/today">Back to Today</Button>
          <Button href="/library" variant="secondary">
            Movement library
          </Button>
        </div>
        <p className="mt-8 text-[12px] text-ink-3">
          <Link href="/" className="hover:text-ink-2">
            Alpha Movement home
          </Link>
        </p>
      </div>
    </div>
  );
}
