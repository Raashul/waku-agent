import { describe, it, expect } from "vitest";
import { parseArticleKey } from "../src/ingest/parseKey.js";

describe("parseArticleKey", () => {
  it("pulls the ticker from the folder segment after the prefix", () => {
    expect(parseArticleKey("articles/NVDA/article1.md", "articles/")).toEqual({
      ticker: "NVDA",
      name: "article1.md",
    });
  });

  it("uppercases the ticker", () => {
    expect(parseArticleKey("articles/nabil/x.txt", "articles/")?.ticker).toBe("NABIL");
  });

  it("supports nested names under the ticker folder", () => {
    expect(parseArticleKey("articles/UPPER/2026-08-27/earnings.md", "articles/")).toEqual({
      ticker: "UPPER",
      name: "2026-08-27/earnings.md",
    });
  });

  it("rejects keys outside the prefix", () => {
    expect(parseArticleKey("other/NVDA/a.md", "articles/")).toBeNull();
  });

  it("rejects keys with no ticker folder", () => {
    expect(parseArticleKey("articles/loose.md", "articles/")).toBeNull();
  });

  it("rejects non text/markdown extensions", () => {
    expect(parseArticleKey("articles/NVDA/logo.png", "articles/")).toBeNull();
  });

  it("rejects a malformed ticker", () => {
    expect(parseArticleKey("articles/Not A Ticker/a.md", "articles/")).toBeNull();
  });
});
