"use client";

import { useEffect, useRef } from "react";
import { site } from "@/lib/site";

/**
 * Post sahifasi mount bo'lganda bir marta `POST /posts/:slug/view` yuboradi.
 * Hech narsa render qilmaydi, javobni e'tiborsiz qoldiradi — muvaffaqiyatsiz
 * bo'lsa ham foydalanuvchi tajribasiga ta'sir qilmaydi.
 */
export function ViewBeacon({ slug }: { slug: string }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    fetch(`${site.apiUrl}/posts/${encodeURIComponent(slug)}/view`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
    }).catch(() => {
      // Jim — ko'rish hisoblanmasa ham sahifa ishlashda davom etadi.
    });
  }, [slug]);

  return null;
}
