import { describe, expect, it } from "vitest";
import { wrapTables } from "./wrap-tables";

describe("wrapTables", () => {
  it("wraps a bare table", () => {
    expect(wrapTables("<p>a</p><table><tbody><tr><td>x</td></tr></tbody></table><p>b</p>")).toBe(
      '<p>a</p><div class="table-scroll"><table><tbody><tr><td>x</td></tr></tbody></table></div><p>b</p>',
    );
  });

  it("wraps every table and keeps attributes", () => {
    const out = wrapTables('<table class="a"></table><table></table>');
    expect(out).toBe(
      '<div class="table-scroll"><table class="a"></table></div><div class="table-scroll"><table></table></div>',
    );
  });

  it("is idempotent", () => {
    const once = wrapTables("<table><tr><td>x</td></tr></table>");
    expect(wrapTables(once)).toBe(once);
  });

  it("leaves html without tables untouched", () => {
    expect(wrapTables("<p>hello</p>")).toBe("<p>hello</p>");
  });
});
