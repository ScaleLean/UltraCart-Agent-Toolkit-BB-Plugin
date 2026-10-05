# UltraCart Agent Toolkit BB Plugin

A native BB Storefront plugin. It adds **Storefront** to navigation and **Storefront workspace** to an existing thread's panel actions.

## Current slices

1. Capability explorer: intent search, category filters, source references, command examples, and a local planning brief.
2. Storefront connection: official toolkit device login, existing profile selection, storefront discovery, verified selection, and disconnect.
3. Live workspace: searchable catalog pages, branch navigation, page metadata, shared-template impact, resolved template files, and live-page browser links.
4. Agent handoff: BB's native new-chat composer and embedded conversation, with scoped discovery and local draft tools.
5. Draft and review: pull existing page containers, edit existing string configuration fields, save locally, compare baseline changes, validate, and detect remote changes.
6. Data warehouse: discover tables and fields, prepare bounded SQL, review scan estimates, and explicitly execute a query.
7. Page traffic: a searchable page hierarchy with distinct sessions per page for the last 30 completed UTC days, including zero-session pages.
8. Heatmaps: page-scoped click and movement intensity, scroll quartiles, and selector-to-widget lookup.

The connection runs on the **BB server machine** using an explicitly configured Node executable and toolkit CLI entry. Remote BB execution machines are not supported by this slice. The UI names the execution machine. Draft editing stays local to BB. Publishing is not implemented.

## Login

Open Storefront, choose **Connect storefront**, name a profile, and select **Sign in with UltraCart**. Open the UltraCart authorization link and complete the browser flow yourself. Keep the panel open; leaving it cancels an in-progress request.

After sign-in, available storefronts load automatically. Choose **Use storefront**. Existing profiles can use **Load storefronts** without signing in again. Store selection is checked against a fresh storefront list and merchant identity before saving. The workspace then reads the catalog, verifying access again.

The toolkit owns OAuth and native credential storage. For the connection, BB stores the selected profile, merchant, storefront metadata, and verification time. Local drafts also store pulled container content and baselines in the plugin database. Device URLs and codes exist only in memory while waiting. The wrapper never handles access/refresh tokens. Successful toolkit login changes its global current profile; this plugin always passes an explicit profile for remote reads.

**Disconnect storefront** clears BB's selection only. It does not revoke or delete the shared toolkit profile or its OS keychain login. Existing conversations retain their pinned context and tools. Logout is not implemented in this slice.

## Working with a page

Open **Storefront → Workspace**. The initial branch shows the home page and its direct children. Search matches all page paths, titles, and reported template names. Branch buttons navigate the catalog hierarchy. Lists render 60 results at a time.

Selecting a page fetches fresh settings. **Resolve template files** asks UltraCart which files actually render, including shadowed copies. The shared-template count comes from the catalog snapshot. **Open live page** uses BB's configured browser preference. It opens the published page, not a staged preview.

Choose **Understand this page**, **Find improvements**, or **Plan a change** to open BB's native composer. Select a provider and environment, edit the draft, then send. The first message includes fresh, verified merchant/store/page context. The new conversation is also available in BB's sidebar. Its target stays fixed when the panel selection changes.

The agent receives `storefront_list_pages`, `storefront_read_page`, and `storefront_resolve_template`, plus `storefront_read_draft`, `storefront_pull_draft`, `storefront_save_draft`, and `storefront_review_draft`. Draft tools always use the conversation’s pinned page. Open Draft & review and select Reload saved draft to see agent edits. These run on the BB server. They do not require the toolkit to be installed on the agent's execution machine. Agent authentication remains separate from UltraCart authentication. The provider list is not an authentication check.

Catalog reads are bounded to 4 MiB and 10,000 records. Duplicate paths appear once with a warning and uncertain settings; selecting one reads the page directly. Missing visibility remains unknown. Read requests queue across BB windows, with a maximum of 12 outstanding commands. There are no automatic retries after an UltraCart error or rate limit.

## Draft and review

Choose a page, then **Draft & review**. Pull an existing container slot, normally `body`. The plugin retains the original CJSON and toolkit baseline in BB's plugin SQLite database. Editing supports existing string configuration fields, including translated and responsive values. Widget IDs and structure remain intact. Limits are 512 KiB per container, 100 fields, and 16 KiB per field.

**Save and review** saves locally, validates with the toolkit, and pulls the current remote content to compare hashes. A valid local result is not proof of rendering or future publish readiness. Publishing and remote preview staging are not implemented. Revision checks prevent an older window or agent from overwriting a newer draft. Save before switching pages or tabs; unsaved editor values are not persistent. Existing saved drafts reopen automatically. Remote-change reconciliation and replacing a saved baseline are not yet implemented.

## Warehouse and heatmaps

**Data warehouse** operates on the merchant warehouse. Selecting a storefront does not automatically filter arbitrary SQL to that storefront. The BB server needs Google Cloud SDK `bq`, Google sign-in, and access to both warehouse datasets. UltraCart OAuth is separate. **Check setup** dry-runs a metadata query. Table and field discovery require explicit query execution after a dry run.

Queries accept one SELECT/WITH statement without comments or semicolons. Output is limited to 100 rows; local `bq` settings can truncate it further. The scan ceiling defaults to 1 GiB and can be set up to 20 GiB. A reviewed query ticket expires in five minutes and can be used once. The last 50 warehouse audit events store query hashes and receipt metadata, without SQL or rows. Private temporary CLI audit files are removed after each request.

