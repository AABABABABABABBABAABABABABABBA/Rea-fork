import { Cli, z } from "incur";

import { crawlWebsiteOperation } from "../application/WebsiteCrawlService.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "pino";
import { withCommandCancellation } from "./commandCancellation.js";

/** Register the static, no-browser website domain crawl CLI workflow. */
export const registerWebsiteCrawlCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.crawlWebsite, {
    description:
      "Crawl a website by domain/URL over plain HTTP and publish its reachable pages/assets into an absent directory for static JavaScript analysis",
    args: z.object({
      url: z
        .string()
        .describe("Website domain or URL to crawl, e.g. example.com"),
      outputDirectory: z
        .string()
        .describe(
          "Absolute absent directory for downloaded files and manifest",
        ),
      maxPages: z.coerce
        .number()
        .int()
        .optional()
        .describe("Maximum HTML pages to fetch"),
      maxDepth: z.coerce
        .number()
        .int()
        .optional()
        .describe("Maximum link hops from the start URL"),
      maxConcurrency: z.coerce
        .number()
        .int()
        .optional()
        .describe("Maximum simultaneous requests"),
      maxFileBytes: z.coerce
        .number()
        .int()
        .optional()
        .describe("Maximum bytes retained per file"),
      maxTotalBytes: z.coerce
        .number()
        .int()
        .optional()
        .describe("Maximum combined bytes written"),
      requestTimeoutMs: z.coerce
        .number()
        .int()
        .optional()
        .describe("Per-request timeout in milliseconds"),
      requestDelayMs: z.coerce
        .number()
        .int()
        .optional()
        .describe("Fixed delay before each request"),
      includeSubdomains: z.coerce
        .boolean()
        .optional()
        .describe("Also follow links on subdomains"),
      respectRobotsTxt: z.coerce
        .boolean()
        .optional()
        .describe("Skip paths disallowed by robots.txt"),
      userAgent: z
        .string()
        .optional()
        .describe("User-Agent header sent with every request"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.crawlWebsite, async () => {
          const resources = new ArtifactResourceScope();
          try {
            const result = await crawlWebsiteOperation(
              {
                url: args.url,
                output_directory: args.outputDirectory,
                ...(args.maxPages === undefined
                  ? {}
                  : { max_pages: args.maxPages }),
                ...(args.maxDepth === undefined
                  ? {}
                  : { max_depth: args.maxDepth }),
                ...(args.maxConcurrency === undefined
                  ? {}
                  : { max_concurrency: args.maxConcurrency }),
                ...(args.maxFileBytes === undefined
                  ? {}
                  : { max_file_bytes: args.maxFileBytes }),
                ...(args.maxTotalBytes === undefined
                  ? {}
                  : { max_total_bytes: args.maxTotalBytes }),
                ...(args.requestTimeoutMs === undefined
                  ? {}
                  : { request_timeout_ms: args.requestTimeoutMs }),
                ...(args.requestDelayMs === undefined
                  ? {}
                  : { request_delay_ms: args.requestDelayMs }),
                ...(args.includeSubdomains === undefined
                  ? {}
                  : { include_subdomains: args.includeSubdomains }),
                ...(args.respectRobotsTxt === undefined
                  ? {}
                  : { respect_robots_txt: args.respectRobotsTxt }),
                ...(args.userAgent === undefined
                  ? {}
                  : { user_agent: args.userAgent }),
              },
              resources,
              environment,
              { signal },
            );
            return result.ok
              ? result.value
              : ({
                  error: "Website crawl failed",
                  ...projectAnalysisError(result.error),
                } as JsonValue);
          } finally {
            await resources.close();
          }
        }),
      ),
  });
};
