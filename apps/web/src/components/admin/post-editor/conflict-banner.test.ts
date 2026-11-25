import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { conflictSummary } from "@/lib/editor/conflict-text";
import { ConflictBanner } from "./conflict-banner";

const base = { error: "x", updatedAt: "2026-10-01T10:05:00.000Z", updatedBy: { id: "u2", name: "Dilnoza" } as { id: string; name: string | null } | null, via: "mcp" as string | null };
const render = (conflict = base, extra: Partial<Parameters<typeof ConflictBanner>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ConflictBanner, { conflict, meId: "me", onLoadLatest: vi.fn(), onOverwrite: vi.fn(), onOpenHistory: vi.fn(), ...extra }),
  );

describe("conflictSummary", () => {
  it("names who and through what, with a readable source", () => {
    expect(conflictSummary(base, "me")).toEqual({ who: "O'zgartirgan: Dilnoza · Yordamchi ulagich", own: false });
    expect(conflictSummary({ updatedBy: { id: "u2", name: "Dilnoza" }, via: "telegram" }, "me").who).toBe("O'zgartirgan: Dilnoza · Telegram");
  });

  it("says so when the change came from the same user elsewhere (two tabs)", () => {
    const own = conflictSummary({ updatedBy: { id: "me", name: "Men" }, via: "web" }, "me");
    expect(own.own).toBe(true);
    expect(own.who).toContain("boshqa oyna");
    // Xuddi shu foydalanuvchi, lekin yordamchi orqali — o'zi emas, assistent o'zgartirgan.
    expect(conflictSummary({ updatedBy: { id: "me", name: "Men" }, via: "mcp" }, "me").own).toBe(false);
  });

  it("copes with a missing actor, missing source and unknown sources", () => {
    expect(conflictSummary({ updatedBy: null, via: null }, "me").who).toBe("Kim o'zgartirgani noma'lum");
    expect(conflictSummary({ updatedBy: null, via: "scheduler" }, "me").who).toBe("O'zgartirgan: Rejalashtiruvchi");
    expect(conflictSummary({ updatedBy: { id: "u2", name: null }, via: null }, "me").who).toBe("O'zgartirgan: Noma'lum foydalanuvchi");
    expect(conflictSummary({ updatedBy: { id: "u2", name: "Dilnoza" }, via: "yangi" }, "me").who).toBe("O'zgartirgan: Dilnoza · yangi");
  });
});

describe("ConflictBanner", () => {
  it("is a polite live region with the three actions", () => {
    const html = render();
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Bu post boshqa joyda o&#x27;zgartirilgan");
    expect(html).toContain("Dilnoza · Yordamchi ulagich");
    expect(html).toContain("Oxirgi versiyani yuklash");
    expect(html).toContain("Meniki bilan almashtirish");
    expect(html).toContain("Tarixni ochish");
    expect(html).toContain("hech narsa yo&#x27;qolmaydi");
  });

  it("does not offer the history button when it is not allowed, and disables actions while busy", () => {
    const html = render(base, { canOpenHistory: false, busy: true });
    expect(html).not.toContain("Tarixni ochish");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  it("renders for a conflict with no actor and no source", () => {
    const html = render({ ...base, updatedBy: null, via: null });
    expect(html).toContain("Kim o&#x27;zgartirgani noma&#x27;lum");
  });
});
