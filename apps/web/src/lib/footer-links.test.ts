import { describe, expect, it } from "vitest";
import { buildFooterLinks } from "./footer-links";

const none = { telegramUrl: "", githubUrl: "" };

describe("footer links", () => {
  it("renders a link only for http(s)/mailto values; a stored javascript: value becomes plain text", () => {
    const links = buildFooterLinks({ telegram: "https://t.me/abc", github: "javascript:alert(1)" }, none);
    expect(links).toEqual([
      { label: "Telegram", href: "https://t.me/abc", text: "Telegram" },
      { label: "GitHub", href: null, text: "GitHub" },
    ]);
  });
  it("falls back to the env urls and skips empty values", () => {
    expect(buildFooterLinks({ telegram: null, github: null }, { telegramUrl: "https://t.me/env", githubUrl: "" })).toEqual([{ label: "Telegram", href: "https://t.me/env", text: "Telegram" }]);
    expect(buildFooterLinks(undefined, none)).toEqual([]);
  });
});
