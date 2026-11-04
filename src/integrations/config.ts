import { z } from 'zod';

// Application presentation metadata. The Agent and MCP execution core do not consume this.
const id = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const instrumentViewsSchema = z
  .array(
    z
      .object({
        id,
        name: z.string().min(1).max(100),
        kind: z.string().min(1).max(64),
        mcpServer: id,
      })
      .strict(),
  )
  .max(32)
  .refine(
    (views) => new Set(views.map((view) => view.id)).size === views.length,
    'Duplicate view IDs',
  );
export type InstrumentView = z.infer<typeof instrumentViewsSchema>[number];
