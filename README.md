# UltraCart Agent Toolkit BB Plugin

A native BB Storefront plugin. It adds **Storefront** to navigation and **Storefront workspace** to an existing thread's panel actions.

## Current slices

1. Capability explorer: intent search, category filters, source references, command examples, and a local planning brief.
2. Storefront connection: official toolkit device login, existing profile selection, storefront discovery, verified selection, and disconnect.
3. Live workspace: searchable catalog pages, branch navigation, page metadata, shared-template impact, resolved template files, and live-page browser links.
4. Agent handoff: BB's native new-chat composer and embedded conversation, with three read-only storefront tools and pinned page context.

The connection runs on the **BB server machine** using an explicitly configured Node executable and toolkit CLI entry. Remote BB execution machines are not supported by this slice. The UI names the execution machine. No store content editing is implemented.

## Login

Open Storefront, choose **Connect storefront**, name a profile, and select **Sign in with UltraCart**. Open the UltraCart authorization link and complete the browser flow yourself. Keep the panel open; leaving it cancels an in-progress request.

After sign-in, available storefronts load automatically. Choose **Use storefront**. Existing profiles can use **Load storefronts** without signing in again. Store selection is checked against a fresh storefront list and merchant identity before saving. The workspace then reads the catalog, verifying access again.

The toolkit owns OAuth and native credential storage. BB stores only the selected profile, merchant, storefront metadata, and verification time. Device URLs and codes exist only in memory while waiting. The wrapper never handles access/refresh tokens. Successful toolkit login changes its global current profile; this plugin always passes an explicit profile for remote reads.

**Disconnect storefront** clears BB's selection only. It does not revoke or delete the shared toolkit profile or its OS keychain login. Existing conversations retain their pinned context and tools. Logout is not implemented in this slice.

## Working with a page

Open **Storefront → Workspace**. The initial branch shows the home page and its direct children. Search matches all page paths, titles, and reported template names. Branch buttons navigate the catalog hierarchy. Lists render 60 results at a time.

Selecting a page fetches fresh settings. **Resolve template files** asks UltraCart which files actually render, including shadowed copies. The shared-template count comes from the catalog snapshot. **Open live page** uses BB's configured browser preference. It opens the published page, not a staged preview.

Choose **Understand this page**, **Find improvements**, or **Plan a change** to open BB's native composer. Select a provider and environment, edit the draft, then send. The first message includes fresh, verified merchant/store/page context. The new conversation is also available in BB's sidebar. Its target stays fixed when the panel selection changes.

The agent receives `storefront_list_pages`, `storefront_read_page`, and `storefront_resolve_template`. These run on the BB server. They do not require the toolkit to be installed on the agent's execution machine. Agent authentication remains separate from UltraCart authentication. The provider list is not an authentication check.

Catalog reads are bounded to 4 MiB and 10,000 records. Duplicate paths appear once with a warning and uncertain settings; selecting one reads the page directly. Missing visibility remains unknown. Read requests queue across BB windows, with a maximum of 12 outstanding commands. There are no automatic retries after an UltraCart error or rate limit.

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

The 12 automated tests cover authentication boundaries, cancellation, safe errors, read queuing, large catalogs, duplicate paths, store/page identity checks, URL validation, pinned conversation scope, tool configuration, and preserving native composer options. The BB fake-host harness checks the real RPC and agent-tool registrations. Tests run with Node 22's TypeScript stripping; the actual UltraCart toolkit runs with the separately configured Node 24.

Live verification covered a large authenticated storefront catalog, direct page reads, template resolution, browser opening, and the native composer. A live model turn has not been sent as part of testing. Store content has not been changed. Merchant data and credentials are not included in this repository.

The **Capability guide** remains a separate planning surface. Its briefs are stored in this browser's local storage, not scoped to a merchant or synchronized across machines. They do not automatically include the selected store. Copying a brief never dispatches work. The live workspace's native composer is the context-aware handoff.
