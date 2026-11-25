import { describe, expect, it } from "vitest";
import { CODE_SIZES, estimateLines, fitCode, fitMono, fitRows, fitTitle } from "./fit.ts";
import { createLayout, ENABLED_FORMATS, FORMATS, type FormatId } from "./layout.ts";

describe("layout abstraction", () => {
  it("landscape is 1920x1080 @ 30 fps with unit 1", () => {
    const l = createLayout("landscape");
    expect([l.width, l.height, l.fps, l.unit, l.orientation]).toEqual([1920, 1080, 30, 1, "landscape"]);
    expect(l.sp(1)).toBe(8);
  });

  it("only landscape is enabled for now, the others are defined for later", () => {
    expect(ENABLED_FORMATS).toEqual(["landscape"]);
    expect(Object.keys(FORMATS).sort()).toEqual(["landscape", "square", "vertical"]);
  });

  it.each(Object.keys(FORMATS) as FormatId[])("%s: content sits inside the safe area, which sits inside the frame", (format) => {
    const l = createLayout(format);
    expect(l.safe.x).toBeGreaterThan(0);
    expect(l.safe.y).toBeGreaterThan(0);
    expect(l.safe.x + l.safe.width).toBeLessThan(l.width);
    expect(l.safe.y + l.safe.height).toBeLessThan(l.height);
    expect(l.content.x).toBeGreaterThanOrEqual(l.safe.x);
    expect(l.content.y).toBeGreaterThan(l.header.y + l.header.height - 1);
    expect(l.content.y + l.content.height).toBeLessThanOrEqual(l.safe.y + l.safe.height);
    expect(l.content.width).toBeGreaterThan(0);
    expect(l.content.height).toBeGreaterThan(0);
  });

  it("scales from the short side: vertical and square use 1080 as one unit", () => {
    expect(createLayout("vertical").unit).toBe(1);
    expect(createLayout("square").unit).toBe(1);
    expect(createLayout("vertical").orientation).toBe("portrait");
  });
});

describe("auto-fit helpers", () => {
  it("code size steps down along the scale as lines or columns grow", () => {
    const wide = { width: 1500, height: 700, digits: 2 };
    expect(fitCode({ lineCount: 4, maxChars: 30, ...wide })).toBe(CODE_SIZES[0]);
    expect(fitCode({ lineCount: 14, maxChars: 30, ...wide })).toBeLessThan(CODE_SIZES[0]);
    expect(fitCode({ lineCount: 14, maxChars: 72, ...wide })).toBeLessThanOrEqual(fitCode({ lineCount: 14, maxChars: 30, ...wide }));
    expect(CODE_SIZES as readonly number[]).toContain(fitCode({ lineCount: 14, maxChars: 72, ...wide }));
  });

  it("the largest limits (14 lines x 72 chars) still fit the landscape content box", () => {
    const l = createLayout("landscape");
    const header = 64;
    const footer = 72;
    const size = fitCode({ lineCount: 14, maxChars: 72, digits: 2, width: l.content.width - 64, height: l.content.height - header - footer - 48 - 4 });
    expect(size).toBeGreaterThanOrEqual(22);
    expect(14 * size * 1.6).toBeLessThanOrEqual(l.content.height - header - footer - 48 - 4);
    expect(72 * size * 0.6 + 2 * 24).toBeLessThanOrEqual(l.content.width);
  });

  it("fitMono/fitRows/fitTitle return members of their scales", () => {
    expect(fitMono({ lineCount: 3, maxChars: 10, width: 2000, height: 900 })).toBe(CODE_SIZES[0]);
    const rows = fitRows({ texts: Array(6).fill("x".repeat(80)), width: 1400, height: 500, sizes: [56, 44, 32, 28], lineHeight: 1.25, rowPadding: () => 56 });
    expect([56, 44, 32, 28]).toContain(rows);
    expect(fitTitle(10, 1440)).toBe(120);
    expect(fitTitle(80, 1440)).toBeLessThan(fitTitle(10, 1440));
    expect(estimateLines(100, 40, 1000)).toBeGreaterThan(1);
  });
});
