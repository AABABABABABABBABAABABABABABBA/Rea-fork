import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

/**
 * Launch defaults for `crawl_website`/`rea crawl-website`. A caller may
 * override any of these per call; these settings only fix the default when
 * the call omits that field.
 */
export const WEBSITE_CRAWL_MAX_PAGES_SETTING = "REA_WEBSITE_CRAWL_MAX_PAGES";
export const WEBSITE_CRAWL_MAX_DEPTH_SETTING = "REA_WEBSITE_CRAWL_MAX_DEPTH";
export const WEBSITE_CRAWL_MAX_CONCURRENCY_SETTING =
  "REA_WEBSITE_CRAWL_MAX_CONCURRENCY";
export const WEBSITE_CRAWL_MAX_FILE_BYTES_SETTING =
  "REA_WEBSITE_CRAWL_MAX_FILE_BYTES";
export const WEBSITE_CRAWL_MAX_TOTAL_BYTES_SETTING =
  "REA_WEBSITE_CRAWL_MAX_TOTAL_BYTES";
export const WEBSITE_CRAWL_REQUEST_TIMEOUT_MS_SETTING =
  "REA_WEBSITE_CRAWL_REQUEST_TIMEOUT_MS";
export const WEBSITE_CRAWL_REQUEST_DELAY_MS_SETTING =
  "REA_WEBSITE_CRAWL_REQUEST_DELAY_MS";
export const WEBSITE_CRAWL_USER_AGENT_SETTING = "REA_WEBSITE_CRAWL_USER_AGENT";
export const WEBSITE_CRAWL_INCLUDE_SUBDOMAINS_SETTING =
  "REA_WEBSITE_CRAWL_INCLUDE_SUBDOMAINS";
export const WEBSITE_CRAWL_RESPECT_ROBOTS_TXT_SETTING =
  "REA_WEBSITE_CRAWL_RESPECT_ROBOTS_TXT";

export const DEFAULT_WEBSITE_CRAWL_USER_AGENT =
  "REA-WebsiteCrawler/1.0 (+https://rea.tools; reverse-engineering-anything)";

/** Effective numeric website-crawl default and where its value came from. */
export interface WebsiteCrawlNumericLimit {
  readonly setting: string;
  readonly value: number;
  readonly source: "default" | "setting";
  readonly minimum: number;
  readonly maximum: number;
}

/** Every website-crawl default resolved from one launch environment. */
export interface WebsiteCrawlDefaults {
  readonly maxPages: WebsiteCrawlNumericLimit;
  readonly maxDepth: WebsiteCrawlNumericLimit;
  readonly maxConcurrency: WebsiteCrawlNumericLimit;
  readonly maxFileBytes: WebsiteCrawlNumericLimit;
  readonly maxTotalBytes: WebsiteCrawlNumericLimit;
  readonly requestTimeoutMs: WebsiteCrawlNumericLimit;
  readonly requestDelayMs: WebsiteCrawlNumericLimit;
  readonly userAgent: string;
  readonly includeSubdomains: boolean;
  readonly respectRobotsTxt: boolean;
}

const numeric = (
  setting: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): WebsiteCrawlNumericLimit => ({
  setting,
  value: defaultValue,
  source: "default",
  minimum,
  maximum,
});

const DEFAULT_MAX_PAGES = numeric(
  WEBSITE_CRAWL_MAX_PAGES_SETTING,
  100,
  1,
  1000,
);
const DEFAULT_MAX_DEPTH = numeric(WEBSITE_CRAWL_MAX_DEPTH_SETTING, 4, 0, 12);
const DEFAULT_MAX_CONCURRENCY = numeric(
  WEBSITE_CRAWL_MAX_CONCURRENCY_SETTING,
  4,
  1,
  8,
);
const DEFAULT_MAX_FILE_BYTES = numeric(
  WEBSITE_CRAWL_MAX_FILE_BYTES_SETTING,
  20 * 1024 * 1024,
  1024,
  100 * 1024 * 1024,
);
const DEFAULT_MAX_TOTAL_BYTES = numeric(
  WEBSITE_CRAWL_MAX_TOTAL_BYTES_SETTING,
  300 * 1024 * 1024,
  1024 * 1024,
  2 * 1024 * 1024 * 1024,
);
const DEFAULT_REQUEST_TIMEOUT_MS = numeric(
  WEBSITE_CRAWL_REQUEST_TIMEOUT_MS_SETTING,
  15_000,
  1000,
  120_000,
);
const DEFAULT_REQUEST_DELAY_MS = numeric(
  WEBSITE_CRAWL_REQUEST_DELAY_MS_SETTING,
  0,
  0,
  5000,
);

const constraintFor = (
  definition: WebsiteCrawlNumericLimit,
  unit: string,
): string =>
  `${definition.setting} must be a positive decimal integer from ${String(definition.minimum)} to ${String(definition.maximum)} ${unit}; the default is ${String(definition.value)} ${unit}.`;

const UNITS: Record<string, string> = {
  [WEBSITE_CRAWL_MAX_PAGES_SETTING]: "pages",
  [WEBSITE_CRAWL_MAX_DEPTH_SETTING]: "link hops",
  [WEBSITE_CRAWL_MAX_CONCURRENCY_SETTING]: "concurrent requests",
  [WEBSITE_CRAWL_MAX_FILE_BYTES_SETTING]: "bytes",
  [WEBSITE_CRAWL_MAX_TOTAL_BYTES_SETTING]: "bytes",
  [WEBSITE_CRAWL_REQUEST_TIMEOUT_MS_SETTING]: "ms",
  [WEBSITE_CRAWL_REQUEST_DELAY_MS_SETTING]: "ms",
};

