import { describe, expect, it } from "vitest";
import { StrictSocialLinksSchema, safeSocialHref, validateSocialLink } from "./social-links.js";

describe("social link rules (parsed, not prefix-matched)", () => {
  it("accepts https and mailto, and a bare address only for the email field", () => {
    expect(validateSocialLink("https://github.com/x")).toBeNull();
    expect(validateSocialLink("mailto:a@b.uz")).toBeNull();
    expect(validateSocialLink(null)).toBeNull();
    expect(validateSocialLink("a@b.uz", "email")).toBeNull();
    expect(validateSocialLink("a@b.uz", "github")).not.toBeNull();
  });
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "http://example.com",
    "//evil.example",
    "/\\evil.example",
    "https://",
    "https://user:pw@example.com",
    "https://exa mple.com",
    "mailto:not-an-address",
    "vbscript:x",
    "file:///etc/passwd",
  ])("refuses %j", (value) => {
    expect(validateSocialLink(value, "github")).not.toBeNull();
    expect(StrictSocialLinksSchema.partial().safeParse({ github: value }).success).toBe(false);
  });
  it("the strict schema keeps the lenient defaults shape", () => {
    expect(StrictSocialLinksSchema.parse({})).toEqual({ telegram: null, github: null, x: null, email: null });
    expect(StrictSocialLinksSchema.partial().strict().parse({ github: "https://github.com/a" })).toMatchObject({ github: "https://github.com/a" });
  });
  it("safeSocialHref outputs only http(s)/mailto values", () => {
    expect(safeSocialHref("https://t.me/abc")).toBe("https://t.me/abc");
    expect(safeSocialHref("http://old.example/x")).toBe("http://old.example/x");
    expect(safeSocialHref("mailto:a@b.uz")).toBe("mailto:a@b.uz");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "t.me/abc", "ja\tvascript:1", ""]) expect(safeSocialHref(bad), bad).toBeNull();
  });
});
