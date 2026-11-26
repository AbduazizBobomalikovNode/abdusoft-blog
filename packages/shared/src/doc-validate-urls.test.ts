import { describe, expect, it } from "vitest";
import { isSafeConnectorUrl, validateDocument } from "./doc-validate.js";

const link = (href: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "l", marks: [{ type: "link", attrs: { href } }] }] }] });
const image = (src: string) => ({ type: "doc", content: [{ type: "image", attrs: { src } }] });
const connector = (d: unknown) => validateDocument(d, { mode: "connector", isAllowedImageUrl: () => true });

const BAD = ["//host", "/\\host", "/\t/host", "/\n/host", "/\r/host", "/ /host", "\t//host", "/\u0000/host", "/​/host".replace("​", "\u0085"), "https://exa\tmple.com", "javascript:alert(1)", "java\tscript:alert(1)"];
const GOOD = ["/post-slug", "/a/b?c=d#e", "#section", "https://example.com/x", "http://example.com", "mailto:a@example.com"];

describe("connector URL rule (links and images, one rule)", () => {
  it.each(BAD)("rejects %j", (url) => {
    expect(isSafeConnectorUrl(url)).toBe(false);
    expect(connector(link(url)).ok).toBe(false);
    expect(connector(image(url)).ok).toBe(false);
  });
  it.each(GOOD)("accepts %j as a link", (url) => {
    expect(isSafeConnectorUrl(url)).toBe(true);
    expect(connector(link(url)).ok).toBe(true);
  });
});
