"use client";

import { Eye, Heart, MessageCircle, Repeat2, Share } from "lucide-react";
import { X_TWEET_LIMIT, type XThreadPart } from "@blog/shared";
import { cn } from "cn";
import { ActionRow, Avatar, LinkCard, PreviewFrame, PreviewImage, RichText } from "./parts";
import { domainOf } from "./text";
import type { SocialPreviewModel } from "./types";

const ACTIONS = [{ icon: MessageCircle, label: "" }, { icon: Repeat2, label: "" }, { icon: Heart, label: "" }, { icon: Eye, label: "" }, { icon: Share, label: "" }];

function Header({ model }: { model: SocialPreviewModel }) {
  return (
    <p className="flex items-baseline gap-1 text-sm leading-tight">
      <span className="truncate font-bold">{model.authorName}</span>
      {model.authorHandle ? <span className="truncate text-neutral-500 dark:text-neutral-400">{model.authorHandle}</span> : null}
      <span className="text-neutral-500 dark:text-neutral-400">· hozir</span>
    </p>
  );
}

/** Zanjir: tvitlar ustma-ust, avatarlar orasida bog'lovchi chiziq (X'dagi thread ko'rinishi). Har bir tvitda o'z hisobi. */
function ThreadChain({ model, parts }: { model: SocialPreviewModel; parts: XThreadPart[] }) {
  return (
    <div data-testid="social-x-thread">
      {parts.map((part, i) => {
        const last = i === parts.length - 1;
        return (
          <div key={i} className="flex gap-2.5" data-testid="social-x-thread-part" data-over={part.over ? "" : undefined}>
            <div className="flex flex-col items-center">
              <Avatar name={model.authorName} className="size-10" />
              {!last ? <div className="my-1 w-0.5 flex-1 rounded bg-neutral-300 dark:bg-neutral-600" data-testid="social-x-thread-connector" aria-hidden /> : null}
            </div>
            <div className={cn("min-w-0 flex-1", !last && "pb-3")}>
              <Header model={model} />
              <RichText model={{ ...model, text: part.text, limit: X_TWEET_LIMIT, thread: null }} className="mt-0.5 text-[15px] leading-snug" />
              {i === 0 && model.imageUrl ? (
                <div className="mt-2 overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-700" data-testid="social-x-image">
                  <PreviewImage url={model.imageUrl} className="aspect-video" />
                </div>
              ) : null}
              {last && !model.imageUrl && model.postUrl ? <LinkCard imageUrl={null} title={model.postTitle} domain={domainOf(model.postUrl)} className="mt-2 rounded-2xl" /> : null}
              <div className="mt-1.5 flex items-center justify-between">
                <ActionRow className="justify-between pr-6" items={ACTIONS} />
                <span className={cn("text-[11px] tabular-nums", part.over ? "font-semibold text-destructive" : "text-neutral-500 dark:text-neutral-400")} data-testid="social-x-thread-weight">
                  {i + 1}/{parts.length} · {part.weight}/{X_TWEET_LIMIT}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function XPreviewCard({ model }: { model: SocialPreviewModel }) {
  if (model.thread && model.thread.parts.length > 0) {
    return (
      <PreviewFrame label="X zanjiri" testId="social-preview-x">
        <ThreadChain model={model} parts={model.thread.parts} />
      </PreviewFrame>
    );
  }
  return (
    <PreviewFrame label="X" testId="social-preview-x">
      <div className="flex gap-2.5">
        <Avatar name={model.authorName} className="size-10" />
        <div className="min-w-0 flex-1">
          <Header model={model} />
          <RichText model={model} className="mt-0.5 text-[15px] leading-snug" />
          {model.imageUrl ? (
            <div className="mt-2 overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-700" data-testid="social-x-image">
              <PreviewImage url={model.imageUrl} className="aspect-video" />
            </div>
          ) : (
            <LinkCard imageUrl={null} title={model.postTitle} domain={domainOf(model.postUrl)} className="mt-2 rounded-2xl" />
          )}
          <ActionRow className="mt-2 justify-between pr-6" items={ACTIONS} />
        </div>
      </div>
    </PreviewFrame>
  );
}