The page's **Heatmaps** panel reads existing aggregated warehouse data for its exact host and normalized path, device, and up to 31 UTC calendar days. It shows top elements by clicks, pointer movement counts, and scroll quartiles. The query includes partition and event-date filters. Preview is a dry run; execution is explicit and capped at 1 GiB. Heatmap rows do not represent unique visitors. Spatial overlays and recording enablement are not implemented. Historical selectors can differ from the current theme.

Warehouse calls have a 120-second local timeout. A timeout does not prove the remote job stopped; check BigQuery before retrying. No automatic retries occur.

## Page traffic

**Workspace → Page traffic** joins current warehouse page records to distinct analytics sessions. It uses page IDs and parent page IDs for hierarchy, with search that keeps ancestors visible, expandable branches, sibling traffic sorting, and a zero-session filter. Missing parents or cycles remain visible as roots with a warning.

The reporting window is the last 30 completed UTC days, filtered by session start date. Each count represents distinct sessions that viewed that page. Repeated views count once; sessions across several pages can count in several rows. Parent counts describe the parent page itself, not branch totals. The separate host total is computed from distinct session IDs.

The query restricts page records to the selected storefront ID and page-view URLs to its exact host. It excludes sessions flagged as bots. URLs are matched after query strings, fragments, `index.html`, and trailing slashes are normalized; path case remains significant. Aliases are excluded. Multiple catalog records for one normalized path share its count and are labeled. Recorded paths absent from the current catalog are reported separately. No visitor identifiers are returned.

Load or Refresh checks the estimate and runs the fixed query under a 1 GiB ceiling. All pages are returned in one array to avoid the toolkit's 100-row display limit. Results exceeding 10,000 pages or returning incomplete data are rejected. The latest successful snapshot is stored in BB's plugin database for each profile/merchant/storefront/host. Opening the section reads this cache without running a query. Failed refreshes keep the previous snapshot and show the error. A zero count is not proof of complete tracking coverage.

Live schema fields were verified. The first live traffic pull was blocked by Google reauthentication, so real traffic totals remain unverified. Fixture tests cover hierarchy, date boundaries, session parsing, cache persistence, concurrent refreshes, and stale scope rejection.

## Local development

Requires BB 0.45 or later. Verified with BB 0.45.0 / Plugin SDK 0.6.15.

```sh
npm --prefix bb-plugin-storefront install
npm run check
npm run test
npm run build
npm run install:bb
```

BB must be running for installation. The helper uses the macOS BB app's bundled CLI when available; otherwise it uses `bb` on PATH. Set `BB_CLI_PATH` to another CLI JavaScript entry if necessary. After edits, build and run `npm run reload:bb`. Reloading cancels any active login.

## Toolkit runtime

The development runtime is isolated in the ignored `.toolkit` directory. Installed versions: Node 24.21.0 and UltraCart toolkit 0.1.0-preview.11. The official private release asset was verified against GitHub's SHA-256 digest:

`6f487a1e577d245facdd9891ce95539a997b409f9faea0af128423a3ae5703e4`

To recreate it, download the `ultracart-storefront-agent-toolchain-0.1.0-preview.11.tgz` asset from the authorized [release](https://github.com/UltraCart/storefront-agent-toolchain/releases/tag/v0.1.0-preview.11), verify the digest, then install it and `node@24.21.0` into `.toolkit` with npm. Repository access is required. Do not commit the private release tarball.

Configure these Storefront plugin settings with absolute paths on the BB server:

- `nodePath`: `.toolkit/node_modules/node/bin/node`
- `cliPath`: `.toolkit/node_modules/@ultracart/storefront-agent-toolchain/dist/bin.js`

The feature checks the executable at runtime and reports missing setup. It does not auto-install or auto-update toolkits. Commands are passed as argument arrays with no shell. Requests are bounded, serialized, and cleaned up on plugin disposal. Login expires locally after ten minutes if not completed.

## Evidence and limits

Capability descriptions are curated from the private [UltraCart storefront-agent-toolchain](https://github.com/UltraCart/storefront-agent-toolchain), reviewed October 2, 2026. This is a subset, not automated capability detection.

Automated tests cover authentication boundaries, cancellation, safe errors, read queuing, large catalogs, duplicate paths, store/page identity checks, URL validation, pinned conversation scope, tool configuration, preserving native composer options, local draft revisions and baselines, bounded warehouse receipts and tickets, heatmap scope and filters, and structured validation failures. The BB fake-host harness checks the real RPC and agent-tool registrations. Tests run with Node 22's TypeScript stripping; the actual UltraCart toolkit runs with the separately configured Node 24.

Live verification covered a large authenticated storefront catalog, direct page reads, template resolution, browser opening, and the native composer. A live model turn has not been sent as part of testing. Local container pull and baseline review were verified against a connected storefront. Warehouse setup reported that Google Cloud sign-in was required; live analytical results have not been verified. No billed analytics queries or live store content changes were made during verification. Merchant data and credentials are not included in this repository.

The **Capability guide** remains a separate planning surface. Its briefs are stored in this browser's local storage, not scoped to a merchant or synchronized across machines. They do not automatically include the selected store. Copying a brief never dispatches work. The live workspace's native composer is the context-aware handoff.
