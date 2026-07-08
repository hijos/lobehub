import type { ChatToolPayload } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltinToolsExecutor } from '../builtin';
import type { ToolExecutionContext } from '../types';

const mocks = vi.hoisted(() => ({
  apiHandler: vi.fn(),
  executeLobehubSkill: vi.fn(),
  handleSkillToolResult: vi.fn(),
  registerTask: vi.fn(),
}));
const mockApiHandler = mocks.apiHandler;

vi.mock('../serverRuntimes', () => ({
  hasServerRuntime: vi.fn().mockReturnValue(true),
  getServerRuntime: vi.fn(async () => ({ createDocument: mocks.apiHandler })),
}));

vi.mock('@/database/models/work', () => ({
  WorkModel: vi.fn().mockImplementation(() => ({
    handleSkillToolResult: mocks.handleSkillToolResult,
    registerTask: mocks.registerTask,
  })),
}));
vi.mock('@/server/services/composio', () => ({
  ComposioService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn().mockImplementation(() => ({
    executeLobehubSkill: mocks.executeLobehubSkill,
  })),
}));

// The runtime mock above only exposes `createDocument`, but the manifest is the
// authoritative source of declared APIs — it also lists `listDocuments`, so an
// UNKNOWN_API hint sourced from the manifest must surface both.
vi.mock('@lobechat/builtin-tools', () => ({
  builtinTools: [
    {
      identifier: 'lobe-notebook',
      manifest: { api: [{ name: 'createDocument' }, { name: 'listDocuments' }] },
    },
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

const buildPayload = (argsStr: string): ChatToolPayload => ({
  apiName: 'createDocument',
  arguments: argsStr,
  id: 't1',
  identifier: 'lobe-notebook',
  type: 'default' as any,
});

const context: ToolExecutionContext = {
  toolManifestMap: {},
  userId: 'user-1',
};

describe('BuiltinToolsExecutor truncated arguments', () => {
  const executor = new BuiltinToolsExecutor({} as any, 'user-1');

  beforeEach(() => {
    mockApiHandler.mockReset();
    mocks.executeLobehubSkill.mockReset();
    mocks.handleSkillToolResult.mockReset();
    mocks.registerTask.mockReset();
  });

  it('short-circuits with TRUNCATED_ARGUMENTS when JSON is cut mid-object', async () => {
    const truncated = '{"title": "Report", "description": "foo", "type": "report"';

    const result = await executor.execute(buildPayload(truncated), context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TRUNCATED_ARGUMENTS');
    expect(result.content).toMatch(/truncated/i);
    expect(result.content).toMatch(/max_tokens/);
    // The raw truncated payload is echoed back so the model sees exactly what
    // it produced and cannot blame upstream for a different payload.
    expect(result.content).toContain(truncated);
    expect(mockApiHandler).not.toHaveBeenCalled();
  });

  it('short-circuits with TRUNCATED_ARGUMENTS when a string value is unterminated', async () => {
    const truncated = '{"title": "Report", "content": "this is cut';

    const result = await executor.execute(buildPayload(truncated), context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TRUNCATED_ARGUMENTS');
    expect(result.content).toMatch(/unterminated string/);
    expect(result.content).toContain(truncated);
    expect(mockApiHandler).not.toHaveBeenCalled();
  });

  it('still dispatches to the runtime for valid JSON missing required fields', async () => {
    mockApiHandler.mockResolvedValueOnce({
      content: 'Error: Missing content. The document content is required.',
      success: false,
    });

    const result = await executor.execute(
      buildPayload('{"title": "Report", "type": "report"}'),
      context,
    );

    expect(mockApiHandler).toHaveBeenCalledWith({ title: 'Report', type: 'report' }, context);
    // The schema-level error from the runtime passes through untouched.
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/Missing content/);
  });

  it('returns INVALID_JSON_ARGUMENTS for balanced-but-invalid JSON (not truncated)', async () => {
    // Balanced brackets but invalid syntax (unquoted key). Not a truncation,
    // but still unparseable — reject with a non-truncation error rather than
    // silently passing `{}` to the tool.
    const invalid = '{title: "Report"}';

    const result = await executor.execute(buildPayload(invalid), context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_JSON_ARGUMENTS');
    expect(result.content).toMatch(/not valid JSON/);
    expect(result.content).toContain(invalid);
    expect(mockApiHandler).not.toHaveBeenCalled();
  });

  // verify the self-reflection signal survives the new persist-time
  // sanitizer. The fix sanitizes `tool_calls[].arguments` only at DB/state
  // boundaries (to unbreak strict providers), so the raw bad string must still
  // reach the executor — otherwise the model loses the "fix your JSON syntax"
  // feedback and degrades to a generic "missing required field" error.
  it('emits INVALID_JSON_ARGUMENTS for the Qwen shape with raw args echoed', async () => {
    const invalid = '{, "description": "Create data models", "language": "python"}';

    const result = await executor.execute(buildPayload(invalid), context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_JSON_ARGUMENTS');
    expect(result.content).toMatch(/not valid JSON/);
    // Critical: the raw malformed string must appear in the tool-result content
    // so the model can self-correct based on what it actually produced.
    expect(result.content).toContain(invalid);
    expect(mockApiHandler).not.toHaveBeenCalled();
  });

  it('still dispatches normally when argsStr is empty', async () => {
    mockApiHandler.mockResolvedValueOnce({ content: 'ok', success: true });

    // Empty arguments are legitimate for tools that take no params —
    // parse falls through to `{}` without triggering the invalid-JSON guard.
    const result = await executor.execute(buildPayload(''), context);

    expect(mockApiHandler).toHaveBeenCalledWith({}, context);
    expect(result.success).toBe(true);
  });

  it('returns a recoverable UNKNOWN_API error for a hallucinated apiName', async () => {
    // The runtime mock only exposes `createDocument`; calling a non-existent
    // API (e.g. a model hallucinating `viewTopic`) must NOT throw a hard error
    // — it should return a structured result that lists the real APIs so the
    // model can self-correct.
    const result = await executor.execute({ ...buildPayload('{}'), apiName: 'viewTopic' }, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_API');
    expect(result.content).toContain('viewTopic');
    // The available APIs are surfaced to guide the model.
    expect(result.content).toContain('createDocument');
    // Sourced from the manifest, not the runtime instance: `listDocuments` is
    // declared in the manifest yet absent from the mocked runtime's own keys,
    // so its presence proves the hint reads the manifest.
    expect(result.content).toContain('listDocuments');
    expect(mockApiHandler).not.toHaveBeenCalled();
  });

  it('lists prototype-method APIs via the fallback when no manifest is available', async () => {
    // A runtime whose APIs are class prototype methods (the common case).
    // `Object.keys(runtime)` would miss these, collapsing the hint to an empty
    // list; the prototype-chain fallback must surface them.
    class FooRuntime {
      async barApi() {
        return { content: 'ok', success: true };
      }
    }
    const { getServerRuntime } = await import('../serverRuntimes');
    vi.mocked(getServerRuntime).mockResolvedValueOnce(new FooRuntime() as any);

    const result = await executor.execute(
      { ...buildPayload('{}'), apiName: 'hallucinated', identifier: 'lobe-unknown-tool' },
      context,
    );

    expect(result.error?.code).toBe('UNKNOWN_API');
    expect(result.content).toContain('barApi');
  });

  it('registers Linear Work after a successful server-side LobeHub Skill tool call', async () => {
    mocks.executeLobehubSkill.mockResolvedValueOnce({
      content: JSON.stringify({
        id: 'LOBE-10966',
        status: 'In Progress',
        title: 'Linear Work issue',
        url: 'https://linear.app/lobehub/issue/LOBE-10966/linear-work-issue',
      }),
      success: true,
    });

    const result = await executor.execute(
      {
        apiName: 'save_issue',
        arguments: '{"id":"LOBE-10966","state":"In Progress"}',
        id: 'tool-call-linear',
        identifier: 'linear',
        source: 'lobehubSkill',
        type: 'default' as any,
      },
      {
        ...context,
        agentId: 'agent-1',
        operationId: 'op-child',
        rootOperationId: 'op-root',
        serverDB: {} as NonNullable<ToolExecutionContext['serverDB']>,
        threadId: 'thread-1',
        toolCallId: 'tool-call-linear',
        toolMessageId: 'msg-tool-linear',
        topicId: 'topic-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
      },
    );

    expect(result.success).toBe(true);
    expect(mocks.executeLobehubSkill).toHaveBeenCalledWith({
      args: { id: 'LOBE-10966', state: 'In Progress' },
      context: { topicId: 'topic-1' },
      provider: 'linear',
      toolName: 'save_issue',
    });
    expect(mocks.handleSkillToolResult).toHaveBeenCalledWith({
      actorAgentId: 'agent-1',
      args: { id: 'LOBE-10966', state: 'In Progress' },
      data: {
        id: 'LOBE-10966',
        status: 'In Progress',
        title: 'Linear Work issue',
        url: 'https://linear.app/lobehub/issue/LOBE-10966/linear-work-issue',
      },
      provider: 'linear',
      rootOperationId: 'op-root',
      sourceMessageId: 'msg-tool-linear',
      sourceToolCallId: 'tool-call-linear',
      threadId: 'thread-1',
      toolName: 'save_issue',
      topicId: 'topic-1',
    });
  });

  it('registers GitHub Work after a successful server-side LobeHub Skill tool call', async () => {
    mocks.executeLobehubSkill.mockResolvedValueOnce({
      content: JSON.stringify({
        html_url: 'https://github.com/lobehub/lobehub/issues/123',
        node_id: 'I_kwDOJj1234',
        number: 123,
        state: 'open',
        title: 'GitHub Work issue',
      }),
      success: true,
    });

    const result = await executor.execute(
      {
        apiName: 'create_issue',
        arguments: '{"owner":"lobehub","repo":"lobehub","title":"GitHub Work issue"}',
        id: 'tool-call-github',
        identifier: 'github',
        source: 'lobehubSkill',
        type: 'default' as any,
      },
      {
        ...context,
        rootOperationId: 'op-root',
        serverDB: {} as NonNullable<ToolExecutionContext['serverDB']>,
        toolCallId: 'tool-call-github',
        toolMessageId: 'msg-tool-github',
        topicId: 'topic-1',
        userId: 'user-1',
      },
    );

    expect(result.success).toBe(true);
    expect(mocks.handleSkillToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        sourceToolCallId: 'tool-call-github',
        toolName: 'create_issue',
      }),
    );
  });

  it('does not register Work for non-adapted skill providers', async () => {
    mocks.executeLobehubSkill.mockResolvedValueOnce({
      content: JSON.stringify({ id: 'msg-1' }),
      success: true,
    });

    const result = await executor.execute(
      {
        apiName: 'send_message',
        arguments: '{}',
        id: 'tool-call-ms',
        identifier: 'microsoft',
        source: 'lobehubSkill',
        type: 'default' as any,
      },
      { ...context, topicId: 'topic-1' },
    );

    expect(result.success).toBe(true);
    expect(mocks.handleSkillToolResult).not.toHaveBeenCalled();
  });
});

describe('BuiltinToolsExecutor manifest-driven Work registration', () => {
  const executor = new BuiltinToolsExecutor({} as any, 'user-1');

  const taskContext: ToolExecutionContext = {
    agentId: 'agent-1',
    operationId: 'op-child',
    rootOperationId: 'op-root',
    serverDB: {} as NonNullable<ToolExecutionContext['serverDB']>,
    threadId: 'thread-1',
    toolCallId: 'tool-call-task',
    toolManifestMap: {},
    toolMessageId: 'msg-tool-task',
    topicId: 'topic-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
  };

  const taskPayload = (apiName: string, argsStr = '{}'): ChatToolPayload => ({
    apiName,
    arguments: argsStr,
    id: 'tool-call-task',
    identifier: 'lobe-task',
    type: 'default' as any,
  });

  beforeEach(() => {
    mocks.registerTask.mockReset().mockResolvedValue({ id: 'work-1' });
  });

  it('registers a task Work after a successful createTask, reading identity from state', async () => {
    const { getServerRuntime } = await import('../serverRuntimes');
    vi.mocked(getServerRuntime).mockResolvedValueOnce({
      createTask: vi.fn().mockResolvedValue({
        content: 'ok',
        state: { identifier: 'T-1', success: true, taskId: 'task_1' },
        success: true,
      }),
    } as any);

    const result = await executor.execute(
      taskPayload('createTask', '{"name":"A","instruction":"do"}'),
      taskContext,
    );

    expect(result.success).toBe(true);
    expect(mocks.registerTask).toHaveBeenCalledWith({
      actorAgentId: 'agent-1',
      role: 'created',
      rootOperationId: 'op-root',
      source: 'createTask',
      sourceMessageId: 'msg-tool-task',
      sourceToolCallId: 'tool-call-task',
      taskId: 'task_1',
      taskIdentifier: 'T-1',
      threadId: 'thread-1',
      topicId: 'topic-1',
    });
  });

  it('registers only the succeeded items of a partial-failure batch', async () => {
    const { getServerRuntime } = await import('../serverRuntimes');
    vi.mocked(getServerRuntime).mockResolvedValueOnce({
      createTasks: vi.fn().mockResolvedValue({
        content: 'ok',
        state: {
          failed: 1,
          results: [
            { identifier: 'T-A', name: 'A', success: true },
            { error: 'boom', name: 'B', success: false },
          ],
          succeeded: 1,
        },
        success: false,
      }),
    } as any);

    await executor.execute(taskPayload('createTasks', '{"tasks":[]}'), taskContext);

    expect(mocks.registerTask).toHaveBeenCalledTimes(1);
    expect(mocks.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'created', source: 'createTasks', taskIdentifier: 'T-A' }),
    );
  });

  it('does not register for an API without a work config', async () => {
    const { getServerRuntime } = await import('../serverRuntimes');
    vi.mocked(getServerRuntime).mockResolvedValueOnce({
      listTasks: vi.fn().mockResolvedValue({ content: 'ok', success: true }),
    } as any);

    await executor.execute(taskPayload('listTasks'), taskContext);

    expect(mocks.registerTask).not.toHaveBeenCalled();
  });

  it('does not register when the update failed (no extractable target)', async () => {
    const { getServerRuntime } = await import('../serverRuntimes');
    vi.mocked(getServerRuntime).mockResolvedValueOnce({
      editTask: vi.fn().mockResolvedValue({ content: 'Task not found', success: false }),
    } as any);

    await executor.execute(taskPayload('editTask', '{"identifier":"T-404"}'), taskContext);

    expect(mocks.registerTask).not.toHaveBeenCalled();
  });

  it('never fails the tool result when registration throws', async () => {
    const { getServerRuntime } = await import('../serverRuntimes');
    vi.mocked(getServerRuntime).mockResolvedValueOnce({
      editTask: vi.fn().mockResolvedValue({ content: 'edited', success: true }),
    } as any);
    mocks.registerTask.mockRejectedValueOnce(new Error('db down'));

    const result = await executor.execute(
      taskPayload('editTask', '{"identifier":"T-1","name":"Edited"}'),
      taskContext,
    );

    expect(result.success).toBe(true);
    expect(mocks.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'updated', source: 'editTask', taskIdentifier: 'T-1' }),
    );
  });
});
