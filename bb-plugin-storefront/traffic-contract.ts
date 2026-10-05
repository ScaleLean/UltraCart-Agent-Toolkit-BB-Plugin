import { z } from 'zod';

const selection = z.object({ profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), merchantId: z.string().min(1).max(100), storefront: z.object({ id: z.number().int().positive(), host: z.string().min(1).max(253), themeId: z.number().int().nullable() }), verifiedAt: z.string() });
export const trafficPageSchema = z.object({ id: z.number().int().positive(), parentId: z.number().int().positive().nullable(), path: z.string().max(2048), title: z.string().max(500), visible: z.boolean().nullable(), sessions: z.number().int().nonnegative(), catalogCopies: z.number().int().positive() });
export const trafficSnapshotSchema = z.object({ from: z.string(), to: z.string(), fetchedAt: z.string(), host: z.string(), estimatedBytes: z.number().nonnegative(), pages: z.array(trafficPageSchema).max(10000), hostSessions: z.number().int().nonnegative(), unmatchedPaths: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative() });
export type TrafficPage = z.infer<typeof trafficPageSchema>;
export type TrafficSnapshot = z.infer<typeof trafficSnapshotSchema>;
const input = z.object({ selection }).strict();
export const trafficRpcMethods = {
  readPageTraffic: { input, output: trafficSnapshotSchema.nullable() },
  refreshPageTraffic: { input, output: trafficSnapshotSchema },
};
