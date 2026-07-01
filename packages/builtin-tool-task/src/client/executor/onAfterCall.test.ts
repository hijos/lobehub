import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskApiName } from '../../types';

const mocks = vi.hoisted(() => ({
  getChatStoreState: vi.fn(),
  getTaskStoreState: vi.fn(),
  internalRefreshTaskDetail: vi.fn(),
  openTaskDetail: vi.fn(),
  refreshConversation: vi.fn(),
  refreshRootOperation: vi.fn(),
  refreshTaskList: vi.fn(),
  refreshVersions: vi.fn(),
  registerTask: vi.fn(),
  updateVerifyConfig: vi.fn(),
}));

vi.mock('@/store/chat', () => ({
  getChatStoreState: mocks.getChatStoreState,
}));

vi.mock('@/store/task', () => ({
  getTaskStoreState: mocks.getTaskStoreState,
}));

vi.mock('@/store/task/slices/detail/reducer', () => ({
  findSubtaskParentId: vi.fn(() => undefined),
}));

vi.mock('@/services/task', () => ({
  taskService: {
    updateVerifyConfig: mocks.updateVerifyConfig,
  },
}));

vi.mock('@/services/work', () => ({
  workService: {
    refreshConversation: mocks.refreshConversation,
    refreshRootOperation: mocks.refreshRootOperation,
    refreshVersions: mocks.refreshVersions,
    registerTask: mocks.registerTask,
  },
}));

// Imported after mocks so the executor module resolves the stubbed stores.
const { taskExecutor } = await import('./index');

describe('TaskExecutor.onAfterCall — portal auto-open', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.internalRefreshTaskDetail.mockResolvedValue(undefined);
    mocks.refreshConversation.mockResolvedValue(undefined);
    mocks.refreshRootOperation.mockResolvedValue(undefined);
    mocks.refreshTaskList.mockResolvedValue(undefined);
    mocks.refreshVersions.mockResolvedValue(undefined);
    mocks.registerTask.mockResolvedValue({ id: 'work-1' });
    mocks.updateVerifyConfig.mockResolvedValue(undefined);
    mocks.getChatStoreState.mockReturnValue({ openTaskDetail: mocks.openTaskDetail });
    mocks.getTaskStoreState.mockReturnValue({
      activeTaskId: undefined,
      internal_refreshTaskDetail: mocks.internalRefreshTaskDetail,
      refreshTaskList: mocks.refreshTaskList,
      taskDetailMap: {},
    });
  });

  it('opens the task detail portal after a successful createTask', async () => {
    await taskExecutor.onAfterCall({
      apiName: TaskApiName.createTask,
      params: {},
      result: { content: '', state: { identifier: 'task-123' }, success: true },
    } as any);

    expect(mocks.openTaskDetail).toHaveBeenCalledWith('task-123');
  });

  it('does not open the portal for non-createTask APIs', async () => {
    await taskExecutor.onAfterCall({
      apiName: TaskApiName.editTask,
      params: { identifier: 'task-1' },
      result: { content: '', state: { identifier: 'task-1' }, success: true },
    } as any);

    expect(mocks.openTaskDetail).not.toHaveBeenCalled();
  });

  it('does not open the portal when createTask failed', async () => {
    await taskExecutor.onAfterCall({
      apiName: TaskApiName.createTask,
      params: {},
      result: { content: '', success: false },
    } as any);

    expect(mocks.openTaskDetail).not.toHaveBeenCalled();
  });

  it('registers Work version after setting task verify config', async () => {
    const result = await taskExecutor.setTaskVerify(
      {
        enabled: true,
        identifier: 'TASK-1',
        requirement: 'Ship tested output',
      },
      {
        agentId: 'agent-1',
        operationId: 'op-child',
        rootOperationId: 'op-root',
        threadId: 'thread-1',
        toolCallId: 'tool-call-1',
        toolMessageId: 'msg-tool-1',
        topicId: 'topic-1',
      } as any,
    );

    expect(result.success).toBe(true);
    expect(mocks.updateVerifyConfig).toHaveBeenCalledWith({
      id: 'TASK-1',
      verify: {
        enabled: true,
        requirement: 'Ship tested output',
      },
    });
    expect(mocks.internalRefreshTaskDetail).toHaveBeenCalledWith('TASK-1');
    expect(mocks.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAgentId: 'agent-1',
        role: 'updated',
        rootOperationId: 'op-root',
        source: TaskApiName.setTaskVerify,
        sourceMessageId: 'msg-tool-1',
        sourceToolCallId: 'tool-call-1',
        sourceType: 'tool',
        taskIdentifier: 'TASK-1',
        threadId: 'thread-1',
        topicId: 'topic-1',
      }),
    );
    expect(mocks.refreshConversation).toHaveBeenCalledWith('topic-1', 'thread-1');
    expect(mocks.refreshRootOperation).toHaveBeenCalledWith('op-root');
    expect(mocks.refreshVersions).toHaveBeenCalledWith('work-1');
  });
});
