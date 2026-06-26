import type { RegisterTaskWorkParams } from '@lobechat/types';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { WorkModel } from '@/database/models/work';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

const workProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const wsId = ctx.workspaceId ?? undefined;

  return opts.next({
    ctx: {
      workModel: new WorkModel(ctx.serverDB, ctx.userId, wsId),
    },
  });
});

const workProcedureWrite = workProcedure.use(withScopedPermission('agent:update'));

const contextRoleSchema = z.enum(['created', 'updated']);
const sourceTypeSchema = z.enum(['import', 'system', 'tool', 'user']);

const registerTaskSchema = z.object({
  agentId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  operationId: z.string().nullable().optional(),
  role: contextRoleSchema,
  source: z.string().min(1),
  sourceType: sourceTypeSchema.optional(),
  taskId: z.string().optional(),
  taskIdentifier: z.string().optional(),
  threadId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  toolCallId: z.string().nullable().optional(),
  topicId: z.string().nullable().optional(),
}) satisfies z.ZodType<RegisterTaskWorkParams>;

export const workRouter = router({
  listByConversation: workProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        threadId: z.string().nullable().optional(),
        topicId: z.string().nullable().optional(),
      }),
    )
    .query(async ({ ctx, input }) => ctx.workModel.listByConversation(input)),

  listVersions: workProcedure
    .input(z.object({ workId: z.string().min(1) }))
    .query(async ({ ctx, input }) => ctx.workModel.listVersions(input.workId)),

  registerTask: workProcedureWrite
    .input(registerTaskSchema)
    .mutation(async ({ ctx, input }) => ctx.workModel.registerTask(input)),
});
