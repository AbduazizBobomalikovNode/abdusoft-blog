"use client";

import { measureSocialText } from "@blog/shared";
import { GitHubReadmePreview } from "./github-readme-preview";
import { InstagramPreviewCard } from "./instagram-preview-card";
import { LinkedInPreviewCard } from "./linkedin-preview-card";
import { ThreadsPreviewCard } from "./threads-preview-card";
import { XPreviewCard } from "./x-preview-card";
import type { SocialPreviewModel } from "./types";

export type { SocialPreviewModel } from "./types";

/** Provayderga mos kartani tanlaydi. Matn mahalliy holatdan keladi — har bir tugma bosilishida qayta chiziladi. */
export function SocialPreview({ model }: { model: SocialPreviewModel }) {
  const over = model.limit !== null && !model.thread ? measureSocialText(model.provider, model.text) - model.limit : 0;
  return (
    <div className="flex flex-col gap-2" data-testid="social-preview">
      {model.provider === "linkedin" ? <LinkedInPreviewCard model={model} /> : null}
      {model.provider === "x" ? <XPreviewCard model={model} /> : null}
      {model.provider === "threads" ? <ThreadsPreviewCard model={model} /> : null}
      {model.provider === "instagram" ? <InstagramPreviewCard model={model} /> : null}
      {model.provider === "github" ? <GitHubReadmePreview block={model.text} /> : null}
      {over > 0 ? (
        <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" data-testid="social-over-notice">
          Chegaradan {over} birlik oshdi — qizil bilan belgilangan qism platformada kesiladi (yuborib bo&apos;lmaydi).
        </p>
      ) : null}
    </div>
  );
}
