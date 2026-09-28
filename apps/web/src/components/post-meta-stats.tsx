"use client";

import { useEffect, useState } from "react";
import { getPostStats } from "@/lib/api";

/**
 * Post meta qatoridagi ko'rishlar/fikrlar sonini client-side `GET .../stats`
 * orqali yangilaydi. SSR'dan kelgan boshlang'ich qiymatlar darhol ko'rsatiladi
 * (layout siljishi yo'q), so'rov tugagach raqamlar joyida yangilanadi.
 */
export function PostMetaStats({
  slug,
  initialViews,
  initialComments,
  initialTgComments = 0,
  includeTelegram = false,
  showViews,
  showComments,
}: {
  slug: string;
  initialViews: number;
  initialComments: number;
  /** Kanalning muhokama guruhidan olingan izohlar soni. */
  initialTgComments?: number;
  /** `comments.telegramDisplay !== 'admin_only'` bo'lsa — Telegram izohlari ham shu qatorga qo'shiladi. */
  includeTelegram?: boolean;
  showViews: boolean;
  showComments: boolean;
}) {
  const [views, setViews] = useState(initialViews);
  const [comments, setComments] = useState(initialComments);
  const [tgComments, setTgComments] = useState(initialTgComments);

  useEffect(() => {
    if (!showViews && !showComments) return;
    let cancelled = false;

    getPostStats(slug)
      .then((stats) => {
        if (cancelled || !stats) return;
        setViews(stats.views);
        setComments(stats.comments);
        setTgComments(stats.tgComments);
      })
      .catch(() => {
        // Jim — SSR qiymatlari ko'rsatilishda davom etadi.
      });

    return () => {
      cancelled = true;
    };
  }, [slug, showViews, showComments]);

  const totalComments = comments + (includeTelegram ? tgComments : 0);

  return (
    <>
      {showViews ? <span>&middot; {views} ko&apos;rishlar</span> : null}
      {showComments ? <span>&middot; {totalComments} fikr</span> : null}
    </>
  );
}
