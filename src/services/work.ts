import type {
  RegisterTaskWorkParams,
  TaskWorkContextVersionItem,
  TaskWorkContextVersionMap,
  TaskWorkListItem,
  TaskWorkSummaryItem,
  TaskWorkSummaryMap,
  UpdateWorkVersionCumulativeUsageParams,
  WorkItem,
  WorkVersionListItem,
} from '@lobechat/types';

import { mutate } from '@/libs/swr';
import { matchDomain, workKeys } from '@/libs/swr/keys';
import { lambdaClient } from '@/libs/trpc/client';

class WorkService {
  listByConversation = async (params: {
    limit?: number;
    threadId?: string | null;
    topicId?: string | null;
  }): Promise<TaskWorkListItem[]> => lambdaClient.work.listByConversation.query(params);

  listByRootOperation = async (params: {
    limit?: number;
    rootOperationId?: string | null;
  }): Promise<TaskWorkContextVersionItem[]> => lambdaClient.work.listByRootOperation.query(params);

  listByRootOperations = async (params: {
    limit?: number;
    rootOperationIds?: string[] | null;
  }): Promise<TaskWorkContextVersionMap> => lambdaClient.work.listByRootOperations.query(params);

  listSummariesByConversation = async (params: {
    limit?: number;
    threadId?: string | null;
    topicId?: string | null;
  }): Promise<TaskWorkSummaryItem[]> => lambdaClient.work.listSummariesByConversation.query(params);

  listSummariesByRootOperations = async (params: {
    limit?: number;
    rootOperationIds?: string[] | null;
  }): Promise<TaskWorkSummaryMap> => lambdaClient.work.listSummariesByRootOperations.query(params);

  listVersions = async (workId: string): Promise<WorkVersionListItem[]> =>
    lambdaClient.work.listVersions.query({ workId });

  registerTask = async (params: RegisterTaskWorkParams): Promise<WorkItem | null> =>
    lambdaClient.work.registerTask.mutate(params);

  updateVersionCumulativeUsage = async (
    params: UpdateWorkVersionCumulativeUsageParams,
  ): Promise<void> => {
    await lambdaClient.work.updateVersionCumulativeUsage.mutate(params);
    await this.refreshRootOperation(params.rootOperationId);
  };

  refreshConversation = async (topicId?: string | null, threadId?: string | null) => {
    if (!topicId) return;
    await Promise.all([
      mutate(workKeys.conversation(topicId, threadId ?? null)),
      mutate(workKeys.conversationSummaries(topicId, threadId ?? null)),
    ]);
  };

  refreshAll = async () => {
    await mutate(matchDomain('work:'));
  };

  refreshRootOperation = async (rootOperationId?: string | null) => {
    if (!rootOperationId) return;
    await this.refreshRootOperations([rootOperationId]);
  };

  refreshRootOperations = async (rootOperationIds?: string[] | null) => {
    const ids = Array.from(
      new Set((rootOperationIds ?? []).filter((id): id is string => !!id)),
    ).sort();
    if (ids.length === 0) return;

    await Promise.all([
      mutate(workKeys.rootOperations(ids)),
      mutate(workKeys.rootOperationSummaries(ids)),
      mutate(matchDomain(workKeys.rootOperationSummaries.root)),
      ...ids.map((id) => mutate(workKeys.rootOperation(id))),
    ]);
  };

  refreshVersions = async (workId?: string | null) => {
    if (!workId) return;
    await mutate(workKeys.versions(workId));
  };
}

export const workService = new WorkService();
