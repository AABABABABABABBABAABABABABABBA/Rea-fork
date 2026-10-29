import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { Readable } from "node:stream";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  DestinationCaseCollisionFailure,
  DestinationPathUnrepresentableFailure,
} from "../../artifacts/ArtifactPaths.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { outputDirectoryAdmissionRefusal } from "../../artifacts/SafeOutputTreeAdmission.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { WebsiteCrawlDefaults } from "../../config/websiteCrawlLimits.js";
import {
  websiteCrawlManifestSchema,
  websiteCrawlResultSchema,
  type CrawlWebsiteInput,
  type CrawledWebsiteFile,
  type SkippedWebsiteUrl,
  type WebsiteCrawlResult,
} from "../../domain/websiteCrawl.js";
import { WebsiteCrawlError } from "../../domain/websiteCrawlError.js";
import {
  decodeText,
  extractCssLinks,
  extractHtmlLinks,
  fetchCapped,
  fetchRobotsRules,
  identityOf,
  inScope,
  isDisallowedByRobots,
  normalizeStartUrl,
  relativePathFor,
  uniquePathFor,
  type RobotsRule,
  delay,
} from "./CrawlWebsiteFetch.js";

export { normalizeStartUrl } from "./CrawlWebsiteFetch.js";

const OPERATION = "crawl_website";

const LIMITATIONS = [
  "This is a static HTTP crawl: no browser renders the page, so content that only appears after client-side JavaScript execution (most single-page-app routes, lazily loaded fragments) is not discovered.",
  "Link discovery reads <a href>, <link href>, <script src>, <img src>/srcset, <source src>, and CSS url()/@import. It does not parse JavaScript source for further links or honor import maps.",
  "robots.txt handling, when enabled, only reads the User-agent: * group's Allow/Disallow rules; it does not honor Crawl-delay or Sitemap directives.",
  "Subdomain scoping, when enabled, compares hostname suffixes and does not consult the public suffix list; it can over- or under-include on multi-part public suffixes (e.g. co.uk).",
  "Query-string variants of the same path are isolated to distinct files rather than deduplicated.",
  "Relative paths are computed from each URL before writing; in the rare case the destination filesystem still refuses a path (case-only collision, unrepresentable name), the whole crawl fails rather than isolating that one file.",
];

interface QueueItem {
  readonly url: string;
  readonly depth: number;
  readonly discoveredFrom: string | null;
}

interface CrawlLimits {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly maxConcurrency: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly requestTimeoutMs: number;
  readonly requestDelayMs: number;
  readonly includeSubdomains: boolean;
  readonly userAgent: string;
}

/** All mutable state for one crawl, passed by reference instead of closed over. */
interface CrawlContext {
  readonly start: URL;
  readonly tree: SafeOutputTree;
  readonly limits: CrawlLimits;
  readonly robotsRules: readonly RobotsRule[];
  readonly signal: AbortSignal | undefined;
  readonly visited: Set<string>;
  readonly queue: QueueItem[];
  readonly files: CrawledWebsiteFile[];
  readonly skipped: SkippedWebsiteUrl[];
  readonly usedPaths: Set<string>;
  readonly truncationReasons: Set<string>;
  cursor: number;
  pagesFetched: number;
  bytesWritten: number;
  truncated: boolean;
}

const resolveLimits = (
  input: CrawlWebsiteInput,
  defaults: WebsiteCrawlDefaults,
): CrawlLimits => ({
  maxPages: input.max_pages ?? defaults.maxPages.value,
  maxDepth: input.max_depth ?? defaults.maxDepth.value,
  maxConcurrency: input.max_concurrency ?? defaults.maxConcurrency.value,
  maxFileBytes: input.max_file_bytes ?? defaults.maxFileBytes.value,
  maxTotalBytes: input.max_total_bytes ?? defaults.maxTotalBytes.value,
  requestTimeoutMs: input.request_timeout_ms ?? defaults.requestTimeoutMs.value,
  requestDelayMs: input.request_delay_ms ?? defaults.requestDelayMs.value,
  includeSubdomains: input.include_subdomains ?? defaults.includeSubdomains,
  userAgent: input.user_agent ?? defaults.userAgent,
});

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted)
    throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
};

const recordSkip = (
  ctx: CrawlContext,
  item: QueueItem,
  reason: string,
): void => {
  ctx.skipped.push({
    url: item.url,
    reason,
    depth: item.depth,
    discovered_from: item.discoveredFrom,
  });
};

const addTruncation = (ctx: CrawlContext, reason: string): void => {
  ctx.truncated = true;
  ctx.truncationReasons.add(reason);
};

