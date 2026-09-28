import { describe, expect, it } from "vitest";
import { escapeLike } from "./like";

describe("escapeLike", () => {
  it("escapes %, _ and \\ so they are treated as literal characters in ILIKE", () => {
    expect(escapeLike("50%_off\\deal")).toBe("50\\%\\_off\\\\deal");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLike("salom dunyo")).toBe("salom dunyo");
  });

  it("a search for a literal underscore does not match arbitrary characters once escaped", () => {
    // Without escaping, `_` would match any single character in SQL LIKE/ILIKE.
    expect(escapeLike("a_b")).toBe("a\\_b");
  });
});
