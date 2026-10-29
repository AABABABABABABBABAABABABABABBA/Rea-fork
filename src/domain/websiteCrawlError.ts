import { ArtifactOperationError } from "./artifactOperationError.js";
import type { AnalysisErrorOptions } from "./analysisErrorBase.js";

/** Crawl failure retaining its start URL/output target and cleanup state. */
export class WebsiteCrawlError extends ArtifactOperationError {
  override readonly userMessage: string;
  override cleanupIncomplete: boolean;

  constructor(
    reason: ArtifactOperationError["reason"],
    target: string,
    diagnostic: string,
    options: AnalysisErrorOptions & {
      readonly residualPaths?: readonly string[];
    } = {},
  ) {
    super("crawl_website", reason, undefined, undefined, options);
    this.userMessage = `Website crawl failed for ${target}: ${diagnostic}`;
    this.setCleanupResources([
      ...new Set([
        ...(options.cleanup?.resources ?? []),
        ...(options.residualPaths ?? []),
      ]),
    ]);
    this.cleanupIncomplete =
      options.cleanup !== undefined || (options.residualPaths?.length ?? 0) > 0;
  }
}
