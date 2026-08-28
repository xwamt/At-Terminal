import { z } from 'zod';

export const serverConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    group: z.string().trim().optional(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    authType: z.enum(['password', 'privateKey', 'agent']),
    privateKeyPath: z.string().min(1).optional(),
    jumpHostId: z.string().min(1).optional(),
    agentCommandTrust: z.enum(['none', 'policy', 'full']).optional(),
    agentCommandAutoApprove: z.boolean().optional(),
    backgroundConnectionAllowed: z.boolean().optional(),
    keepAliveInterval: z.number().int().min(0),
    encoding: z.enum(['utf-8', 'gbk', 'big5']).default('utf-8'),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.authType === 'privateKey' && !value.privateKeyPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['privateKeyPath'],
        message: 'privateKeyPath is required for privateKey auth'
      });
    }
  });

export const serverConfigListSchema = z.array(serverConfigSchema);

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type AuthType = ServerConfig['authType'];

const SERVER_CONFIG_KEYS = [
  'id',
  'label',
  'group',
  'host',
  'port',
  'username',
  'authType',
  'privateKeyPath',
  'jumpHostId',
  'agentCommandTrust',
  'agentCommandAutoApprove',
  'backgroundConnectionAllowed',
  'keepAliveInterval',
  'encoding',
  'createdAt',
  'updatedAt'
] as const;

const KNOWN_ENCODINGS: ReadonlySet<unknown> = new Set(['utf-8', 'gbk', 'big5']);
const DEFAULT_KEEP_ALIVE_INTERVAL = 30;

/**
 * Upgrades a stored record from an older release to the canonical strict
 * shape, or returns undefined when the record cannot represent a server at
 * all. 0.3.x records may omit `encoding` (added later) or carry keys this
 * version no longer knows; a strict parse would reject them and every server
 * would vanish from the tree. Unknown keys are stripped so
 * `serverConfigSchema` can stay `.strict()` as the single source of truth
 * for what a valid record looks like.
 */
export function migrateServerConfig(value: unknown): ServerConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidate: Record<string, unknown> = {};
  for (const key of SERVER_CONFIG_KEYS) {
    if (record[key] !== undefined) {
      candidate[key] = record[key];
    }
  }
  if (!KNOWN_ENCODINGS.has(candidate.encoding)) {
    // Deleting rather than assigning lets the schema's .default('utf-8') fill it in.
    delete candidate.encoding;
  }
  if (candidate.keepAliveInterval === undefined) {
    candidate.keepAliveInterval = DEFAULT_KEEP_ALIVE_INTERVAL;
  }
  const parsed = serverConfigSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** Strict parse for the save path: writes must already be canonical. */
export function parseServerConfig(value: unknown): ServerConfig {
  return serverConfigSchema.parse(value);
}

/**
 * Forgiving parse for the read path: each entry is migrated independently and
 * entries that still fail are skipped, so one legacy or corrupt record never
 * hides every other server.
 */
export function parseServerConfigList(value: unknown): ServerConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => migrateServerConfig(entry))
    .filter((entry): entry is ServerConfig => entry !== undefined);
}
