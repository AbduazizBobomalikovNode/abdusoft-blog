import { describe, expect, it } from "vitest";
import { DEFAULT_POST_SETTINGS, PostSettingsSchema } from "./post-settings";

describe("PostSettingsSchema", () => {
  it("fills in every field with its default when parsing an empty object", () => {
    const parsed = PostSettingsSchema.parse({});
    expect(parsed).toEqual(DEFAULT_POST_SETTINGS);
  });

  it("DEFAULT_POST_SETTINGS itself satisfies the schema unchanged", () => {
    expect(PostSettingsSchema.parse(DEFAULT_POST_SETTINGS)).toEqual(DEFAULT_POST_SETTINGS);
  });

  it("overrides only the provided fields, keeping defaults for the rest", () => {
    const parsed = PostSettingsSchema.parse({ commentsEnabled: false, showToc: false });
    expect(parsed).toEqual({
      ...DEFAULT_POST_SETTINGS,
      commentsEnabled: false,
      showToc: false,
    });
  });

  it("mirrors the site-settings.ts merge pattern: spreading a partial DB value over defaults", () => {
    const storedInDb: Record<string, unknown> = { telegraphMirror: false };
    const parsed = PostSettingsSchema.parse({ ...DEFAULT_POST_SETTINGS, ...storedInDb });
    expect(parsed.telegraphMirror).toBe(false);
    expect(parsed.channelAutoPost).toBe(true);
  });

  it("rejects non-boolean values for boolean fields", () => {
    expect(() => PostSettingsSchema.parse({ commentsEnabled: "yes" })).toThrow();
  });
});
