import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

import { crawlWebsiteOperation } from "../application/WebsiteCrawlService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { deliverEvidenceResult } from "./contractToolHandler.js";

/** Register the static, no-browser website domain crawl. */
export const registerWebsiteCrawlTool = (
  server: EvidenceMcpServer,
  options: {
    readonly logger: Logger;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly artifactResources: ArtifactResourceScope;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
  },
): void => {
  const contract = toolContract("crawl_website");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              crawlWebsiteOperation(
                input,
                options.artifactResources,
                options.environment,
                { signal: context.mcpReq.signal },
              ),
          );
          return deliverEvidenceResult(
            server,
            result,
            contract,
            options.recordEvidence,
          );
        },
      ),
  );
};
