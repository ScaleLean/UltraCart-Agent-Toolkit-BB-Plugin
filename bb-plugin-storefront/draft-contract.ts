import { z } from 'zod';
import type { Selection } from './connection-contract';

// These declarations are independent of the connection contract at runtime.
const selection = z.object({ profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), merchantId: z.string().min(1).max(100), storefront: z.object({ id: z.number().int().positive(), host: z.string().min(1).max(253), themeId: z.number().int().nullable() }), verifiedAt: z.string().max(100) });
export const draftScopeSchema = z.object({ selection, path: z.string().min(1).max(2048), slot: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).default('body') }).strict();
export type DraftScope = { selection: Selection; path: string; slot: string };
export const fieldEditSchema = z.object({ pointer: z.string().min(1).max(4096), value: z.string().max(16384) }).strict();
const fieldSchema = z.object({ pointer: z.string(), widget: z.string(), key: z.string(), before: z.string(), value: z.string() });
const draftSchema = z.object({ id: z.string().uuid(), path: z.string(), container: z.string(), slot: z.string(), revision: z.number().int(), baselineHash: z.string(), createdAt: z.string(), updatedAt: z.string(), fields: z.array(fieldSchema), skippedFields: z.number().int(), changedFields: z.number().int() });
export type Draft = z.infer<typeof draftSchema>;
const scopedId = draftScopeSchema.extend({ id: z.string().uuid() });
export const draftSaveSchema = scopedId.extend({ revision: z.number().int().positive(), edits: z.array(fieldEditSchema).max(100) }).strict();
const validationSchema = z.object({ valid: z.boolean(), errors: z.number().int().nonnegative(), warnings: z.number().int().nonnegative(), diagnostics: z.array(z.object({ severity: z.string(), code: z.string(), path: z.string(), message: z.string() })), omitted: z.number().int().nonnegative() });
export const draftReviewSchema = z.object({ draft: draftSchema, changes: z.array(fieldSchema), validation: validationSchema, remoteChanged: z.boolean(), remoteHash: z.string(), reviewedRevision: z.number().int(), checkedAt: z.string(), limitation: z.string() });
export type DraftReview = z.infer<typeof draftReviewSchema>;
export const draftRpcMethods = {
  readDraft: { input: draftScopeSchema, output: draftSchema.nullable() },
  pullDraft: { input: draftScopeSchema, output: draftSchema },
  saveDraft: { input: draftSaveSchema, output: draftSchema },
  reviewDraft: { input: scopedId.extend({ revision: z.number().int().positive() }).strict(), output: draftReviewSchema },
};