const enqueue = (
  ctx: CrawlContext,
  url: string,
  depth: number,
  discoveredFrom: string,
): void => {
  let parsed: URL;
  try {
    parsed = new URL(url, discoveredFrom);
  } catch {
    return;
  }
  parsed.hash = "";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const key = identityOf(parsed);
  if (ctx.visited.has(key)) return;
  ctx.visited.add(key);
  ctx.queue.push({ url: parsed.href, depth, discoveredFrom });
};

const nextQueueItem = (ctx: CrawlContext): QueueItem | undefined =>
  ctx.cursor >= ctx.queue.length ? undefined : ctx.queue[ctx.cursor++];

/** Scope and robots admission before any network request for this item. */
const admitQueueItem = (ctx: CrawlContext, target: URL): string | undefined => {
  if (!inScope(target, ctx.start, ctx.limits.includeSubdomains))
    return "Outside crawl scope (different host)";
  if (isDisallowedByRobots(target, ctx.robotsRules))
    return "Disallowed by robots.txt";
  return undefined;
};

type FetchOutcome =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "fetched";
      readonly status: number;
      readonly finalUrl: URL;
      readonly mediaType: string | null;
      readonly body: Buffer;
    };

/** Perform the network request and every check that depends on its response. */
const fetchQueueItem = async (
  ctx: CrawlContext,
  target: URL,
): Promise<FetchOutcome> => {
  const fetched = await fetchCapped(target.href, {
    userAgent: ctx.limits.userAgent,
    timeoutMs: ctx.limits.requestTimeoutMs,
    maxBytes: ctx.limits.maxFileBytes,
    ...(ctx.signal === undefined ? {} : { outerSignal: ctx.signal }),
  });
  if (fetched === "timeout")
    return {
      kind: "skip",
      reason: `Request timed out after ${String(ctx.limits.requestTimeoutMs)} ms`,
    };
  if (fetched === "network-error")
    return { kind: "skip", reason: "Network error fetching the resource" };
  let finalUrl: URL;
  try {
    finalUrl = new URL(fetched.finalUrl);
  } catch {
    finalUrl = target;
  }
  if (!inScope(finalUrl, ctx.start, ctx.limits.includeSubdomains))
    return {
      kind: "skip",
      reason: `Redirected outside crawl scope to ${fetched.finalUrl}`,
    };
  if (fetched.status >= 400)
    return { kind: "skip", reason: `HTTP ${String(fetched.status)}` };
  if (fetched.bodyTruncated) {
    addTruncation(
      ctx,
      `At least one response exceeded the ${String(ctx.limits.maxFileBytes)}-byte per-file budget and was skipped: ${fetched.finalUrl}`,
    );
    return {
      kind: "skip",
      reason: `Response exceeds the ${String(ctx.limits.maxFileBytes)}-byte per-file budget`,
    };
  }
  if (ctx.bytesWritten + fetched.body.byteLength > ctx.limits.maxTotalBytes) {
    addTruncation(
      ctx,
      `Stopped after reaching the ${String(ctx.limits.maxTotalBytes)}-byte total budget.`,
    );
    return { kind: "skip", reason: "Would exceed the total byte budget" };
  }
  return {
    kind: "fetched",
    status: fetched.status,
    finalUrl,
    mediaType: fetched.mediaType,
    body: fetched.body,
  };
};

const classifyKind = (
  mediaType: string | null,
  pathname: string,
): CrawledWebsiteFile["kind"] => {
  const extensionGuess = extname(pathname).toLowerCase();
  const isHtml =
    mediaType !== null
      ? mediaType.includes("text/html")
      : extensionGuess === "" ||
        extensionGuess === ".html" ||
        extensionGuess === ".htm";
  if (isHtml) return "page";
  const isCss =
    mediaType !== null
      ? mediaType.includes("text/css")
      : extensionGuess === ".css";
  if (isCss) return "stylesheet";
  if (
    mediaType !== null &&
    (mediaType.includes("javascript") || mediaType.includes("ecmascript"))
  )
    return "script";
  return "other";
};

