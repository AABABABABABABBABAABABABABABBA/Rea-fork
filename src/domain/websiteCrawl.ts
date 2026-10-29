import { z } from "zod";

import { digestSchema } from "./digests.js";
import { localPathStringSchema } from "./localPath.js";

/** Crawl a live website by domain/URL instead of requiring pre-downloaded files. */
export const crawlWebsiteInputSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .describe(
      "Website domain or URL to crawl, e.g. example.com or https://example.com/docs. A bare domain is treated as https://.",
    ),
  output_directory: localPathStringSchema.describe(
    "Absolute absent filesystem directory for downloaded pages/assets and a verified manifest; parent directory must exist",
  ),
  max_pages: z
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Maximum HTML pages to fetch and follow links from. Default from REA_WEBSITE_CRAWL_MAX_PAGES (100).",
    ),
  max_depth: z
    .int()
    .min(0)
    .max(12)
    .optional()
    .describe(
      "Maximum link hops from the start URL. Default from REA_WEBSITE_CRAWL_MAX_DEPTH (4).",
    ),
  max_concurrency: z
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe(
      "Maximum simultaneous requests. Default from REA_WEBSITE_CRAWL_MAX_CONCURRENCY (4).",
    ),
  max_file_bytes: z
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .optional()
    .describe(
      "Maximum bytes retained per downloaded file; larger responses are skipped. Default from REA_WEBSITE_CRAWL_MAX_FILE_BYTES (20 MiB).",
    ),
  max_total_bytes: z
    .int()
    .min(1024 * 1024)
    .max(2 * 1024 * 1024 * 1024)
    .optional()
    .describe(
      "Maximum combined bytes written before the crawl stops early. Default from REA_WEBSITE_CRAWL_MAX_TOTAL_BYTES (300 MiB).",
    ),
  request_timeout_ms: z
    .int()
    .min(1000)
    .max(120_000)
    .optional()
    .describe(
      "Per-request timeout in milliseconds. Default from REA_WEBSITE_CRAWL_REQUEST_TIMEOUT_MS (15000).",
    ),
  request_delay_ms: z
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      "Fixed delay inserted before each request, for politeness. Default from REA_WEBSITE_CRAWL_REQUEST_DELAY_MS (0).",
    ),
  include_subdomains: z
    .boolean()
    .optional()
    .describe(
      "Also follow links on subdomains of the start URL's host. Default from REA_WEBSITE_CRAWL_INCLUDE_SUBDOMAINS (false).",
    ),
  respect_robots_txt: z
    .boolean()
    .optional()
    .describe(
      "Skip paths disallowed for user-agent * in the site's robots.txt. Default from REA_WEBSITE_CRAWL_RESPECT_ROBOTS_TXT (true).",
    ),
  user_agent: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "User-Agent header sent with every request. Default from REA_WEBSITE_CRAWL_USER_AGENT.",
    ),
});
export type CrawlWebsiteInput = z.output<typeof crawlWebsiteInputSchema>;

/** One file written to the output directory, by relative path from its root. */
export const crawledWebsiteFileSchema = z.strictObject({
  url: z.string(),
  relative_path: z.string().min(1),
  kind: z.enum(["page", "stylesheet", "script", "other"]),
  status: z.int(),
  media_type: z.string().nullable(),
  sha256: digestSchema,
  bytes: z.int().min(0),
  depth: z.int().min(0),
  discovered_from: z.string().nullable(),
});
export type CrawledWebsiteFile = z.output<typeof crawledWebsiteFileSchema>;

/** One URL the crawl chose not to fetch or write, and why. */
export const skippedWebsiteUrlSchema = z.strictObject({
  url: z.string(),
  reason: z.string().min(1),
  depth: z.int().min(0),
  discovered_from: z.string().nullable(),
});
export type SkippedWebsiteUrl = z.output<typeof skippedWebsiteUrlSchema>;

/** Verified publication of a static domain crawl, ready for analyze_javascript_application. */
export const websiteCrawlResultSchema = z.strictObject({
  start_url: z.string(),
  origin: z.string(),
  output_directory: z.string().min(1),
  analysis_input: z
    .strictObject({
      input_path: z.string().min(1),
      format: z.literal("directory"),
    })
    .nullable(),
  files: z.array(crawledWebsiteFileSchema),
  skipped: z.array(skippedWebsiteUrlSchema),
  totals: z.strictObject({
    pages_fetched: z.int().min(0),
    files_written: z.int().min(0),
    bytes_written: z.int().min(0),
    skipped: z.int().min(0),
  }),
  truncated: z.boolean(),
  truncation_reasons: z.array(z.string()),
  manifest: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: z.int().min(0),
  }),
  limitations: z.array(z.string()),
});
export type WebsiteCrawlResult = z.output<typeof websiteCrawlResultSchema>;

/** Persisted manifest fields, equal to the result minus its own descriptor. */
export const websiteCrawlManifestSchema = websiteCrawlResultSchema.omit({
  manifest: true,
});
