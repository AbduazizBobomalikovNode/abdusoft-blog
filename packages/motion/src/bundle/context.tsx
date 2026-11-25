import { createContext, useContext } from "react";
import type { Layout } from "../layout.ts";
import type { Theme } from "../theme/tokens.ts";

export interface Stage {
  layout: Layout;
  theme: Theme;
  siteName: string;
}

const StageContext = createContext<Stage | null>(null);
export const StageProvider = StageContext.Provider;

export function useStage(): Stage {
  const v = useContext(StageContext);
  if (!v) throw new Error("useStage outside StageProvider");
  return v;
}
