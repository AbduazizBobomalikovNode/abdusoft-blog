"use client";

import { Heart, MessageCircle, Repeat2, Send } from "lucide-react";
import { ActionRow, Avatar, LinkCard, PreviewFrame, PreviewImage, RichText } from "./parts";
import { domainOf } from "./text";
import type { SocialPreviewModel } from "./types";

export function ThreadsPreviewCard({ model }: { model: SocialPreviewModel }) {
  const handle = model.authorHandle ?? model.authorName;
  return (
    <PreviewFrame label="Threads" testId="social-preview-threads">
      <div className="flex gap-2.5">
        <Avatar name={model.authorName} className="size-9" />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 text-sm leading-tight">
            <span className="truncate font-semibold">{handle.replace(/^@/, "")}</span>
            <span className="text-neutral-500 dark:text-neutral-400">hozir</span>
          </p>
          <RichText model={model} className="mt-0.5 text-[15px] leading-snug" />
          {model.imageUrl ? (
            <div className="mt-2 overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-700">
              <PreviewImage url={model.imageUrl} className="aspect-[4/3]" />
            </div>
          ) : (
            <LinkCard imageUrl={null} title={model.postTitle} domain={domainOf(model.postUrl)} className="mt-2 rounded-xl" />
          )}
          <ActionRow className="mt-2" items={[{ icon: Heart, label: "" }, { icon: MessageCircle, label: "" }, { icon: Repeat2, label: "" }, { icon: Send, label: "" }]} />
        </div>
      </div>
    </PreviewFrame>
  );
}
