"use client";

import { useEffect, useRef } from "react";

/** Sahifa tepasidagi 2px o'qish progressi chizig'i. Faqat CSS width bilan yangilanadi — animatsiyasiz. */
export function ReadingProgress() {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let ticking = false;

    function update() {
      ticking = false;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      const progress = scrollable > 0 ? Math.min(1, Math.max(0, doc.scrollTop / scrollable)) : 0;
      if (barRef.current) barRef.current.style.width = `${(progress * 100).toFixed(2)}%`;
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="fixed inset-x-0 top-0 z-50 h-[2px]" aria-hidden="true">
      <div ref={barRef} className="h-full w-0 bg-foreground/60" />
    </div>
  );
}
