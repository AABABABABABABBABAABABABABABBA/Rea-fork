import { describe, expect, it } from "vitest";

import {
  extractCssLinks,
  extractHtmlLinks,
  identityOf,
  inScope,
  normalizeStartUrl,
  parseRobotsRules,
  relativePathFor,
  uniquePathFor,
} from "./CrawlWebsiteFetch.js";

describe("normalizeStartUrl", () => {
  it("adds https:// to a bare domain", () => {
    expect(normalizeStartUrl("example.com").href).toBe("https://example.com/");
  });

  it("keeps an explicit scheme and strips a fragment", () => {
    expect(normalizeStartUrl("http://example.com/docs#section").href).toBe(
      "http://example.com/docs",
    );
  });

  it("rejects a value that is not a valid URL once a scheme is assumed", () => {
    expect(() => normalizeStartUrl("not a url")).toThrow();
  });
});

describe("identityOf", () => {
  it("drops the fragment but keeps query and path", () => {
    expect(identityOf(new URL("https://example.com/a?x=1#y"))).toBe(
      "https://example.com/a?x=1",
    );
  });
});

describe("inScope", () => {
  const start = normalizeStartUrl("example.com");

  it("accepts the exact host", () => {
    expect(inScope(new URL("https://example.com/a"), start, false)).toBe(true);
  });

  it("rejects a different host by default", () => {
    expect(inScope(new URL("https://other.test/a"), start, false)).toBe(false);
  });

  it("rejects a subdomain unless include_subdomains is set", () => {
    const sub = new URL("https://docs.example.com/a");
    expect(inScope(sub, start, false)).toBe(false);
    expect(inScope(sub, start, true)).toBe(true);
  });

  it("rejects a sibling domain that merely ends with the same suffix", () => {
    expect(inScope(new URL("https://notexample.com/a"), start, true)).toBe(
      false,
    );
  });

  it("rejects non-http(s) schemes", () => {
    expect(inScope(new URL("ftp://example.com/a"), start, true)).toBe(false);
  });
});

describe("extractHtmlLinks", () => {
  it("collects href, src, and srcset candidates", () => {
    const html = `
      <a href="/one">One</a>
      <link rel="stylesheet" href='/style.css'>
      <script src="/app.js"></script>
      <img src="/pic.png" srcset="/pic-1x.png 1x, /pic-2x.png 2x">
    `;
    expect(extractHtmlLinks(html)).toEqual([
      "/one",
      "/style.css",
      "/app.js",
      "/pic.png",
      "/pic-1x.png",
      "/pic-2x.png",
    ]);
  });

  it("ignores fragment-only, mailto, tel, javascript, and data URLs", () => {
    const html = `
      <a href="#top">Top</a>
      <a href="mailto:a@example.com">Mail</a>
      <a href="tel:+15551234567">Call</a>
      <a href="javascript:void(0)">JS</a>
      <img src="data:image/png;base64,AAAA">
    `;
    expect(extractHtmlLinks(html)).toEqual([]);
  });
});

describe("extractCssLinks", () => {
  it("collects url() and @import references, skipping data URIs", () => {
    const css = `
      @import url("/base.css");
      @import "/other.css";
      .a { background: url(/bg.png); }
      .b { background: url('/bg2.png'); }
      .c { background: url(data:image/png;base64,AAAA); }
    `;
    expect(extractCssLinks(css)).toEqual([
      "/base.css",
      "/bg.png",
      "/bg2.png",
      "/base.css",
      "/other.css",
    ]);
  });
});

describe("parseRobotsRules", () => {
  it("reads only the User-agent: * group", () => {
    const text = [
      "User-agent: Googlebot",
      "Disallow: /private",
      "",
      "User-agent: *",
      "Disallow: /admin",
      "Allow: /admin/public",
    ].join("\n");
    expect(parseRobotsRules(text)).toEqual([
      { path: "/admin", allow: false },
      { path: "/admin/public", allow: true },
    ]);
  });

  it("ignores comments and blank lines, and empty Disallow means allow-all", () => {
    const text = ["# comment", "User-agent: *", "Disallow:", ""].join("\n");
    expect(parseRobotsRules(text)).toEqual([]);
  });
});

describe("relativePathFor", () => {
  it("maps the root path to index.html", () => {
    expect(relativePathFor(new URL("https://example.com/"), true)).toBe(
      "example.com/index.html",
    );
  });

  it("appends index.html for a directory-style path", () => {
    expect(relativePathFor(new URL("https://example.com/docs/"), true)).toBe(
      "example.com/docs/index.html",
    );
  });

  it("isolates a query string by hashing it into the filename", () => {
    const withQuery = relativePathFor(
      new URL("https://example.com/app.js?v=2"),
      false,
    );
    expect(withQuery).toMatch(/^example\.com\/app__q[0-9a-f]{8}\.js$/u);
  });

  it("leaves an ordinary asset path unchanged", () => {
    expect(
      relativePathFor(new URL("https://example.com/static/app.js"), false),
    ).toBe("example.com/static/app.js");
  });
});

describe("uniquePathFor", () => {
  it("returns the original path the first time", () => {
    const used = new Set<string>();
    expect(
      uniquePathFor("a/app.js", new URL("https://example.com/app.js"), used),
    ).toBe("a/app.js");
  });

  it("disambiguates a repeated path with a hash suffix", () => {
    const used = new Set<string>(["a/app.js"]);
    const isolated = uniquePathFor(
      "a/app.js",
      new URL("https://example.com/other/app.js"),
      used,
    );
    expect(isolated).not.toBe("a/app.js");
    expect(isolated).toMatch(/^a\/app__[0-9a-f]{8}\.js$/u);
  });
});
