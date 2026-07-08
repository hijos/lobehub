import { builtinTools } from '@lobechat/builtin-tools';
import { resolveWorkRegistration } from '@lobechat/builtin-tools/workRegistration';
import { type LobeChatDatabase } from '@lobechat/database';

import { WorkModel } from '@/database/models/work';

import { type ToolExecutionContext, type ToolExecutionResult } from './types';

interface RegisterBuiltinToolWorkParams {
  apiName: string;
  args: Record<string, any>;
  context: ToolExecutionContext;
  /** Fallback db when the context carries none (mirrors the lobehubSkill branch). */
  db: LobeChatDatabase;
  identifier: string;
  result: ToolExecutionResult;
  /** Fallback user id when the context carries none. */
  userId: string;
}

/**
 * Manifest-driven Work registration for the server tool-execution path.
 *
 * Runs inline right after a builtin runtime returns (before the result is
 * published) so the Work version is durable before `tool_end` fires — the same
 * ordering the old imperative in-runtime registration guaranteed, minus the
 * per-tool boilerplate. Reads the API's declarative `work` config, extracts the
 * resource identity from the result/args, and upserts the Work version via
 * `WorkModel`.
 *
 * Best-effort: any failure is swallowed so bookkeeping never breaks the tool
 * result. No-op for APIs that declare no `work` config.
 */
export const registerBuiltinToolWork = async ({
  apiName,
  args,
  context,
  db,
  identifier,
  result,
  userId,
}: RegisterBuiltinToolWorkParams): Promise<void> => {
  const resolved = resolveWorkRegistration(builtinTools, identifier, apiName, { args, result });
  if (!resolved) return;

  try {
    const { role, targets } = resolved;
    const workModel = new WorkModel(
      context.serverDB ?? db,
      context.userId ?? userId,
      context.workspaceId,
    );
    const rootOperationId = context.rootOperationId ?? context.operationId;

    await Promise.all(
      targets.map((target) =>
        workModel.registerTask({
          actorAgentId: context.agentId ?? null,
          role,
          rootOperationId,
          source: apiName,
          sourceMessageId: context.toolMessageId,
          sourceToolCallId: context.toolCallId,
          taskId: target.taskId,
          taskIdentifier: target.taskIdentifier,
          threadId: context.threadId,
          topicId: context.topicId,
        }),
      ),
    );
  } catch (error) {
    console.error('Failed to register Work for %s:%s: %O', identifier, apiName, error);
  }
};