const parseNumeric = (
  definition: WebsiteCrawlNumericLimit,
  value: string | undefined,
): Result<WebsiteCrawlNumericLimit, ConfigurationError> => {
  if (value === undefined) return ok(definition);
  const constraint = constraintFor(definition, UNITS[definition.setting] ?? "");
  const parsed = positiveDecimalIntegerSchema(
    definition.minimum,
    definition.maximum,
    constraint,
  ).safeParse(value);
  return parsed.success
    ? ok({ ...definition, value: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(constraint, {
          settings: [{ setting: definition.setting, constraint }],
        }),
      );
};

const booleanSchema = (setting: string) =>
  z.enum(["true", "false"], {
    error: `${setting} must be "true" or "false".`,
  });

const parseBoolean = (
  setting: string,
  value: string | undefined,
  defaultValue: boolean,
): Result<boolean, ConfigurationError> => {
  if (value === undefined) return ok(defaultValue);
  const parsed = booleanSchema(setting).safeParse(value);
  return parsed.success
    ? ok(parsed.data === "true")
    : err(
        new ConfigurationError(`${setting} must be "true" or "false".`, {
          settings: [
            { setting, constraint: `${setting} must be "true" or "false".` },
          ],
        }),
      );
};

/** Resolve every website-crawl default from one environment. Invalid values are refused. */
export const resolveWebsiteCrawlDefaults = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<WebsiteCrawlDefaults, ConfigurationError> => {
  const maxPages = parseNumeric(
    DEFAULT_MAX_PAGES,
    environment[WEBSITE_CRAWL_MAX_PAGES_SETTING],
  );
  const maxDepth = parseNumeric(
    DEFAULT_MAX_DEPTH,
    environment[WEBSITE_CRAWL_MAX_DEPTH_SETTING],
  );
  const maxConcurrency = parseNumeric(
    DEFAULT_MAX_CONCURRENCY,
    environment[WEBSITE_CRAWL_MAX_CONCURRENCY_SETTING],
  );
  const maxFileBytes = parseNumeric(
    DEFAULT_MAX_FILE_BYTES,
    environment[WEBSITE_CRAWL_MAX_FILE_BYTES_SETTING],
  );
  const maxTotalBytes = parseNumeric(
    DEFAULT_MAX_TOTAL_BYTES,
    environment[WEBSITE_CRAWL_MAX_TOTAL_BYTES_SETTING],
  );
  const requestTimeoutMs = parseNumeric(
    DEFAULT_REQUEST_TIMEOUT_MS,
    environment[WEBSITE_CRAWL_REQUEST_TIMEOUT_MS_SETTING],
  );
  const requestDelayMs = parseNumeric(
    DEFAULT_REQUEST_DELAY_MS,
    environment[WEBSITE_CRAWL_REQUEST_DELAY_MS_SETTING],
  );
  const includeSubdomains = parseBoolean(
    WEBSITE_CRAWL_INCLUDE_SUBDOMAINS_SETTING,
    environment[WEBSITE_CRAWL_INCLUDE_SUBDOMAINS_SETTING],
    false,
  );
  const respectRobotsTxt = parseBoolean(
    WEBSITE_CRAWL_RESPECT_ROBOTS_TXT_SETTING,
    environment[WEBSITE_CRAWL_RESPECT_ROBOTS_TXT_SETTING],
    true,
  );
  const settings = [
    maxPages,
    maxDepth,
    maxConcurrency,
    maxFileBytes,
    maxTotalBytes,
    requestTimeoutMs,
    requestDelayMs,
    includeSubdomains,
    respectRobotsTxt,
  ].flatMap((result) => (result.ok ? [] : result.error.settings));
  if (
    settings.length > 0 ||
    !maxPages.ok ||
    !maxDepth.ok ||
    !maxConcurrency.ok ||
    !maxFileBytes.ok ||
    !maxTotalBytes.ok ||
    !requestTimeoutMs.ok ||
    !requestDelayMs.ok ||
    !includeSubdomains.ok ||
    !respectRobotsTxt.ok
  )
    return err(
      new ConfigurationError("Invalid REA environment configuration", {
        settings,
      }),
    );
  return ok({
    maxPages: maxPages.value,
    maxDepth: maxDepth.value,
    maxConcurrency: maxConcurrency.value,
    maxFileBytes: maxFileBytes.value,
    maxTotalBytes: maxTotalBytes.value,
    requestTimeoutMs: requestTimeoutMs.value,
    requestDelayMs: requestDelayMs.value,
    userAgent:
      environment[WEBSITE_CRAWL_USER_AGENT_SETTING]?.trim() ||
      DEFAULT_WEBSITE_CRAWL_USER_AGENT,
    includeSubdomains: includeSubdomains.value,
    respectRobotsTxt: respectRobotsTxt.value,
  });
};

/** Refuse an invalid default instead of silently falling back. */
export const resolveWebsiteCrawlDefaultsOrThrow = (
  environment: Readonly<Record<string, string | undefined>>,
): WebsiteCrawlDefaults => {
  const resolved = resolveWebsiteCrawlDefaults(environment);
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
};
