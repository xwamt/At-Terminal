import { z } from 'zod';

export const runRemoteCommandBridgeSchema = z
  .object({
    serverId: z.string().min(1).optional(),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional()
  })
  .strict();

const sftpTargetFields = {
  terminalId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional()
};

export const sftpListDirectoryBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1).optional()
  })
  .strict();

export const sftpPathBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1)
  })
  .strict();

export const sftpReadFileBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1),
    maxBytes: z.number().int().positive().optional()
  })
  .strict();

export const sftpWriteFileBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean().optional()
  })
  .strict();

export const sftpCreateFileBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1),
    content: z.string().optional()
  })
  .strict();
