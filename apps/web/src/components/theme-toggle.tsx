"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  // `resolvedTheme` is undefined until next-themes mounts on the client,
  // which avoids a server/client hydration mismatch without a manual effect.
  if (!resolvedTheme) {
    return <Button variant="ghost" size="icon" aria-label="Mavzuni almashtirish" disabled />;
  }

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Mavzuni almashtirish"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="motion-safe:transition-transform motion-safe:active:scale-90"
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
