"use client";

import { Globe, MessageSquare, Repeat2, Send, ThumbsUp } from "lucide-react";
import { ActionRow, Avatar, LinkCard, PreviewFrame, PreviewImage, RichText } from "./parts";
import { LINKEDIN_COLLAPSE, domainOf } from "./text";
import type { SocialPreviewModel } from "./types";

export function LinkedInPreviewCard({ model }: { model: SocialPreviewModel }) {
  const article = model.linkMode !== "text";
  return (
    <PreviewFrame label="LinkedIn" testId="social-preview-linkedin">
      <div className="flex items-start gap-2">
        <Avatar name={model.authorName} className="size-12" />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold">{model.authorName}</p>
          {model.authorHandle ? <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{model.authorHandle}</p> : null}
          <p className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">Hozir · <Globe className="size-3" aria-hidden /></p>
        </div>
      </div>
      <RichText model={model} collapse={LINKEDIN_COLLAPSE} className="mt-2 text-sm leading-snug" />
      {article ? (
        <LinkCard imageUrl={model.imageUrl} title={model.postTitle} domain={domainOf(model.postUrl)} className="-mx-3 mt-2 border-x-0" />
      ) : model.imageUrl ? (
        <PreviewImage url={model.imageUrl} className="-mx-3 mt-2 aspect-[1.91/1] w-[calc(100%+1.5rem)] max-w-none" />
      ) : null}
      <div className="mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-700">
        <ActionRow className="justify-between px-2" items={[{ icon: ThumbsUp, label: "Yoqdi" }, { icon: MessageSquare, label: "Izoh" }, { icon: Repeat2, label: "Ulashish" }, { icon: Send, label: "Yuborish" }]} />
      </div>
    </PreviewFrame>
  );
}
