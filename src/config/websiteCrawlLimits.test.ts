import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEBSITE_CRAWL_USER_AGENT,
  WEBSITE_CRAWL_INCLUDE_SUBDOMAINS_SETTING,
  WEBSITE_CRAWL_MAX_PAGES_SETTING,
  WEBSITE_CRAWL_RESPECT_ROBOTS_TXT_SETTING,
  resolveWebsiteCrawlDefaults,
} from "./websiteCrawlLimits.js";

describe("resolveWebsiteCrawlDefaults", () => {
  it("resolves every default from an empty environment", () => {
    const resolved = resolveWebsiteCrawlDefaults({});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.maxPages).toEqual({
      setting: WEBSITE_CRAWL_MAX_PAGES_SETTING,
      value: 100,
      source: "default",
      minimum: 1,
      maximum: 1000,
    });
    expect(resolved.value.userAgent).toBe(DEFAULT_WEBSITE_CRAWL_USER_AGENT);
    expect(resolved.value.includeSubdomains).toBe(false);
    expect(resolved.value.respectRobotsTxt).toBe(true);
  });

  it("applies a valid numeric override and records its source", () => {
    const resolved = resolveWebsiteCrawlDefaults({
      [WEBSITE_CRAWL_MAX_PAGES_SETTING]: "25",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.maxPages.value).toBe(25);
    expect(resolved.value.maxPages.source).toBe("setting");
  });

  it("applies boolean overrides", () => {
    const resolved = resolveWebsiteCrawlDefaults({
      [WEBSITE_CRAWL_INCLUDE_SUBDOMAINS_SETTING]: "true",
      [WEBSITE_CRAWL_RESPECT_ROBOTS_TXT_SETTING]: "false",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.includeSubdomains).toBe(true);
    expect(resolved.value.respectRobotsTxt).toBe(false);
  });

  it("refuses a numeric override outside its bounds", () => {
    const resolved = resolveWebsiteCrawlDefaults({
      [WEBSITE_CRAWL_MAX_PAGES_SETTING]: "0",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.settings).toEqual([
      {
        setting: WEBSITE_CRAWL_MAX_PAGES_SETTING,
        constraint: expect.any(String),
      },
    ]);
  });

  it("refuses a malformed boolean override", () => {
    const resolved = resolveWebsiteCrawlDefaults({
      [WEBSITE_CRAWL_INCLUDE_SUBDOMAINS_SETTING]: "yes",
    });
    expect(resolved.ok).toBe(false);
  });

  it("collects every invalid setting in one refusal", () => {
    const resolved = resolveWebsiteCrawlDefaults({
      [WEBSITE_CRAWL_MAX_PAGES_SETTING]: "0",
      [WEBSITE_CRAWL_INCLUDE_SUBDOMAINS_SETTING]: "yes",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.settings.map((issue) => issue.setting)).toEqual([
      WEBSITE_CRAWL_MAX_PAGES_SETTING,
      WEBSITE_CRAWL_INCLUDE_SUBDOMAINS_SETTING,
    ]);
  });
});
