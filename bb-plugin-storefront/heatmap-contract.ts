import { z } from 'zod';
// This feature contract stays independent of the aggregate RPC contract at runtime.
const selectionSchema = z.object({profileId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),merchantId:z.string().min(1).max(100),storefront:z.object({id:z.number().int().positive(),host:z.string().min(1).max(253),themeId:z.number().int().nullable()}),verifiedAt:z.string().max(100)});
const pagePathSchema = z.string().min(1).max(2048);
export const heatmapFiltersSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), device: z.enum(['mobile','desktop','tablet']) }).strict();
export type HeatmapFilters = z.infer<typeof heatmapFiltersSchema>;
const receiptSchema = z.object({ project:z.string(),estimatedBytes:z.number(),maxBytes:z.number(),referencedTables:z.array(z.string()) });
const scopeSchema = z.object({selection:selectionSchema,path:pagePathSchema}).strict();
export const heatmapRpcMethods = {
  previewHeatmap: { input: scopeSchema.extend({filters:heatmapFiltersSchema}), output: z.object({ticket:z.string(),sql:z.string(),parameters:z.array(z.string()),receipt:receiptSchema,expiresAt:z.string()}) },
  runHeatmap: { input: scopeSchema.extend({ticket:z.string()}), output: z.object({filters:heatmapFiltersSchema,receipt:receiptSchema,fetchedAt:z.string(),rows:z.array(z.object({selector:z.string(),clicks:z.number(),movements:z.number()})),clicks:z.number(),movements:z.number(),heatmapRows:z.number(),scroll:z.object({p25:z.number().nullable(),median:z.number().nullable(),p75:z.number().nullable()})}) },
  locateHeatmap: { input: scopeSchema.extend({selector:z.string().min(1).max(2048)}), output: z.object({status:z.string(),reason:z.string(),matches:z.array(z.object({file:z.string(),path:z.string(),id:z.string(),type:z.string().nullable(),title:z.string().nullable(),excerpt:z.string().nullable()})),warnings:z.array(z.string())}) },
};
export type HeatmapPreview = z.infer<typeof heatmapRpcMethods.previewHeatmap.output>;
export type HeatmapResult = z.infer<typeof heatmapRpcMethods.runHeatmap.output>;
export type HeatmapLocation = z.infer<typeof heatmapRpcMethods.locateHeatmap.output>;
