import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { resolveWebsiteCrawlDefaultsOrThrow } from "../../config/websiteCrawlLimits.js";
import type { CrawlWebsiteInput } from "../../domain/websiteCrawl.js";
import { crawlWebsite } from "./CrawlWebsite.js";

const PAGES: Record<
  string,
  { readonly body: string; readonly contentType: string }
> = {
  "/": {
    body: `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head>
      <body><a href="/about.html">About</a><script src="/app.js"></script></body></html>`,
    contentType: "text/html",
  },
  "/about.html": {
    body: `<!doctype html><html><body><a href="/">Home</a><a href="https://elsewhere.test/x">Elsewhere</a></body></html>`,
    contentType: "text/html",
  },
  "/style.css": {
    body: `body { background: url(/bg.png); }`,
    contentType: "text/css",
  },
  "/app.js": {
    body: `console.log("hi");`,
    contentType: "application/javascript",
  },
  "/bg.png": {
    body: "not-really-a-png",
    contentType: "image/png",
  },
};

const startFixtureServer = async (): Promise<{
  server: Server;
  origin: string;
}> => {
  const server = createServer((request, response) => {
    const page = PAGES[request.url ?? "/"];
    if (page === undefined) {
      response.writeHead(404).end("not found");
      return;
    }
    response
      .writeHead(200, { "content-type": page.contentType })
      .end(page.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture server did not bind to a port");
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
};

describe("crawlWebsite", () => {
  let server: Server;
  let origin: string;
  let outputDirectory: string;

  beforeEach(async () => {
    ({ server, origin } = await startFixtureServer());
    const root = await mkdtemp(join(tmpdir(), "rea-website-crawl-"));
    outputDirectory = join(root, "crawl");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(join(outputDirectory, ".."), { recursive: true, force: true });
  });

  it("fetches every reachable same-origin page/asset and writes a verified manifest", async () => {
    const input: CrawlWebsiteInput = {
      url: origin,
      output_directory: outputDirectory,
      respect_robots_txt: false,
    };
    const defaults = resolveWebsiteCrawlDefaultsOrThrow({});
    const resources = new ArtifactResourceScope();
    try {
      const result = await crawlWebsite(input, defaults, { resources });
      expect(result.origin).toBe(origin);
      expect(result.truncated).toBe(false);
      const paths = result.files.map((file) => file.relative_path).sort();
      expect(paths).toEqual(
        [
          "127.0.0.1_PORT/index.html",
          "127.0.0.1_PORT/about.html",
          "127.0.0.1_PORT/style.css",
          "127.0.0.1_PORT/app.js",
          "127.0.0.1_PORT/bg.png",
        ]
          .map((path) =>
            path.replace("127.0.0.1_PORT", new URL(origin).hostname),
          )
          .sort(),
      );
      expect(
        result.skipped.some((entry) => entry.url.includes("elsewhere.test")),
      ).toBe(true);
      expect(result.analysis_input).toEqual({
        input_path: join(outputDirectory, "files"),
        format: "directory",
      });
      const manifestOnDisk = JSON.parse(
        await readFile(result.manifest.path, "utf8"),
      );
      expect(manifestOnDisk.totals.files_written).toBe(result.files.length);
      for (const file of result.files) {
        const bytes = await readFile(
          join(outputDirectory, "files", file.relative_path),
        );
        expect(bytes.length).toBe(file.bytes);
      }
    } finally {
      await resources.close();
    }
  });

  it("stays within the requested page budget", async () => {
    const input: CrawlWebsiteInput = {
      url: origin,
      output_directory: outputDirectory,
      max_pages: 1,
      respect_robots_txt: false,
    };
    const defaults = resolveWebsiteCrawlDefaultsOrThrow({});
    const resources = new ArtifactResourceScope();
    try {
      const result = await crawlWebsite(input, defaults, { resources });
      expect(result.totals.pages_fetched).toBeLessThanOrEqual(1);
      expect(result.truncated).toBe(true);
    } finally {
      await resources.close();
    }
  });
});
