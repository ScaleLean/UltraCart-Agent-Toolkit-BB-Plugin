import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

// Keep this feature contract independent of the aggregate connection contract.
const selection = z.object({ profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), merchantId: z.string(), storefront: z.object({ id: z.number().int().positive(), host: z.string(), themeId: z.number().int().nullable() }), verifiedAt: z.string() });
export const warehouseInputSchema = z.object({ sql: z.string().min(1).max(20000), maxBytes: z.number().int().min(1).max(20 * 1024 ** 3), rowLimit: z.number().int().min(1).max(100) }).strict();
export const warehouseReceiptSchema = z.object({ project: z.string(), estimatedBytes: z.number().nonnegative(), maxBytes: z.number().positive(), referencedTables: z.array(z.string()), cacheHit: z.boolean(), executed: z.boolean(), rows: z.array(z.record(z.string(), z.unknown())).max(100), fetchedAt: z.string(), auditWarning: z.string().optional() });
export const warehouseRpcMethods = {
  warehouseCheck: { input: z.object({ selection }).strict(), output: warehouseReceiptSchema },
  warehousePrepare: { input: z.object({ selection, query: warehouseInputSchema }).strict(), output: z.object({ receipt: warehouseReceiptSchema, ticket: z.string() }) },
  warehouseExecute: { input: z.object({ selection, ticket: z.string() }).strict(), output: warehouseReceiptSchema },
};
export const warehouseRpcContract = defineRpcContract(warehouseRpcMethods);
export type WarehouseQuery = z.infer<typeof warehouseInputSchema>;
export type WarehouseReceipt = z.infer<typeof warehouseReceiptSchema>;

export const warehouseTablesSql = 'SELECT table_name, table_type FROM ultracart_dw.INFORMATION_SCHEMA.TABLES ORDER BY table_name';
export function warehouseSchemaSql(table: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(table)) throw new Error('Choose a table name from the warehouse table list.');
  return `SELECT field_path, data_type FROM ultracart_dw.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS WHERE table_name = '${table}' ORDER BY field_path`;
}
