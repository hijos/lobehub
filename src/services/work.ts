import type {
  RegisterDocumentWorkParams,
  RegisterSkillToolResultWorkParams,
  RegisterTaskWorkParams,
  WorkItem,
  WorkListItem,
  WorkSummaryItem,
  WorkType,
  WorkVersionEventItem,
  WorkVersionEventMap,
  WorkVersionItem,
} from '@lobechat/types';

import { mutate } from '@/libs/swr';
import { isMessageListKey, matchDomain, workKeys } from '@/libs/swr/keys';
import { lambdaClient } from '@/libs/trpc/client';

/** One cursor page of the workspace-wide Work list (resource page 产物 gallery). */
export interface WorkSummaryPage {
  items: WorkSummaryItem[];
  nextCursor: string | null;
}

class WorkService {
  listByConversation = async (params: {
    limit?: number;
    threadId?: string | null;
    topicId?: string | null;
  }): Promise<WorkListItem[]> => lambdaClient.work.listByConversation.query(params);

  listByWorkspace = async (params: {
    cursor?: string | null;
    limit?: number;
    type?: WorkType | null;
  }): Promise<WorkSummaryPage> => lambdaClient.work.listByWorkspace.query(params);

  listByRootOperation = async (params: {
    limit?: number;
    rootOperationId?: string | null;
  }): Promise<WorkVersionEventItem[]> => lambdaClient.work.listByRootOperation.query(params);

  listByRootOperations = async (params: {
    limit?: number;
    rootOperationIds?: string[] | null;
  }): Promise<WorkVersionEventMap> => lambdaClient.work.listByRootOperations.query(params);

  listVersions = async (workId: string): Promise<WorkVersionItem[]> =>
    lambdaClient.work.listVersions.query({ workId });

  registerTask = async (params: RegisterTaskWorkParams): Promise<WorkItem | null> =>
    lambdaClient.work.registerTask.mutate(params);

  registerDocument = async (params: RegisterDocumentWorkParams): Promise<WorkItem | null> =>
    lambdaClient.work.registerDocument.mutate(params);

  deleteTaskWork = async (params: { taskId: string }): Promise<void> =>
    lambdaClient.work.deleteTaskWork.mutate(params);

  handleSkillToolResult = async (
    params: RegisterSkillToolResultWorkParams,
  ): Promise<WorkItem | null> => {
    const work = await lambdaClient.work.handleSkillToolResult.mutate(params);
    await Promise.all([
      // Summary chips + sidebar summary ride the message payload, so this
      // invalidates the topic's message list; the history view is refreshed too.
      this.refreshConversation(params.topicId, params.threadId),
      // Expanded version-history lists subscribe per work id; without this the
      // sidebar keeps showing the pre-mutation versions until a page refresh.
      this.refreshVersions(work?.id),
    ]);

    return work;
  };

  /**
   * Invalidate everything a Work mutation can change for a conversation:
   * - the topic's `message:list` entries, since Work summaries (in-message chips
   *   and the sidebar summary view) ride the message payload
   * - the sidebar history view (`workKeys.conversation`), a separate lazy cache
   */
  refreshConversation = async (topicId?: string | null, threadId?: string | null) => {
    if (!topicId) return;
    await Promise.all([
      this.refreshConversationMessages(topicId),
      mutate(workKeys.conversation(topicId, threadId ?? null)),
    ]);
  };

  /**
   * Re-pull the message list for a topic so the Work summaries attached to its
   * message payload become fresh. `mutate` only refetches mounted keys, so this
   * is a no-op when the topic isn't the active conversation.
   */
  refreshConversationMessages = async (topicId: string) => {
    await mutate((key) => isMessageListKey(key, (context) => context.topicId === topicId));
  };

  refreshAll = async () => {
    await mutate(matchDomain('work:'));
  };

  /**
   * Broad invalidation for Work mutations without a single-topic scope (e.g.
   * task deletion, which can orphan Works across topics into a "task deleted"
   * state). Refreshes every mounted `message:list` — since Work summaries ride
   * the message payload — plus the whole work domain for the sidebar caches.
   */
  refreshAllConversations = async () => {
    await Promise.all([mutate((key) => isMessageListKey(key)), this.refreshAll()]);
  };

  refreshVersions = async (workId?: string | null) => {
    if (!workId) return;
    await mutate(workKeys.versions(workId));
  };
}

export const workService = new WorkService();
