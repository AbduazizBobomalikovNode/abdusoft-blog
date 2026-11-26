"use client";

import { createContext, useContext } from "react";

/**
 * "Tarqatish" yoqilganmi: `/admin/me` javobidagi `distributionEnabled` (admin layout bir marta oladi). Alohida 404 "probe" so'rovlari
 * yo'q. Provider bo'lmasa (yoki bayroq o'chiq) — `false`: hech qanday kirish nuqtasi ko'rsatilmaydi.
 */
const DistributionEnabledContext = createContext(false);

export const DistributionEnabledProvider = DistributionEnabledContext.Provider;

export function useDistributionEnabled(): boolean {
  return useContext(DistributionEnabledContext);
}