/** Write one fetched resource, record it, and enqueue the links it carries. */
const recordFetched = async (
  ctx: CrawlContext,
  item: QueueItem,
  outcome: Extract<FetchOutcome, { readonly kind: "fetched" }>,
): Promise<void> => {
  const { status, finalUrl, mediaType, body } = outcome;
  const kind = classifyKind(mediaType, finalUrl.pathname);
  const isHtml = kind === "page";
  const isCss = kind === "stylesheet";
  const relativePath = uniquePathFor(
    relativePathFor(finalUrl, isHtml),
    finalUrl,
    ctx.usedPaths,
  );
  const sha256 = createHash("sha256").update(body).digest("hex");
  await ctx.tree.write(
    `files/${relativePath}`,
    Readable.from([body]),
    { sha256, bytes: body.byteLength },
    ctx.signal,
  );
  ctx.bytesWritten += body.byteLength;
  ctx.files.push({
    url: item.url,
    relative_path: relativePath,
    kind,
    status,
    media_type: mediaType,
    sha256,
    bytes: body.byteLength,
    depth: item.depth,
    discovered_from: item.discoveredFrom,
  });
  if (isHtml) ctx.pagesFetched += 1;
  if (ctx.pagesFetched >= ctx.limits.maxPages) {
    addTruncation(
      ctx,
      `Stopped following links after reaching the ${String(ctx.limits.maxPages)}-page budget.`,
    );
    return;
  }
  if (item.depth >= ctx.limits.maxDepth) {
    if (isHtml)
      addTruncation(
        ctx,
        `Stopped following links past the ${String(ctx.limits.maxDepth)}-hop depth budget.`,
      );
    return;
  }
  if (isHtml) {
    for (const link of extractHtmlLinks(decodeText(body)))
      enqueue(ctx, link, item.depth + 1, finalUrl.href);
  } else if (isCss) {
    for (const link of extractCssLinks(decodeText(body)))
      enqueue(ctx, link, item.depth, finalUrl.href);
  }
};

const processQueueItem = async (
  ctx: CrawlContext,
  item: QueueItem,
): Promise<void> => {
  let target: URL;
  try {
    target = new URL(item.url);
  } catch {
    recordSkip(ctx, item, "Malformed URL");
    return;
  }
  const admissionRefusal = admitQueueItem(ctx, target);
  if (admissionRefusal !== undefined) {
    recordSkip(ctx, item, admissionRefusal);
    return;
  }
  if (ctx.bytesWritten >= ctx.limits.maxTotalBytes) {
    addTruncation(
      ctx,
      `Stopped after reaching the ${String(ctx.limits.maxTotalBytes)}-byte total budget.`,
    );
    return;
  }
  if (ctx.limits.requestDelayMs > 0)
    await delay(ctx.limits.requestDelayMs, ctx.signal);
  assertActive(ctx.signal);
  const outcome = await fetchQueueItem(ctx, target);
  if (outcome.kind === "skip") {
    recordSkip(ctx, item, outcome.reason);
    return;
  }
  await recordFetched(ctx, item, outcome);
};

const worker = async (ctx: CrawlContext): Promise<void> => {
  while (true) {
    assertActive(ctx.signal);
    if (
      ctx.pagesFetched >= ctx.limits.maxPages ||
      ctx.bytesWritten >= ctx.limits.maxTotalBytes
    )
      return;
    const item = nextQueueItem(ctx);
    if (item === undefined) return;
    await processQueueItem(ctx, item);
  }
};

const runCrawl = async (ctx: CrawlContext): Promise<void> => {
  const workerCount = Math.max(1, Math.min(ctx.limits.maxConcurrency, 8));
  await Promise.all(Array.from({ length: workerCount }, () => worker(ctx)));
  if (ctx.cursor < ctx.queue.length)
    addTruncation(
      ctx,
      `Stopped after reaching the ${String(ctx.limits.maxPages)}-page budget with ${String(ctx.queue.length - ctx.cursor)} discovered URL(s) left unfetched.`,
    );
};

