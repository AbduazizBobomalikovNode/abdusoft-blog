"use client";

import { useState } from "react";
import type { PostMainVideo } from "@blog/shared";
import { Clapperboard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/** 58 -> "0:58", 125 -> "2:05". */
export function formatVideoDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Sozlamalar panelidagi "Asosiy video" kartasi: kichik pleyer, davomiylik, "Olib tashlash" va "Video oynasi". */
export function MainVideoCard({
  video,
  fallbackPosterUrl,
  onRemove,
  onOpenVideo,
}: {
  video: PostMainVideo;
  fallbackPosterUrl: string | null;
  onRemove: () => void | Promise<void>;
  onOpenVideo: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const poster = video.posterUrl ?? fallbackPosterUrl ?? undefined;
  return (
    <div className="flex flex-col gap-2" data-editor-field="main-video" data-testid="main-video-card">
      <Label>Asosiy video</Label>
      <video
        key={video.url}
        src={video.url}
        poster={poster}
        controls
        preload="metadata"
        playsInline
        className="w-full rounded-lg bg-black"
        style={{ aspectRatio: `${video.width} / ${video.height}` }}
        data-testid="main-video-player"
      />
      <p className="text-xs text-muted-foreground">Davomiyligi: {formatVideoDuration(video.seconds)}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-md:h-11"
          disabled={removing}
          data-testid="main-video-card-remove"
          onClick={() => {
            setRemoving(true);
            // Qayta-qayta bosilmasin; karta olib tashlansa o'zi yo'qoladi, konfliktda esa tugma qayta ochiladi.
            Promise.resolve(onRemove()).finally(() => setRemoving(false));
          }}
        >
          {removing ? <Loader2 className="size-4 animate-spin" /> : null} Olib tashlash
        </Button>
        <Button type="button" size="sm" variant="ghost" className="max-md:h-11" data-testid="main-video-card-open" onClick={onOpenVideo}>
          <Clapperboard className="size-4" /> Video oynasi
        </Button>
      </div>
    </div>
  );
}
