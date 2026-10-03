# Storefront for BB

A native UltraCart capability explorer and connection panel. See the [workspace README](../README.md) for setup, the login flow, tested behavior, and limitations.

- `app.tsx`, `capabilities.ts`: capability explorer and local planning brief
- `connection-panel.tsx`: login and storefront selection UI
- `connection-contract.ts`: validated frontend/backend RPC boundary
- `connection-service.ts`: bounded toolkit subprocesses and in-memory device login
- `server.ts`: connection settings and nonsecret selection persistence

## Workspace

- `workspace.tsx`: live page search, branch navigation, page details, template lookup, native browser links, and the BB composer/chat.
- `storefront-data.ts`: bounded response projection, same-store URL checks, duplicate catalog handling, and page context.
- `conversation.ts`: native composer handoff. Keeps the user's provider, environment, permissions, scheduling, and attachments.

Sending the native composer starts a BB conversation with a pinned merchant, storefront, and page. The plugin supplies three read-only tools for page discovery. Agent tools use conversation metadata, not the panel's later store selection. Metadata is validated and access is rechecked through the toolkit on every read.

The plugin does not implement store-content writes. The official toolkit manages credentials. Disconnect clears the BB selection without logging out the toolkit profile; existing conversations retain their pinned context and can still read through that profile.
