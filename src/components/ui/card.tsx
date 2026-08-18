import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Card — the primary surface. Rounded 14px, hairline #2A2A2E border,
 * soft elevation. `interactive` adds the gentle hover lift the spec calls for.
 */
export function Card({
  className,
  interactive,
  glow,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
  glow?: boolean;
}) {
  return (
    <div
      className={cn(
        "surface-card relative overflow-hidden",
        interactive &&
          "transition-all duration-300 ease-[var(--ease-out-quint)] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-mid",
        glow && "shadow-glow",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pt-5 pb-3", className)} {...props} />;
}

export function CardTitle({
  className,
  as: Tag = "h3",
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: React.ElementType }) {
  return (
    <Tag
      className={cn(
        "text-[17px] leading-snug font-medium tracking-[-0.012em] text-ink",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("mt-1.5 text-small leading-relaxed text-ink-2", className)}
      {...props}
    />
  );
}

export function CardBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

export function CardFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-line px-5 py-3.5",
        className,
      )}
      {...props}
    />
  );
}

/** Section shell used on every page for consistent rhythm. */
export function Section({
  eyebrow,
  title,
  description,
  action,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className={cn("py-10", className)} {...props}>
      {(eyebrow || title || action) && (
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            {eyebrow && <p className="eyebrow mb-2.5">{eyebrow}</p>}
            {title && (
              <h2 className="text-[clamp(1.5rem,3.2vw,2.1rem)] leading-[1.12] font-medium tracking-[-0.02em] text-ink">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-3 text-body leading-relaxed text-ink-2">
                {description}
              </p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
