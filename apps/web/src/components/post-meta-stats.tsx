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
  showViews,
  showComments,
}: {
  slug: string;
  initialViews: number;
  initialComments: number;
  showViews: boolean;
  showComments: boolean;
}) {
  const [views, setViews] = useState(initialViews);
  const [comments, setComments] = useState(initialComments);

  useEffect(() => {
    if (!showViews && !showComments) return;
    let cancelled = false;

    getPostStats(slug)
      .then((stats) => {
        if (cancelled || !stats) return;
        setViews(stats.views);
        setComments(stats.comments);
      })
      .catch(() => {
        // Jim — SSR qiymatlari ko'rsatilishda davom etadi.
      });

    return () => {
      cancelled = true;
    };
  }, [slug, showViews, showComments]);

  return (
    <>
      {showViews ? <span>&middot; {views} ko&apos;rishlar</span> : null}
      {showComments ? <span>&middot; {comments} fikr</span> : null}
    </>
  );
}
