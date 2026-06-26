import type {
  RegisterTaskWorkParams,
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

  listVersions = async (workId: string): Promise<WorkVersionListItem[]> =>
    lambdaClient.work.listVersions.query({ workId });

  registerTask = async (params: RegisterTaskWorkParams): Promise<WorkItem | null> =>
    lambdaClient.work.registerTask.mutate(params);

  refreshConversation = async (topicId?: string | null, threadId?: string | null) => {
    if (!topicId) return;
    await mutate(workKeys.conversation(topicId, threadId ?? null));
  };

  refreshVersions = async (workId?: string | null) => {
    if (!workId) return;
    await mutate(workKeys.versions(workId));
  };
}

export const workService = new WorkService();
