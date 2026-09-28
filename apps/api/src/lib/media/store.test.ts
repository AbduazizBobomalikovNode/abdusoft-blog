import { describe, expect, it } from "vitest";
import { processImage } from "./store";

const SVG_MIME = "image/svg+xml";

function svgBuffer(inner: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`, "utf8");
}

describe("processImage — SVG sanitization", () => {
  it("strips <script> tags from uploaded SVGs", async () => {
    const result = await processImage(svgBuffer('<script>alert(1)</script><circle cx="5" cy="5" r="4" />'), SVG_MIME);
    const text = result.buffer.toString("utf8");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("alert(1)");
    expect(text).toContain("<circle");
  });

  it("strips on* event handler attributes", async () => {
    const result = await processImage(svgBuffer('<circle cx="5" cy="5" r="4" onload="alert(1)" onclick="alert(2)" />'), SVG_MIME);
    const text = result.buffer.toString("utf8");
    expect(text).not.toMatch(/on(load|click)\s*=/i);
  });

  it("strips <foreignObject> (can embed arbitrary HTML)", async () => {
    const result = await processImage(svgBuffer('<foreignObject><div>hi</div></foreignObject>'), SVG_MIME);
    const text = result.buffer.toString("utf8");
    expect(text).not.toMatch(/foreignobject/i);
  });

  it("strips href/xlink:href (external reference vector)", async () => {
    const result = await processImage(
      svgBuffer('<a href="https://evil.example"><circle cx="5" cy="5" r="4" /></a>'),
      SVG_MIME,
    );
    const text = result.buffer.toString("utf8");
    expect(text).not.toContain("evil.example");
  });

  it("strips style attributes/tags (CSS injection vector)", async () => {
    const result = await processImage(svgBuffer('<style>*{background:url(evil)}</style><rect style="fill:red" />'), SVG_MIME);
    const text = result.buffer.toString("utf8");
    expect(text).not.toMatch(/<style/i);
    expect(text).not.toMatch(/style\s*=/i);
  });

  it("keeps ordinary safe shapes intact", async () => {
    const result = await processImage(svgBuffer('<rect x="0" y="0" width="10" height="10" fill="#fff" />'), SVG_MIME);
    const text = result.buffer.toString("utf8");
    expect(text).toContain("<rect");
    expect(text).toContain('fill="#fff"');
    expect(result.ext).toBe("svg");
    expect(result.mime).toBe(SVG_MIME);
  });
});
