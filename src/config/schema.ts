import { z } from 'zod';

export const serverConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    group: z.string().trim().optional(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    authType: z.enum(['password', 'privateKey']),
    privateKeyPath: z.string().min(1).optional(),
    keepAliveInterval: z.number().int().min(0),
    encoding: z.literal('utf-8'),
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

export function parseServerConfig(value: unknown): ServerConfig {
  return serverConfigSchema.parse(value);
}

export function parseServerConfigList(value: unknown): ServerConfig[] {
  return serverConfigListSchema.parse(value);
}
