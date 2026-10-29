# Website domain crawl

`crawl_website` fetches a live website directly from its domain or URL over
plain HTTP and publishes every reachable same-origin page and asset as
digest-verified local files. Unlike `inspect_web_page`/`capture_browser_scenario`,
it needs no browser and no already-downloaded files: give it a domain, and it
fetches the site itself. Both CLI and MCP use the same workflow.

## Crawl and analyze

```sh
rea crawl-website example.com /analysis/example-com-crawl --json
rea analyze-javascript-application /analysis/example-com-crawl/files --json
```

MCP uses `crawl_website` with `url` and an absolute, absent `output_directory`.
Its inline result includes `analysis_input`, which can be passed directly to
`analyze_javascript_application` once any file was written.

The destination must not exist. Use a new directory for each crawl; an
existing directory or symlink is rejected without overwriting its contents.
REA creates private output, verifies every written file by digest and durable
readback, and removes its own partial output on failure or cancellation.

## How it crawls

Starting from the given URL, REA follows `<a href>`, `<link href>`,
`<script src>`, `<img src>`/`srcset`, `<source src>`, and CSS
`url()`/`@import` references found in fetched HTML and CSS, staying on the
start URL's host (or its subdomains, when selected) and recording every
fetched file's URL, relative path, SHA-256, byte count, HTTP status, and the
URL it was discovered from. A URL skipped for any reason (out of scope,
disallowed by robots.txt, timed out, over budget, non-2xx/3xx) is recorded in
`skipped` with why.

## Settings and per-call limits

Every limit below has a caller-selected input field and a launch-environment
default read once at startup:

| Field                | Setting                                | Default                                                                     |
| -------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `max_pages`          | `REA_WEBSITE_CRAWL_MAX_PAGES`          | 100                                                                         |
| `max_depth`          | `REA_WEBSITE_CRAWL_MAX_DEPTH`          | 4                                                                           |
| `max_concurrency`    | `REA_WEBSITE_CRAWL_MAX_CONCURRENCY`    | 4                                                                           |
| `max_file_bytes`     | `REA_WEBSITE_CRAWL_MAX_FILE_BYTES`     | 20 MiB                                                                      |
| `max_total_bytes`    | `REA_WEBSITE_CRAWL_MAX_TOTAL_BYTES`    | 300 MiB                                                                     |
| `request_timeout_ms` | `REA_WEBSITE_CRAWL_REQUEST_TIMEOUT_MS` | 15000                                                                       |
| `request_delay_ms`   | `REA_WEBSITE_CRAWL_REQUEST_DELAY_MS`   | 0                                                                           |
| `include_subdomains` | `REA_WEBSITE_CRAWL_INCLUDE_SUBDOMAINS` | `false`                                                                     |
| `respect_robots_txt` | `REA_WEBSITE_CRAWL_RESPECT_ROBOTS_TXT` | `true`                                                                      |
| `user_agent`         | `REA_WEBSITE_CRAWL_USER_AGENT`         | `REA-WebsiteCrawler/1.0 (+https://rea.tools; reverse-engineering-anything)` |

A crawl that stops early because of any of these budgets sets `truncated: true`
and lists every reason in `truncation_reasons`.

## Interpretation and limits

This is a static HTTP crawl: no browser renders the page and no fetched
script is active in this process, so content that only appears after
client-side rendering (most single-page-app routes, lazily loaded fragments)
is not discovered. For that, capture the live page with `inspect_web_page` or
`capture_browser_scenario` and export it with `export_web_scripts` instead;
see [captured website scripts](website-script-export.md).

Link discovery does not parse JavaScript source for further links or honor
import maps. robots.txt handling, when enabled, only reads the
`User-agent: *` group's `Allow`/`Disallow` rules; it does not honor
`Crawl-delay` or `Sitemap` directives. Subdomain scoping, when enabled,
compares hostname suffixes and does not consult the public suffix list, so it
can over- or under-include on multi-part public suffixes (e.g. `co.uk`).
Query-string variants of the same path are isolated to distinct files rather
than deduplicated. In the rare case the destination filesystem still refuses a
computed path (case-only collision, unrepresentable name), the whole crawl
fails rather than isolating that one file.

The existing analyzer inventories and parses the actual downloaded files; it
does not implement browser import maps, root-relative URL loading, remote
imports, or runtime behavior.
