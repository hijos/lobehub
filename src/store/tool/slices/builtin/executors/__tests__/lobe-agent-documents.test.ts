import type { BuiltinToolContext } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentDocumentsExecutor } from '../lobe-agent-documents';

const mocks = vi.hoisted(() => ({
  copyDocument: vi.fn(),
  createDocument: vi.fn(),
  createForTopic: vi.fn(),
  listDocuments: vi.fn(),
  modifyNodes: vi.fn(),
  readDocument: vi.fn(),
  refreshConversation: vi.fn(),
  refreshRootOperation: vi.fn(),
  removeDocument: vi.fn(),
  renameDocument: vi.fn(),
  replaceDocumentContent: vi.fn(),
  updateLoadRule: vi.fn(),
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  getActiveWorkspaceSlug: vi.fn(),
}));

vi.mock('@/services/agentDocument', () => ({
  agentDocumentService: {
    copyDocument: mocks.copyDocument,
    createDocument: mocks.createDocument,
    createForTopic: mocks.createForTopic,
    listDocuments: mocks.listDocuments,
    modifyNodes: mocks.modifyNodes,
    readDocument: mocks.readDocument,
    removeDocument: mocks.removeDocument,
    renameDocument: mocks.renameDocument,
    replaceDocumentContent: mocks.replaceDocumentContent,
    updateLoadRule: mocks.updateLoadRule,
  },
}));

vi.mock('@/services/work', () => ({
  workService: {
    refreshConversation: mocks.refreshConversation,
    refreshRootOperation: mocks.refreshRootOperation,
  },
}));

describe('agentDocumentsExecutor', () => {
  const createContext = (overrides?: Partial<BuiltinToolContext>): BuiltinToolContext => ({
    agentId: 'agent-1',
    messageId: 'tool-context-key',
    operationId: 'operation-1',
    rootOperationId: 'root-operation-1',
    sourceMessageId: 'user-message-1',
    threadId: 'thread-1',
    toolCallId: 'tool-call-1',
    toolMessageId: 'tool-message-1',
    topicId: 'topic-1',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshConversation.mockResolvedValue(undefined);
    mocks.refreshRootOperation.mockResolvedValue(undefined);
  });

  it('refreshes conversation and root operation works after attributed document creation', async () => {
    mocks.createDocument.mockResolvedValue({
      documentId: 'document-1',
      id: 'agent-document-1',
      title: 'Test Document',
    });

    const result = await agentDocumentsExecutor.invoke(
      'createDocument',
      {
        content: 'Body',
        title: 'Test Document',
      },
      createContext(),
    );

    expect(result.success).toBe(true);
    expect(mocks.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        content: 'Body',
        title: 'Test Document',
        toolContext: expect.objectContaining({
          messageId: 'user-message-1',
          rootOperationId: 'root-operation-1',
          threadId: 'thread-1',
          toolCallId: 'tool-call-1',
          toolMessageId: 'tool-message-1',
          topicId: 'topic-1',
        }),
        trigger: 'tool',
      }),
    );
    expect(mocks.refreshConversation).toHaveBeenCalledWith('topic-1', 'thread-1');
    expect(mocks.refreshRootOperation).toHaveBeenCalledWith('root-operation-1');
  });
});
