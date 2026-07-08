import { builtinTools } from '@lobechat/builtin-tools';
import { resolveWorkRegistration } from '@lobechat/builtin-tools/workRegistration';
import debug from 'debug';

import { workService } from '@/services/work';

import type { BuiltinToolContext, BuiltinToolResult } from '../types';

const log = debug('lobe-tool:work-registration');

/**
 * Manifest-driven Work registration for the client tool-execution path (the OSS
 * no-gateway / desktop client-run fallback).
 *
 * Runs inline after `executor.invoke` returns so the Work version lands (and the
 * shared work SWR caches refresh) before the caller publishes `tool_end` and the
 * UI re-reads them — the same ordering the old in-executor `registerTaskWorks`
 * guaranteed, now sourced from the declarative `work` manifest config instead of
 * per-tool code. Best-effort and a no-op for APIs that declare no `work` config.
 */
export const registerBuiltinToolWork = async (
  identifier: string,
  apiName: string,
  params: unknown,
  ctx: BuiltinToolContext | undefined,
  result: BuiltinToolResult,
): Promise<void> => {
  const resolved = resolveWorkRegistration(builtinTools, identifier, apiName, {
    args: params,
    result,
  });
  if (!resolved) return;

  try {
    const rootOperationId = ctx?.rootOperationId ?? ctx?.operationId;

    // Tool-driven delete: drop the task's Work (versions cascade server-side),
    // then refresh the shared caches so the sidebar drops it. Non-tool deletes
    // (UI / CLI) leave the Work orphaned for the UI to mark as "deleted".
    if (resolved.action === 'delete') {
      await Promise.all(
        resolved.targets.map((target) =>
          target.taskId
            ? workService.deleteTaskWork({ taskId: target.taskId }).catch((error) => {
                log('deleteTaskWork failed: %O', error);
              })
            : undefined,
        ),
      );
      await Promise.all([
        workService.refreshConversation(ctx?.topicId, ctx?.threadId),
        workService.refreshRootOperation(rootOperationId),
      ]).catch((error) => {
        log('refresh work caches failed: %O', error);
      });
      return;
    }

    const { role, targets } = resolved;

    const works = await Promise.all(
      targets.map((target) =>
        workService
          .registerTask({
            actorAgentId: ctx?.agentId,
            role,
            rootOperationId,
            source: apiName,
            sourceMessageId: ctx?.toolMessageId,
            sourceToolCallId: ctx?.toolCallId,
            taskId: target.taskId,
            taskIdentifier: target.taskIdentifier,
            threadId: ctx?.threadId,
            topicId: ctx?.topicId,
          })
          .catch((error) => {
            log('registerTask failed: %O', error);
            return undefined;
          }),
      ),
    );

    // Refresh the shared work caches ONCE for the whole batch (a batch can create
    // dozens of tasks; the caches only need the final state): conversation +
    // root-operation lists, plus the expanded version history per touched work.
    await Promise.all([
      workService.refreshConversation(ctx?.topicId, ctx?.threadId),
      workService.refreshRootOperation(rootOperationId),
      ...works.filter(Boolean).map((work) => workService.refreshVersions(work?.id)),
    ]).catch((error) => {
      log('refresh work caches failed: %O', error);
    });
  } catch (error) {
    log('registerBuiltinToolWork failed: %O', error);
  }
};
