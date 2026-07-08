import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshConversation: vi.fn(),
  refreshRootOperation: vi.fn(),
  refreshVersions: vi.fn(),
  registerTask: vi.fn(),
}));

vi.mock('@lobechat/builtin-tools', () => ({
  builtinTools: [
    {
      identifier: 'lobe-task',
      manifest: {
        api: [
          { name: 'createTask', work: { action: 'create', resourceType: 'task' } },
          { name: 'createTasks', work: { action: 'create', resourceType: 'task' } },
          { name: 'editTask', work: { action: 'update', resourceType: 'task' } },
          { name: 'listTasks' },
        ],
      },
    },
  ],
}));

vi.mock('@/services/work', () => ({
  workService: {
    refreshConversation: mocks.refreshConversation,
    refreshRootOperation: mocks.refreshRootOperation,
    refreshVersions: mocks.refreshVersions,
    registerTask: mocks.registerTask,
  },
}));

const { registerBuiltinToolWork } = await import('./workRegistration');

const ctx = {
  agentId: 'agent-1',
  operationId: 'op-child',
  rootOperationId: 'op-root',
  threadId: 'thread-1',
  toolCallId: 'tool-call-1',
  toolMessageId: 'msg-tool-1',
  topicId: 'topic-1',
} as any;

describe('registerBuiltinToolWork (client dispatch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerTask.mockResolvedValue({ id: 'work-1' });
    mocks.refreshConversation.mockResolvedValue(undefined);
    mocks.refreshRootOperation.mockResolvedValue(undefined);
    mocks.refreshVersions.mockResolvedValue(undefined);
  });

  it('registers a created task and refreshes the work caches', async () => {
    await registerBuiltinToolWork(
      'lobe-task',
      'createTask',
      { name: 'A', instruction: 'do' },
      ctx,
      { content: '', state: { identifier: 'T-1', success: true, taskId: 'task_1' }, success: true },
    );

    expect(mocks.registerTask).toHaveBeenCalledWith({
      actorAgentId: 'agent-1',
      role: 'created',
      rootOperationId: 'op-root',
      source: 'createTask',
      sourceMessageId: 'msg-tool-1',
      sourceToolCallId: 'tool-call-1',
      taskId: 'task_1',
      taskIdentifier: 'T-1',
      threadId: 'thread-1',
      topicId: 'topic-1',
    });
    expect(mocks.refreshConversation).toHaveBeenCalledWith('topic-1', 'thread-1');
    expect(mocks.refreshRootOperation).toHaveBeenCalledWith('op-root');
    expect(mocks.refreshVersions).toHaveBeenCalledWith('work-1');
  });

  it('registers an update via args.identifier with role "updated"', async () => {
    await registerBuiltinToolWork(
      'lobe-task',
      'editTask',
      { identifier: 'T-9', name: 'Edited' },
      ctx,
      { content: '', success: true },
    );

    expect(mocks.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'updated', source: 'editTask', taskIdentifier: 'T-9' }),
    );
  });

  it('registers only the succeeded items of a batch and refreshes caches once', async () => {
    await registerBuiltinToolWork('lobe-task', 'createTasks', { tasks: [] }, ctx, {
      content: '',
      state: {
        failed: 1,
        results: [
          { identifier: 'T-A', name: 'A', success: true },
          { error: 'boom', name: 'B', success: false },
        ],
        succeeded: 1,
      },
      success: false,
    });

    expect(mocks.registerTask).toHaveBeenCalledTimes(1);
    expect(mocks.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'created', source: 'createTasks', taskIdentifier: 'T-A' }),
    );
    // Caches refresh once for the whole batch, not per item.
    expect(mocks.refreshConversation).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an API without a work config', async () => {
    await registerBuiltinToolWork('lobe-task', 'listTasks', {}, ctx, {
      content: '',
      success: true,
    });

    expect(mocks.registerTask).not.toHaveBeenCalled();
    expect(mocks.refreshConversation).not.toHaveBeenCalled();
  });

  it('does not register when the call failed (no targets)', async () => {
    await registerBuiltinToolWork('lobe-task', 'editTask', { identifier: 'T-1' }, ctx, {
      content: 'boom',
      success: false,
    });

    expect(mocks.registerTask).not.toHaveBeenCalled();
  });

  it('swallows registration errors (best-effort, never throws)', async () => {
    mocks.registerTask.mockRejectedValueOnce(new Error('trpc died'));

    await expect(
      registerBuiltinToolWork('lobe-task', 'createTask', { name: 'A' }, ctx, {
        content: '',
        state: { identifier: 'T-1', success: true },
        success: true,
      }),
    ).resolves.toBeUndefined();
  });
});
