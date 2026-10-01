import { describe, expect, it } from "vitest";
import { CHANNEL_CAPTION_HARD_LIMIT, CHANNEL_TEXT_HARD_LIMIT, CHANNEL_VARIANT_BUDGETS } from "./dto.js";
import { CHANNEL_MEDIA_POLICY, TELEGRAM_ALLOWED_HTML_TAGS, TELEGRAM_LIMITS } from "./telegram-limits.js";

describe("TELEGRAM_LIMITS (verified against core.telegram.org/bots/api, 2026-10-01)", () => {
  it("matches the documented Bot API limits", () => {
    expect(TELEGRAM_LIMITS.photoMaxBytes).toBe(10 * 1024 * 1024);
    expect(TELEGRAM_LIMITS.photoMaxWidthPlusHeight).toBe(10000);
    expect(TELEGRAM_LIMITS.photoMaxAspectRatio).toBe(20);
    expect(TELEGRAM_LIMITS.mediaGroupMinItems).toBe(2);
    expect(TELEGRAM_LIMITS.mediaGroupMaxItems).toBe(10);
    expect(TELEGRAM_LIMITS.captionMaxChars).toBe(1024);
    expect(TELEGRAM_LIMITS.textMaxChars).toBe(4096);
    expect(TELEGRAM_LIMITS.multipartPhotoMaxBytes).toBe(10 * 1024 * 1024);
    expect(TELEGRAM_LIMITS.multipartOtherMaxBytes).toBe(50 * 1024 * 1024);
  });

  it("legacy hard-limit constants derive from it and variant budgets stay below", () => {
    expect(CHANNEL_CAPTION_HARD_LIMIT).toBe(TELEGRAM_LIMITS.captionMaxChars);
    expect(CHANNEL_TEXT_HARD_LIMIT).toBe(TELEGRAM_LIMITS.textMaxChars);
    for (const budget of Object.values(CHANNEL_VARIANT_BUDGETS.media)) expect(budget).toBeLessThanOrEqual(1024);
    for (const budget of Object.values(CHANNEL_VARIANT_BUDGETS.text)) expect(budget).toBeLessThanOrEqual(4096);
  });

  it("exposes the supported HTML tags and our media policy", () => {
    expect([...TELEGRAM_ALLOWED_HTML_TAGS]).toEqual(["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"]);
    expect(CHANNEL_MEDIA_POLICY.maxSidePx).toBe(2560);
    expect(CHANNEL_MEDIA_POLICY.tinySidePx).toBe(320);
    expect(CHANNEL_MEDIA_POLICY.totalWarnBytes).toBe(40 * 1024 * 1024);
  });
});
