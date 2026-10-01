"use client";

import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { ChevronDown, ListTree } from "lucide-react";
import type { OutlineItem } from "@blog/shared";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "./use-media-query";

const COLLAPSE_KEY = "blog:editor:outline-collapsed";

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Joriy bo'lim: ko'rinadigan oynaning yuqori qismiga eng yaqin o'tgan sarlavha. */
function currentHeadingIndex(editor: Editor): number {
  const headings = Array.from(editor.view.dom.querySelectorAll("h2, h3"));
  let current = -1;
  // Sarlavha ekranning yuqori ~35% qismiga kirgach — o'sha bo'lim joriy (hujjat oxiriga yetmaydigan so'nggi bo'lim uchun ham).
  const threshold = Math.max(140, window.innerHeight * 0.35);
  const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
  headings.forEach((h, i) => {
    const top = h.getBoundingClientRect().top;
    // Sahifa oxirida yuqoriga chiqolmaydigan so'nggi sarlavhalar ham ko'rinib tursa — joriy hisoblanadi.
    if (top <= threshold || (atBottom && top < window.innerHeight - 80)) current = i;
  });
  return current;
}

export function OutlinePanel({ editor, items }: { editor: Editor; items: OutlineItem[] }) {
  // Panel faqat muharrir yaratilgach (klientda) chiqadi — localStorage'dan o'qish xavfsiz.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!editor.isDestroyed) setActive(currentHeadingIndex(editor));
      });
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [editor, items]);

  function toggle() {
    setCollapsed((v) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      } catch {
        /* e'tiborsiz */
      }
      return !v;
    });
  }

  function jump(index: number) {
    const el = editor.view.dom.querySelectorAll("h2, h3")[index];
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  return (
    <section className="rounded-xl border border-border bg-card p-3 text-card-foreground" data-testid="outline-panel" aria-label="Mundarija">
      <button type="button" onClick={toggle} aria-expanded={!collapsed} className="flex w-full items-center gap-2 text-left text-sm font-medium">
        <ListTree className="size-4 text-muted-foreground" />
        Mundarija
        <span className="ml-1 text-xs font-normal text-muted-foreground">{items.length}</span>
        <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform motion-reduce:transition-none", collapsed && "-rotate-90")} />
      </button>
      {collapsed ? null : items.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Sarlavha (H2/H3) qo&apos;shsangiz, bu yerda ro&apos;yxat paydo bo&apos;ladi.</p>
      ) : (
        <ol className="mt-2 flex max-h-64 flex-col overflow-y-auto">
          {items.map((item) => (
            <li key={item.index}>
              <button
                type="button"
                onClick={() => jump(item.index)}
                data-active={active === item.index}
                className={cn(
                  "w-full truncate rounded-md px-2 py-1 text-left text-[0.8125rem] text-muted-foreground hover:bg-muted hover:text-foreground",
                  item.level === 3 && "pl-5",
                  active === item.index && "bg-muted font-medium text-foreground",
                )}
              >
                {item.text || <em>(sarlavhasiz)</em>}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
