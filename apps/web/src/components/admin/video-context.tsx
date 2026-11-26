"use client";

import { createContext, useContext } from "react";

/**
 * "Video" yoqilganmi: `/admin/me` javobidagi `videoEnabled` (admin layout bir marta oladi; faqat admin va faqat yoqilganda). Alohida
 * `/admin/video/status` "probe" so'rovi YO'Q. Provider bo'lmasa (yoki bayroq o'chiq) — `false`: hech narsa ko'rsatilmaydi va so'rov ketmaydi.
 */
const VideoEnabledContext = createContext(false);

export const VideoEnabledProvider = VideoEnabledContext.Provider;

export function useVideoEnabled(): boolean {
  return useContext(VideoEnabledContext);
}
