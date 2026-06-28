import type {
  RegisterTaskWorkParams,
  TaskWorkContextVersionItem,
  TaskWorkListItem,
  WorkItem,
  WorkVersionListItem,
} from '@lobechat/types';

import { mutate } from '@/libs/swr';
import { workKeys } from '@/libs/swr/keys';
import { lambdaClient } from '@/libs/trpc/client';

class WorkService {
  attachDisplayAnchorAssistantMessage = async (params: {
    displayAnchorAssistantMessageId?: string | null;
    rootOperationId?: string | null;
  }): Promise<number> => lambdaClient.work.attachDisplayAnchorAssistantMessage.mutate(params);

  listByDisplayAnchorAssistantMessage = async (params: {
    displayAnchorAssistantMessageId?: string | null;
    displayAnchorAssistantMessageIds?: string[] | null;
    limit?: number;
  }): Promise<TaskWorkContextVersionItem[]> =>
    lambdaClient.work.listByDisplayAnchorAssistantMessage.query(params);

  listByConversation = async (params: {
    limit?: number;
    threadId?: string | null;
    topicId?: string | null;
  }): Promise<TaskWorkListItem[]> => lambdaClient.work.listByConversation.query(params);

  listByRootOperation = async (params: {
    limit?: number;
    rootOperationId?: string | null;
  }): Promise<TaskWorkContextVersionItem[]> => lambdaClient.work.listByRootOperation.query(params);

  listVersions = async (workId: string): Promise<WorkVersionListItem[]> =>
    lambdaClient.work.listVersions.query({ workId });

  registerTask = async (params: RegisterTaskWorkParams): Promise<WorkItem | null> =>
    lambdaClient.work.registerTask.mutate(params);

  refreshConversation = async (topicId?: string | null, threadId?: string | null) => {
    if (!topicId) return;
    await mutate(workKeys.conversation(topicId, threadId ?? null));
  };

  refreshDisplayAnchorAssistantMessage = async (messageId?: string | null) => {
    if (!messageId) return;
    await mutate(
      (key) =>
        Array.isArray(key) &&
        key[0] === workKeys.displayAnchorAssistantMessage.root &&
        (key[1] === messageId || (Array.isArray(key[1]) && key[1].includes(messageId))),
    );
  };

  refreshDisplayAnchorAssistantMessages = async (messageIds?: string[] | null) => {
    const ids = messageIds?.filter(Boolean);
    if (!ids || ids.length === 0) return;
    await mutate(workKeys.displayAnchorAssistantMessage(ids));
  };

  refreshRootOperation = async (rootOperationId?: string | null) => {
    if (!rootOperationId) return;
    await mutate(workKeys.rootOperation(rootOperationId));
  };

  refreshVersions = async (workId?: string | null) => {
    if (!workId) return;
    await mutate(workKeys.versions(workId));
  };
}

export const workService = new WorkService();