const buildResult = async (ctx: CrawlContext): Promise<WebsiteCrawlResult> => {
  const manifest = websiteCrawlManifestSchema.parse({
    start_url: ctx.start.href,
    origin: ctx.start.origin,
    output_directory: ctx.tree.outputRoot,
    analysis_input:
      ctx.files.length > 0
        ? {
            input_path: join(ctx.tree.outputRoot, "files"),
            format: "directory" as const,
          }
        : null,
    files: ctx.files,
    skipped: ctx.skipped,
    totals: {
      pages_fetched: ctx.pagesFetched,
      files_written: ctx.files.length,
      bytes_written: ctx.bytesWritten,
      skipped: ctx.skipped.length,
    },
    truncated: ctx.truncated,
    truncation_reasons: [...ctx.truncationReasons],
    limitations: LIMITATIONS,
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestDigest = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const result = websiteCrawlResultSchema.parse({
    ...manifest,
    manifest: {
      path: join(ctx.tree.outputRoot, "manifest.json"),
      sha256: manifestDigest,
      bytes: manifestBytes.length,
    },
  });
  await ctx.tree.write(
    "manifest.json",
    Readable.from([manifestBytes]),
    { sha256: manifestDigest, bytes: manifestBytes.byteLength },
    ctx.signal,
  );
  return result;
};

const crawlFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Unknown website crawl failure";

interface CrawlFailureContext {
  readonly tree: SafeOutputTree | undefined;
  readonly resources: ArtifactResourceScope;
  readonly result: WebsiteCrawlResult | undefined;
  readonly outputDirectory: string;
}

/** Map a failure from the try block above into the thrown shape callers expect. */
const handleCrawlFailure = async (
  cause: unknown,
  { tree, resources, result, outputDirectory }: CrawlFailureContext,
): Promise<never> => {
  const cancellation =
    cause instanceof AnalysisCancelledError
      ? cause
      : cause instanceof ArtifactReaderFailure &&
          cause.cancellation !== undefined
        ? new AnalysisCancelledError(OPERATION, {
            cause: cause.cancellation.reason,
          })
        : undefined;
  const resolvedTree =
    cause instanceof SafeOutputTreeCreationFailure ? cause.tree : tree;
  if (resolvedTree !== undefined) {
    const cleanup = await resources.release({
      kind: "output-tree",
      resource: resolvedTree.outputRoot,
      tree: resolvedTree,
    });
    if (cleanup.kind === "failed") {
      const diagnostic = resolvedTree.published
        ? `Publication completed, but descriptor cleanup failed (${crawlFailureMessage(cleanup.cause)}). The published output remains available.`
        : `Publication failed (${crawlFailureMessage(cause)}); rollback failed (${crawlFailureMessage(cleanup.cause)}). Remove the residual output directory before retrying.`;
      if (cancellation !== undefined) {
        const cancelled = new AnalysisCancelledError(OPERATION, {
          cause: cancellation.cause,
          cleanup: { reason: diagnostic, resources: [resolvedTree.outputRoot] },
        });
        cleanup.lease.bindCleanupError(cancelled);
        throw cancelled;
      }
      const error = new WebsiteCrawlError(
        cause instanceof ArtifactReaderFailure ? cause.reason : "io",
        resolvedTree.outputRoot,
        diagnostic,
        { cause, residualPaths: [resolvedTree.outputRoot] },
      );
      cleanup.lease.bindCleanupError(error);
      throw error;
    }
    if (resolvedTree.published && result !== undefined)
      throw new WebsiteCrawlPublished(result);
  }
  if (cancellation !== undefined) throw cancellation;
  if (
    cause instanceof DestinationCaseCollisionFailure ||
    cause instanceof DestinationPathUnrepresentableFailure
  )
    throw new WebsiteCrawlError(
      "path",
      outputDirectory,
      crawlFailureMessage(cause),
      { cause },
    );
  throw outputDirectoryAdmissionRefusal(OPERATION, "output_directory", cause);
};

/** Internal signal that cleanup failed after a commit that already succeeded. */
class WebsiteCrawlPublished extends Error {
  constructor(readonly result: WebsiteCrawlResult) {
    super("Website crawl published despite a cleanup-reporting failure");
  }
}

/** Fetch a live website over HTTP and publish every reachable page/asset as verified local files. */
export const crawlWebsite = async (
  input: CrawlWebsiteInput,
  defaults: WebsiteCrawlDefaults,
  options: {
    readonly resources: ArtifactResourceScope;
    readonly signal?: AbortSignal;
  },
): Promise<WebsiteCrawlResult> =>
  options.resources.run(async () => {
    const start = normalizeStartUrl(input.url);
    const limits = resolveLimits(input, defaults);
    const robotsRules =
      (input.respect_robots_txt ?? defaults.respectRobotsTxt)
        ? await fetchRobotsRules(
            start.origin,
            limits.userAgent,
            limits.requestTimeoutMs,
          ).catch(() => [] as RobotsRule[])
        : [];
    let tree: SafeOutputTree | undefined;
    let result: WebsiteCrawlResult | undefined;
    try {
      tree = await SafeOutputTree.create(input.output_directory);
      assertActive(options.signal);
      const ctx: CrawlContext = {
        start,
        tree,
        limits,
        robotsRules,
        signal: options.signal,
        visited: new Set([identityOf(start)]),
        queue: [{ url: start.href, depth: 0, discoveredFrom: null }],
        files: [],
        skipped: [],
        usedPaths: new Set(),
        truncationReasons: new Set(),
        cursor: 0,
        pagesFetched: 0,
        bytesWritten: 0,
        truncated: false,
      };
      await runCrawl(ctx);
      result = await buildResult(ctx);
      assertActive(options.signal);
      await tree.commit(options.signal);
      return result;
    } catch (cause: unknown) {
      try {
        await handleCrawlFailure(cause, {
          tree,
          resources: options.resources,
          result,
          outputDirectory: input.output_directory,
        });
      } catch (resolved: unknown) {
        if (resolved instanceof WebsiteCrawlPublished) return resolved.result;
        throw resolved;
      }
      throw cause;
    }
  });
