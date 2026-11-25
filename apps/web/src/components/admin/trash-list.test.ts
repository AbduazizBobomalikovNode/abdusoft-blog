import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrashPostListItem } from "@blog/shared";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { deletedByText, restoreMessage, TrashList } from "./trash-list";

const item = (over: Partial<TrashPostListItem> = {}): TrashPostListItem =>
  ({
    id: "p1",
    slug: "eski-slug",
    title: "O'chirilgan post",
    status: "archived",
    publishedAt: null,
    scheduledAt: null,
    updatedAt: "2026-10-01T10:00:00.000Z",
    pinned: false,
    counts: { views: 0, likes: 0, dislikes: 0, comments: 0 },
    tags: [],
    createdBy: null,
    reviewNote: null,
    hasChannelPlan: false,
    hasChannelChoice: false,
    deletedAt: "2026-10-02T09:30:00.000Z",
    deletedBy: { id: "u1", name: "Aziz" },
    ...over,
  }) as TrashPostListItem;

const render = (items: TrashPostListItem[], isAdmin = true) => renderToStaticMarkup(createElement(TrashList, { items, isAdmin }));

describe("restoreMessage", () => {
  it("is a plain success when the original slug came back", () => {
    expect(restoreMessage({ slugRestored: true, slug: "a", originalSlug: "a" })).toEqual({ kind: "success", text: "Post savatdan tiklandi" });
  });

  it("warns, naming both the taken and the new slug, when it did not", () => {
    const message = restoreMessage({ slugRestored: false, slug: "a-2", originalSlug: "a" });
    expect(message.kind).toBe("warning");
    expect(message.text).toContain("/a");
    expect(message.text).toContain("/a-2");
    expect(message.text).toContain("band");
  });
});

describe("TrashList", () => {
  it("shows title, original slug, previous status, who deleted it, when, and both actions for an admin", () => {
    const html = render([item()]);
    expect(html).toContain("O&#x27;chirilgan post");
    expect(html).toContain("/eski-slug");
    expect(html).toContain("Arxivlangan");
    expect(html).toContain("Aziz");
    expect(html).toContain("Tiklash");
    expect(html).toContain("Butunlay o&#x27;chirish");
  });

  it("does not offer permanent delete when the viewer is not an admin", () => {
    expect(render([item()], false)).not.toContain("Butunlay o&#x27;chirish");
  });

  it("copes with an unknown deleter and an unnamed one", () => {
    expect(deletedByText({ deletedBy: null })).toBe("Noma'lum");
    expect(deletedByText({ deletedBy: { id: "u", name: null } })).toBe("Xodim");
    expect(render([item({ deletedBy: null })])).toContain("Noma&#x27;lum");
  });

  it("renders an empty state for an empty trash", () => {
    const html = render([]);
    expect(html).toContain("Savat bo&#x27;sh");
    expect(html).not.toContain("<table");
  });

  it("keeps very long titles and slugs from breaking the layout (truncate / break classes)", () => {
    const html = render([item({ title: "U".repeat(300), slug: "s".repeat(120) })]);
    expect(html).toContain("truncate");
    expect(html).toContain("break-words");
  });
});
