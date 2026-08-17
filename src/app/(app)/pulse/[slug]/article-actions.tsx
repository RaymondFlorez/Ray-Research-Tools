"use client";

import * as React from "react";
import { Bookmark, Check, Share2 } from "lucide-react";
import type { PulseArticle } from "@/types";
import { Button } from "@/components/ui/button";
import { Toast } from "@/components/ui/overlay";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";

export function ArticleActions({ article }: { article: PulseArticle }) {
  const hydrated = useStoreHydrated();
  const saved = useAppStore((s) => s.savedArticles.includes(article.id));
  const toggleSaved = useAppStore((s) => s.toggleSavedArticle);
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const share = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: article.title, url });
        return;
      } catch {
        // Share sheet dismissed — fall through to the clipboard.
      }
    }
    await navigator.clipboard?.writeText(url);
    setToast("Link copied");
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant={hydrated && saved ? "secondary" : "primary"}
        onClick={() => {
          toggleSaved(article.id);
          setToast(saved ? "Removed from saved" : "Saved to read later");
        }}
      >
        {hydrated && saved ? <Check size={15} /> : <Bookmark size={15} />}
        {hydrated && saved ? "Saved" : "Save for later"}
      </Button>
      <Button variant="secondary" onClick={share}>
        <Share2 size={15} />
        Share
      </Button>
      <Toast message={toast} open={Boolean(toast)} />
    </div>
  );
}
