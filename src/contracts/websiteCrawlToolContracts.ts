import {
  crawlWebsiteInputSchema,
  websiteCrawlResultSchema,
} from "../domain/websiteCrawl.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** Fetch a live website directly from its domain, without a browser or pre-downloaded files. */
export const WEBSITE_CRAWL_TOOL_CONTRACTS = [
  {
    name: "crawl_website",
    ...toolContractMetadata("crawl_website"),
    description:
      "Crawl a website by domain/URL over plain HTTP, no browser or pre-downloaded files required, and publish every reachable same-origin page and asset as digest-verified local files in an absent output_directory. Follows <a>/<link> href, <script>/<img>/<source> src, srcset, and CSS url()/@import up to caller- or setting-selected page count, link depth, byte, and concurrency budgets (REA_WEBSITE_CRAWL_*). Honors the site's robots.txt User-agent: * rules by default. Returns every fetched file's URL, relative path, SHA-256 and bytes, every skipped URL and why, and an analysis_input for analyze_javascript_application once any file was written. No browser renders the page and no fetched script is active in this process, so content that only appears after client-side rendering is not discovered; see docs/website-domain-crawl.md for complete limitations.",
    kind: "application",
    inputSchema: crawlWebsiteInputSchema,
    outputSchema: evidenceResultOf(websiteCrawlResultSchema),
    examples: [
      {
        title: "Crawl a whole documentation site by domain",
        input: {
          url: "example.com",
          output_directory: "/analysis/example-com-crawl",
        },
      },
      {
        title: "Crawl a specific section with tighter budgets",
        input: {
          url: "https://example.com/docs/",
          output_directory: "/analysis/example-docs-crawl",
          max_pages: 25,
          max_depth: 2,
          include_subdomains: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
