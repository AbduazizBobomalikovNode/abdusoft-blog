import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DraftBanner } from "./draft-banner";

describe("DraftBanner", () => {
  const render = (props: Partial<Parameters<typeof DraftBanner>[0]> = {}) =>
    renderToStaticMarkup(createElement(DraftBanner, { serverNewer: false, onRestore: vi.fn(), onDiscard: vi.fn(), ...props }));

  it("lists which fields the restore would bring back", () => {
    const html = render({ fields: ["Matn", "Teglar", "Qisqa tavsif"] });
    expect(html).toContain("Qaytariladi: Matn, Teglar, Qisqa tavsif");
  });

  it("looks exactly as before when no field list is given (old callers)", () => {
    expect(render()).not.toContain("Qaytariladi");
    expect(render({ fields: [] })).not.toContain("Qaytariladi");
  });
});
