import { createHash } from "node:crypto";
import { extname } from "node:path";

/** Normalize a caller-supplied domain or URL into an absolute http(s) URL. */
export const normalizeStartUrl = (raw: string): URL => {
  const trimmed = raw.trim();
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withScheme);
  url.hash = "";
  return url;
};

/** Identity used for the visited set: same URL regardless of fragment. */
export const identityOf = (url: URL): string => {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
};

export const inScope = (
  url: URL,
  start: URL,
  includeSubdomains: boolean,
): boolean => {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname === start.hostname) return true;
  return includeSubdomains && url.hostname.endsWith(`.${start.hostname}`);
};

const HREF_ATTR =
  /<(?:a|link)\b[^>]*?\b(?:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
const SRC_ATTR =
  /<(?:script|img|source|iframe|embed)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
const SRCSET_ATTR = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;

const isIgnorableHref = (value: string): boolean =>
  value.startsWith("#") ||
  /^(?:mailto|tel|javascript|data|blob):/iu.test(value);

/** Extract candidate links from raw HTML text without a DOM parser or script execution. */
export const extractHtmlLinks = (html: string): string[] => {
  const links: string[] = [];
  for (const pattern of [HREF_ATTR, SRC_ATTR]) {
    for (const match of html.matchAll(pattern)) {
      const value = (match[1] ?? match[2] ?? "").trim();
      if (value.length > 0 && !isIgnorableHref(value)) links.push(value);
    }
  }
  for (const match of html.matchAll(SRCSET_ATTR)) {
    const value = match[1] ?? match[2] ?? "";
    for (const candidate of value.split(",")) {
      const url = candidate.trim().split(/\s+/u)[0];
      if (url !== undefined && url.length > 0 && !isIgnorableHref(url))
        links.push(url);
    }
  }
  return links;
};

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]+))\s*\)/giu;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/giu;

/** Extract url()/@import references from raw CSS text. */
export const extractCssLinks = (css: string): string[] => {
  const links: string[] = [];
  for (const pattern of [CSS_URL, CSS_IMPORT]) {
    for (const match of css.matchAll(pattern)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (
        value.length > 0 &&
        !isIgnorableHref(value) &&
        !value.startsWith("data:")
      )
        links.push(value);
    }
  }
  return links;
};

export const decodeText = (buffer: Buffer): string => buffer.toString("utf8");

/** One rule from a robots.txt `User-agent: *` group. */
export interface RobotsRule {
  readonly path: string;
  readonly allow: boolean;
}

/** Parse only the `User-agent: *` group's Allow/Disallow rules. */
export const parseRobotsRules = (text: string): RobotsRule[] => {
  const rules: RobotsRule[] = [];
  let currentAgents: string[] = [];
  let groupClosed = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (groupClosed) {
        currentAgents = [];
        groupClosed = false;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }
    if (key !== "allow" && key !== "disallow") continue;
    groupClosed = true;
    if (!currentAgents.includes("*") || value.length === 0) continue;
    rules.push({ path: value, allow: key === "allow" });
  }
  return rules;
};

export const isDisallowedByRobots = (
  url: URL,
  rules: readonly RobotsRule[],
): boolean => {
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!url.pathname.startsWith(rule.path)) continue;
    if (best === undefined || rule.path.length > best.path.length) best = rule;
  }
  return best !== undefined && !best.allow;
};

export interface FetchedResource {
  readonly status: number;
  readonly finalUrl: string;
  readonly mediaType: string | null;
  readonly body: Buffer;
  readonly bodyTruncated: boolean;
}

export interface FetchCappedOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly outerSignal?: AbortSignal;
}

const readBodyCapped = async (
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> => {
  if (response.body === null)
    return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { bytes: Buffer.alloc(0), truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
};

/** Fetch one URL with a timeout and a byte cap, never throwing for ordinary network failures. */
export const fetchCapped = async (
  url: string,
  { userAgent, timeoutMs, maxBytes, outerSignal }: FetchCappedOptions,
): Promise<FetchedResource | "timeout" | "network-error"> => {
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort);
  const timer = setTimeout(
    () => controller.abort(new Error("timeout")),
    timeoutMs,
  );
  try {
    const response = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    const mediaType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? null;
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return {
        status: response.status,
        finalUrl: response.url || url,
        mediaType,
        body: Buffer.alloc(0),
        bodyTruncated: true,
      };
    }
    const { bytes, truncated } = await readBodyCapped(response, maxBytes);
    return {
      status: response.status,
      finalUrl: response.url || url,
      mediaType,
      body: bytes,
      bodyTruncated: truncated,
    };
  } catch (cause: unknown) {
    if (outerSignal?.aborted === true) throw cause;
    if (controller.signal.aborted) return "timeout";
    return "network-error";
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
};

export const fetchRobotsRules = async (
  origin: string,
  userAgent: string,
  timeoutMs: number,
): Promise<RobotsRule[]> => {
  const fetched = await fetchCapped(`${origin}/robots.txt`, {
    userAgent,
    timeoutMs,
    maxBytes: 1024 * 1024,
  });
  if (fetched === "timeout" || fetched === "network-error") return [];
  if (fetched.status >= 400) return [];
  return parseRobotsRules(decodeText(fetched.body));
};

export const delay = (
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

/** Map a fetched URL to a relative path under the output directory's `files/` root. */
export const relativePathFor = (url: URL, isHtml: boolean): string => {
  let pathname = url.pathname;
  if (pathname === "" || pathname === "/") pathname = "/index.html";
  else if (pathname.endsWith("/")) pathname = `${pathname}index.html`;
  else if (isHtml && extname(pathname) === "")
    pathname = `${pathname}/index.html`;
  let relative = `${url.hostname}${pathname}`.replace(/^\/+/u, "");
  if (url.search.length > 0) {
    const ext = extname(relative);
    const stem = ext.length > 0 ? relative.slice(0, -ext.length) : relative;
    relative = `${stem}__q${shortHash(url.search)}${ext}`;
  }
  return relative;
};

/** Disambiguate a relative path already used by an earlier write in this crawl. */
export const uniquePathFor = (
  relativePath: string,
  url: URL,
  used: Set<string>,
): string => {
  if (!used.has(relativePath)) {
    used.add(relativePath);
    return relativePath;
  }
  const ext = extname(relativePath);
  const stem =
    ext.length > 0 ? relativePath.slice(0, -ext.length) : relativePath;
  const isolated = `${stem}__${shortHash(url.href)}${ext}`;
  used.add(isolated);
  return isolated;
};
