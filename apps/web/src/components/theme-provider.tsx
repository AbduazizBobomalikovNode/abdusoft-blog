"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme | undefined;
  setTheme: (theme: Theme) => void;
};

const STORAGE_KEY = "theme";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

/**
 * Minimal drop-in replacement for `next-themes`.
 *
 * next-themes 0.4.6 renders its FOUC-prevention `<script>` as a normal React
 * child wherever `<ThemeProvider>` is mounted (inside `<body>`), which under
 * React 19.2 triggers "Encountered a script tag while rendering React
 * component" plus a hydration mismatch, on every page. This provider keeps
 * the same `useTheme()` shape (`theme`, `resolvedTheme`, `setTheme`) so
 * existing consumers (`theme-toggle.tsx`, `ui/sonner.tsx`) don't change, but
 * does no DOM/script work itself — the FOUC-prevention script is rendered
 * once, directly inside `<head>`, by `THEME_INIT_SCRIPT` in the root layout.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme | undefined>(undefined);

  useEffect(() => {
    // localStorage faqat client'da mavjud (SSR'da yo'q) — shu sabab bu
    // qiymatni useState'ning lazy initializer'ida emas, mount effektida
    // o'qiymiz. Faqat mount'da bir marta ishlaydi (dep array bo'sh), cascading
    // re-render xavfi yo'q.
    let stored: Theme = "system";
    try {
      stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
    } catch {
      // ignore (private mode / disabled storage)
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThemeState(stored);
    setResolvedTheme(stored === "system" ? getSystemTheme() : stored);
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolvedTheme(getSystemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    if (resolvedTheme) applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    setResolvedTheme(next === "system" ? getSystemTheme() : next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return { theme: "system", resolvedTheme: undefined, setTheme: () => {} };
  }
  return ctx;
}

/**
 * Inline script string, meant to be rendered inside `<head>` via
 * `dangerouslySetInnerHTML` with `suppressHydrationWarning`. Runs before
 * paint so there's no light-mode flash while React hydrates.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}')||'system';var r=t==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;var d=document.documentElement;if(r==='dark')d.classList.add('dark');d.style.colorScheme=r;}catch(e){}})();`;
