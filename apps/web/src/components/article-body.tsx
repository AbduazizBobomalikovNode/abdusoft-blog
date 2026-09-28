"use client";

import { useEffect, useRef, useState } from "react";

interface LightboxState {
  src: string;
  alt: string;
}

/**
 * Post HTML'ini render qiladi va mount bo'lgach ikkita minimal JS
 * interaktsiyasini ulaydi: kod bloklari uchun "Nusxalash" tugmasi (+ fayl
 * nomi header'i) va rasmlar uchun <dialog> asosidagi lightbox. HTML API
 * tomonida fixed unified/rehype pipeline orqali generatsiya qilinadi (xom
 * foydalanuvchi HTML'i emas).
 */
export function ArticleBody({ html }: { html: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cleanups: Array<() => void> = [];

    container.querySelectorAll<HTMLPreElement>("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      if (!code) return;

      const wrapper = pre.closest<HTMLElement>(".code-block");
      const filename = wrapper?.dataset.filename ?? "";

      const header = document.createElement("div");
      header.className = "code-block-header";

      const label = document.createElement("span");
      label.className = "code-block-filename";
      label.textContent = filename;
      header.appendChild(label);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-block-copy";
      button.textContent = "Nusxalash";
      // Screen reader'lar tugma matni o'zgarganda ("Nusxalandi") buni e'lon
      // qilishi uchun — fokus holatidan qat'i nazar.
      button.setAttribute("aria-live", "polite");

      function handleCopy() {
        void navigator.clipboard
          .writeText(code?.textContent ?? "")
          .then(() => {
            button.textContent = "Nusxalandi";
            setTimeout(() => {
              button.textContent = "Nusxalash";
            }, 1500);
          })
          .catch(() => {
            button.textContent = "Xatolik";
          });
      }

      button.addEventListener("click", handleCopy);
      cleanups.push(() => button.removeEventListener("click", handleCopy));
      header.appendChild(button);

      pre.insertAdjacentElement("beforebegin", header);
      cleanups.push(() => header.remove());
    });

    function handleImageClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      setLightbox({ src: target.currentSrc || target.src, alt: target.alt });
    }

    container.addEventListener("click", handleImageClick);
    cleanups.push(() => container.removeEventListener("click", handleImageClick));

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [html]);

  useEffect(() => {
    if (lightbox) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [lightbox]);

  return (
    <>
      <div ref={containerRef} className="prose-article" dangerouslySetInnerHTML={{ __html: html }} />
      <dialog
        ref={dialogRef}
        className="lightbox-dialog"
        aria-label={lightbox?.alt || "Kattalashtirilgan rasm"}
        onClose={() => setLightbox(null)}
        onClick={(event) => {
          if (event.target === dialogRef.current) setLightbox(null);
        }}
      >
        {lightbox ? (
          <>
            <button
              type="button"
              className="lightbox-close"
              aria-label="Yopish"
              onClick={() => setLightbox(null)}
            >
              ×
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element -- foydalanuvchi kontenti, domenlari oldindan noma'lum */}
            <img src={lightbox.src} alt={lightbox.alt} />
          </>
        ) : null}
      </dialog>
    </>
  );
}
