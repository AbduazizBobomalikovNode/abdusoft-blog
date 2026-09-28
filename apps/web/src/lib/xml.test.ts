import { describe, expect, it } from "vitest";
import { escapeCdata, escapeXml } from "./xml";

describe("escapeXml", () => {
  it("escapes the 5 XML special characters", () => {
    expect(escapeXml(`<a href="x">A & B's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;A &amp; B&apos;s&lt;/a&gt;",
    );
  });
});

describe("escapeCdata", () => {
  it("splits a literal ]]> into the standard two-CDATA-section escape sequence", () => {
    const input = "before ]]> after";
    // Standard XML trick: "]]>" -> "]]" + "]]>" (closes section 1) + "<![CDATA[" (opens section 2) + ">"
    // so that concatenating the two sections' content reconstructs the original "]]>" literally.
    expect(escapeCdata(input)).toBe("before ]]]]><![CDATA[> after");
  });

  it("handles multiple occurrences", () => {
    const input = "a]]>b]]>c";
    expect(escapeCdata(input)).toBe("a]]]]><![CDATA[>b]]]]><![CDATA[>c");
  });

  it("leaves content without ]]> untouched", () => {
    expect(escapeCdata("<p>Salom dunyo</p>")).toBe("<p>Salom dunyo</p>");
  });
});
