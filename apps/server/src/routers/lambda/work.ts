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
  actorAgentId: z.string().nullable().optional(),
  role: contextRoleSchema,
  rootOperationId: z.string().nullable().optional(),
  source: z.string().min(1),
  sourceMessageId: z.string().nullable().optional(),
  sourceToolCallId: z.string().nullable().optional(),
  sourceType: sourceTypeSchema.optional(),
  taskId: z.string().optional(),
  taskIdentifier: z.string().optional(),
  threadId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
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

  listByRootOperation: workProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(50).default(20),
        rootOperationId: z.string().nullable().optional(),
      }),
    )
    .query(async ({ ctx, input }) =>
      ctx.workModel.listByRootOperation({
        limit: input.limit,
        rootOperationId: input.rootOperationId,
      }),
    ),

  listByRootOperations: workProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(50).default(20),
        rootOperationIds: z.array(z.string()).nullable().optional(),
      }),
    )
    .query(async ({ ctx, input }) =>
      ctx.workModel.listByRootOperations({
        limit: input.limit,
        rootOperationIds: input.rootOperationIds,
      }),
    ),

  listVersions: workProcedure
    .input(z.object({ workId: z.string().min(1) }))
    .query(async ({ ctx, input }) => ctx.workModel.listVersions(input.workId)),

  registerTask: workProcedureWrite
    .input(registerTaskSchema)
    .mutation(async ({ ctx, input }) => ctx.workModel.registerTask(input)),
});
