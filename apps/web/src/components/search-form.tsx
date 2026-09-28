"use client";

import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

/**
 * GET forma orqali /qidiruv?q= sahifasiga yuboradi. Bosh sahifada "/" tugmasi
 * inputga fokus qiladi (matn kiritish maydonida bo'lmasa).
 */
export function SearchForm({ defaultValue = "" }: { defaultValue?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (isTyping) return;

      event.preventDefault();
      inputRef.current?.focus();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <form action="/qidiruv" method="get" role="search" className="flex items-center gap-2">
      <Input
        ref={inputRef}
        type="search"
        name="q"
        placeholder="Qidirish… ( / )"
        defaultValue={defaultValue}
        aria-label="Postlarni qidirish"
        className="font-mono"
      />
    </form>
  );
}
