"use client";

import { Eye, Heart, MessageCircle, Repeat2, Share } from "lucide-react";
import { ActionRow, Avatar, LinkCard, PreviewFrame, PreviewImage, RichText } from "./parts";
import { domainOf } from "./text";
import type { SocialPreviewModel } from "./types";

export function XPreviewCard({ model }: { model: SocialPreviewModel }) {
  return (
    <PreviewFrame label="X" testId="social-preview-x">
      <div className="flex gap-2.5">
        <Avatar name={model.authorName} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-1 text-sm leading-tight">
            <span className="truncate font-bold">{model.authorName}</span>
            {model.authorHandle ? <span className="truncate text-neutral-500 dark:text-neutral-400">{model.authorHandle}</span> : null}
            <span className="text-neutral-500 dark:text-neutral-400">· hozir</span>
          </p>
          <RichText model={model} className="mt-0.5 text-[15px] leading-snug" />
          {model.imageUrl ? (
            <div className="mt-2 overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-700" data-testid="social-x-image">
              <PreviewImage url={model.imageUrl} className="aspect-video" />
            </div>
          ) : (
            <LinkCard imageUrl={null} title={model.postTitle} domain={domainOf(model.postUrl)} className="mt-2 rounded-2xl" />
          )}
          <ActionRow className="mt-2 justify-between pr-6" items={[{ icon: MessageCircle, label: "" }, { icon: Repeat2, label: "" }, { icon: Heart, label: "" }, { icon: Eye, label: "" }, { icon: Share, label: "" }]} />
        </div>
      </div>
    </PreviewFrame>
  );
}
