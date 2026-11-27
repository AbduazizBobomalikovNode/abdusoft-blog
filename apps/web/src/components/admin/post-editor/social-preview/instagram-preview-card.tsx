"use client";

import { Bookmark, Heart, ImageOff, MessageCircle, Send } from "lucide-react";
import { Avatar, PreviewFrame, PreviewImage, RichText } from "./parts";
import { INSTAGRAM_COLLAPSE } from "./text";
import type { SocialPreviewModel } from "./types";

export function InstagramPreviewCard({ model }: { model: SocialPreviewModel }) {
  const handle = (model.authorHandle ?? model.authorName).replace(/^@/, "");
  return (
    <PreviewFrame label="Instagram" testId="social-preview-instagram">
      <div className="-mx-3 -mt-3">
        <div className="flex items-center gap-2 px-3 py-2">
          <Avatar name={model.authorName} className="size-8" />
          <span className="truncate text-sm font-semibold">{handle}</span>
        </div>
        {model.imageUrl ? (
          <PreviewImage url={model.imageUrl} className="aspect-[4/5] max-h-96" />
        ) : (
          <div className="flex aspect-[4/5] max-h-96 flex-col items-center justify-center gap-2 bg-amber-500/10 px-6 text-center text-xs text-amber-700 dark:text-amber-300" data-testid="social-ig-no-image" role="alert">
            <ImageOff className="size-6" aria-hidden />
            Instagram uchun rasm majburiy — rasm tanlang (aks holda yuborib bo&apos;lmaydi).
          </div>
        )}
        <div className="flex items-center justify-between px-3 pt-2 text-neutral-500 dark:text-neutral-400" aria-hidden>
          <span className="flex gap-3"><Heart className="size-5" strokeWidth={1.75} /><MessageCircle className="size-5" strokeWidth={1.75} /><Send className="size-5" strokeWidth={1.75} /></span>
          <Bookmark className="size-5" strokeWidth={1.75} />
        </div>
      </div>
      <div className="mt-2 text-sm leading-snug">
        <span className="font-semibold">{handle}</span>{" "}
        <RichTextInline model={model} />
      </div>
      <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">Havola caption&apos;da bosilmaydi — oddiy matn.</p>
    </PreviewFrame>
  );
}

function RichTextInline({ model }: { model: SocialPreviewModel }) {
  return <RichText model={model} collapse={INSTAGRAM_COLLAPSE} linkUrls={false} className="inline" />;
}
