import { isAbsolute } from "node:path";

import { z } from "zod";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  crawlWebsite,
  normalizeStartUrl,
} from "../browser/assets/CrawlWebsite.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  crawlWebsiteInputSchema,
  type CrawlWebsiteInput,
} from "../domain/websiteCrawl.js";
import { WebsiteCrawlError } from "../domain/websiteCrawlError.js";
import { WEBSITE_CRAWL_PROVIDER as PROVIDER } from "../domain/investigationProviders.js";
import { resolveWebsiteCrawlDefaults } from "../config/websiteCrawlLimits.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";

const OPERATION = "crawl_website";

/** Crawl one local capture-free website through the shared CLI/MCP application workflow. */
export const crawlWebsiteOperation = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  environment: Readonly<Record<string, string | undefined>>,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const input = crawlWebsiteInputSchema.safeParse(rawInput);
  return input.success
    ? crawlWebsiteValidated(input.data, resources, environment, options)
    : err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput),
      );
};

/** Crawl input already parsed by a named adapter contract. */
export const crawlWebsiteValidated = async (
  input: CrawlWebsiteInput,
  resources: ArtifactResourceScope,
  environment: Readonly<Record<string, string | undefined>>,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (!isAbsolute(input.output_directory))
    return err(
      new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["output_directory"],
          reason: "invalid_format" as const,
          message:
            "output_directory must be an absolute filesystem path on this host.",
        },
      ]),
    );
  try {
    normalizeStartUrl(input.url);
  } catch (cause: unknown) {
    return err(
      new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["url"],
          reason: "invalid_format" as const,
          message: `url must be a website domain or an http(s) URL: ${message(cause)}`,
        },
      ]),
    );
  }
  const defaults = resolveWebsiteCrawlDefaults(environment);
  if (!defaults.ok) return err(defaults.error);
  try {
    if (options.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const result = await crawlWebsite(input, defaults.value, {
      resources,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options.signal?.aborted === true)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    return ok(
      createEvidence(undefined, PROVIDER, {
        predicateType: "rea.website-crawl",
        operation: OPERATION,
        parameters: {
          url: input.url,
          output_directory: input.output_directory,
        },
        result,
        rawResult: null,
        confidence: "derived",
        authority: "historical-reference",
        limitations: result.limitations,
        locations: [{ kind: "artifact-path", path: result.manifest.path }],
        evidenceLinks: [],
      }),
    );
  } catch (cause: unknown) {
    return err(mapCrawlFailure(cause, input));
  }
};

const mapCrawlFailure = (
  cause: unknown,
  input: CrawlWebsiteInput,
): AnalysisError => {
  if (
    cause instanceof AnalysisCancelledError ||
    cause instanceof WebsiteCrawlError
  )
    return cause;
  if (cause instanceof ArtifactReaderFailure) {
    const primary =
      cause.cancellation === undefined
        ? new WebsiteCrawlError(
            cause.reason,
            input.output_directory,
            cause.message,
            { cause, partialObservation: cause.partialObservation },
          )
        : new AnalysisCancelledError(OPERATION, {
            cause: cause.cancellation.reason,
            partialObservation: cause.partialObservation,
          });
    if (cause.cleanup === undefined) return primary;
    return analysisErrorWithCleanupFailure(
      primary,
      new ProviderCleanupError(
        PROVIDER.id,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: OPERATION },
      ),
      OPERATION,
    );
  }
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(OPERATION, cause.message, { cause });
  return new ProviderAdapterError(PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      url: input.url,
      output_directory: input.output_directory,
      error_name: cause instanceof Error ? cause.name : "UnknownError",
      error_message:
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "Unknown website crawl failure",
    },
  });
};

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Unknown error";
