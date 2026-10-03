import type { NewThreadRequest } from '@get-bb/plugin-sdk/app';
import type { Selection } from './connection-contract';

export function conversationRequest(request: NewThreadRequest, prepared: { context: string; metadata: { selection: Selection; pagePath: string } }) {
  return {
    ...request,
    title: `${prepared.metadata.selection.storefront.host} · ${prepared.metadata.pagePath}`,
    pluginMetadata: prepared.metadata,
    input: [{ type: 'text' as const, text: prepared.context, mentions: [] }, ...request.input],
  };
}
