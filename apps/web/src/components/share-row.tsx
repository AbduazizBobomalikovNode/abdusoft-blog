"use client";

import { Link2, Send, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface ShareRowProps {
  url: string;
  title: string;
  telegraphUrl?: string | null;
}

/** Telegram, X va nusxalash — post pastidagi ulashish qatori. */
export function ShareRow({ url, title, telegraphUrl }: ShareRowProps) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Havola nusxalandi");
    } catch {
      toast.error("Nusxalab bo'lmadi");
    }
  }

  // Telegraph nusxa mavjud bo'lsa, Telegram'da ulashish o'sha havolani ishlatadi (in-app o'qish uchun qulayroq).
  const shareUrl = telegraphUrl ?? url;
  const telegramHref = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(title)}`;
  const xHref = `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-muted-foreground">Ulashish:</span>
      <Button asChild variant="outline" size="sm">
        <a href={telegramHref} target="_blank" rel="noopener noreferrer">
          <Send /> Telegram
        </a>
      </Button>
      <Button asChild variant="outline" size="sm">
        <a href={xHref} target="_blank" rel="noopener noreferrer">
          X
        </a>
      </Button>
      {telegraphUrl ? (
        <Button asChild variant="outline" size="sm">
          <a href={telegraphUrl} target="_blank" rel="noopener noreferrer">
            <Zap /> Telegramda o&apos;qish
          </a>
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={handleCopy}>
        <Link2 /> Nusxalash
      </Button>
    </div>
  );
}
