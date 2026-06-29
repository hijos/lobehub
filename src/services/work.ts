import type {
  RegisterTaskWorkParams,
  TaskWorkContextVersionItem,
  TaskWorkContextVersionMap,
  TaskWorkListItem,
  WorkItem,
  WorkVersionListItem,
} from '@lobechat/types';

import { mutate } from '@/libs/swr';
import { workKeys } from '@/libs/swr/keys';
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

  listVersions = async (workId: string): Promise<WorkVersionListItem[]> =>
    lambdaClient.work.listVersions.query({ workId });

  registerTask = async (params: RegisterTaskWorkParams): Promise<WorkItem | null> =>
    lambdaClient.work.registerTask.mutate(params);

  refreshConversation = async (topicId?: string | null, threadId?: string | null) => {
    if (!topicId) return;
    await mutate(workKeys.conversation(topicId, threadId ?? null));
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
      ...ids.map((id) => mutate(workKeys.rootOperation(id))),
    ]);
  };

  refreshVersions = async (workId?: string | null) => {
    if (!workId) return;
    await mutate(workKeys.versions(workId));
  };
}

export const workService = new WorkService();
