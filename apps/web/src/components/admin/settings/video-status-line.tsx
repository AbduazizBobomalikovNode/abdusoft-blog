"use client";

import { useEffect, useState } from "react";
import type { MotionStatus } from "@blog/shared";
import { adminApi } from "@/lib/admin-client";

/** Sozlamalarda bir qator: video xizmati yoqilganmi va brauzer o'rnatilganmi. Bayroq o'chiq bo'lsa (server 404) hech narsa ko'rsatilmaydi. */
export function VideoStatusLine() {
  const [status, setStatus] = useState<MotionStatus | null>(null);
  useEffect(() => {
    let alive = true;
    adminApi.getVideoStatus().then(
      (s) => alive && setStatus(s),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!status) return null;
  const ok = status.browser.installed;
  return (
    <p className="rounded-lg border p-3 text-sm" data-testid="video-status-line" role="status">
      <span className="font-medium">Video xizmati: yoqilgan.</span>{" "}
      {ok ? "Brauzer o'rnatilgan." : <span className="text-destructive">Brauzer o&apos;rnatilmagan — egasi scripts/setup-motion-browser.sh ni bir marta ishga tushirishi kerak.</span>}{" "}
      <span className="text-muted-foreground">
        Navbat: {status.queue.running} ishlayapti, {status.queue.queued} kutmoqda. Bugun: {status.quotas.rendersToday}/{status.quotas.maxRendersPerDay || "∞"} video, {status.quotas.previewsToday}/{status.quotas.maxPreviewsPerDay || "∞"} ko&apos;rik.
      </span>
    </p>
  );
}
