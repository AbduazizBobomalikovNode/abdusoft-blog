import type { PostMainVideo } from "@blog/shared";

/**
 * Post sahifasida muqova O'RNIDA ko'rsatiladigan asosiy video. Server komponent: `aspect-ratio` videoning o'z
 * o'lchamidan olinadi, shuning uchun yuklanishdan oldin ham quti balandligi tayyor (layout siljimaydi). Avtoplay yo'q;
 * `preload="metadata"` — trafik tejaladi.
 */
export function PostMainVideo({ video, poster, title }: { video: PostMainVideo; poster: string | null; title: string }) {
  return (
    <figure>
      <video
        controls
        preload="metadata"
        playsInline
        poster={poster ?? undefined}
        aria-label={title}
        width={video.width}
        height={video.height}
        className="block h-auto w-full rounded-lg bg-black"
        style={{ aspectRatio: `${video.width} / ${video.height}` }}
      >
        <source src={video.url} type={video.mime} />
      </video>
    </figure>
  );
}
