import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const profileSelector = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const profileSchema = z.object({ id: z.string(), name: z.string(), merchantId: z.string().nullable() });
export const storefrontSchema = z.object({ id: z.number().int().positive(), host: z.string(), themeId: z.number().int().nullable() });
export const selectionSchema = z.object({ profileId: profileSelector, merchantId: z.string(), storefront: storefrontSchema, verifiedAt: z.string() });
export const loginSchema = z.object({
  id: z.string(), profile: profileSelector,
  phase: z.enum(['starting', 'waiting', 'succeeded', 'failed', 'cancelled']),
  url: z.string().nullable(), code: z.string().nullable(), message: z.string(),
});
export type Selection = z.infer<typeof selectionSchema>;
export type Login = z.infer<typeof loginSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Storefront = z.infer<typeof storefrontSchema>;
export const pagePathSchema = z.string().min(1).max(2048);
export const pageSchema = z.object({
  path: pagePathSchema, parent: z.string(), title: z.string(), description: z.string().nullable(),
  template: z.string().nullable(), itemTemplate: z.string().nullable(), visible: z.boolean().nullable(),
  search: z.enum(['indexable', 'noindex', 'unknown']), children: z.number(), items: z.number(), type: z.string().nullable(), catalogCopies: z.number(),
});
export const templateResultSchema = z.object({
  page: pagePathSchema, themeId: z.number().nullable(), group: z.object({ name: z.string(), path: z.string() }),
  item: z.object({ name: z.string(), path: z.string(), exists: z.boolean() }).nullable(), warnings: z.array(z.string()),
});
export const contextSchema = z.object({ selection: selectionSchema, pagePath: pagePathSchema });
const scopedPageInput = z.object({ selection: selectionSchema, path: pagePathSchema }).strict();
export const rpcContract = defineRpcContract({
  connectionStatus: { input: z.null(), output: z.object({ ready: z.boolean(), version: z.string().nullable(), machine: z.string(), profiles: z.array(profileSchema), selection: selectionSchema.nullable(), verified: z.boolean(), message: z.string() }) },
  beginLogin: { input: z.object({ profile: profileSelector }).strict(), output: loginSchema },
  loginStatus: { input: z.object({ id: z.string() }).strict(), output: loginSchema },
  cancelLogin: { input: z.object({ id: z.string() }).strict(), output: loginSchema },
  listStorefronts: { input: z.object({ profile: profileSelector }).strict(), output: z.object({ merchantId: z.string(), storefronts: z.array(storefrontSchema) }) },
  selectStorefront: { input: z.object({ profile: profileSelector, merchantId: z.string(), storefrontId: z.number().int().positive() }).strict(), output: selectionSchema },
  disconnectStorefront: { input: z.null(), output: z.object({ disconnected: z.boolean() }) },
  listPages: { input: z.object({ selection: selectionSchema }).strict(), output: z.object({ pages: z.array(pageSchema), fetchedAt: z.string() }) },
  readPage: { input: scopedPageInput, output: z.object({ page: pageSchema, url: z.string(), fetchedAt: z.string() }) },
  resolveTemplate: { input: scopedPageInput, output: templateResultSchema },
  prepareConversation: { input: scopedPageInput, output: z.object({ context: z.string(), metadata: contextSchema }) },
});
