import type { DocumentLoadFormat, DocumentLoadRule } from '@lobechat/agent-templates';
import { buildAgentDocumentUrl } from '@lobechat/builtin-tool-agent-documents';
import { AgentDocumentsExecutionRuntime } from '@lobechat/builtin-tool-agent-documents/executionRuntime';
import { AgentDocumentsExecutor } from '@lobechat/builtin-tool-agent-documents/executor';
import { isDesktop } from '@lobechat/const';

import { getActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { agentDocumentService } from '@/services/agentDocument';
import { invalidateDocumentMutation } from '@/services/document/invalidation';
import { workService } from '@/services/work';
import { useAgentStore } from '@/store/agent';
import { useElectronStore } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';

interface DocumentWorkRefreshContext {
  operationId?: string;
  rootOperationId?: string;
  threadId?: string | null;
  topicId?: string;
}

/**
 * App origin for share links. Desktop points at the connected remote server so
 * the link opens the cloud app; web uses the current origin.
 */
const getAppOrigin = (): string | undefined => {
  if (isDesktop) return electronSyncSelectors.remoteServerUrl(useElectronStore.getState());
  return typeof window === 'undefined' ? undefined : window.location.origin;
};

const refreshDocumentWorks = async (context?: DocumentWorkRefreshContext) => {
  if (!context) return;

  const rootOperationId = context.rootOperationId ?? context.operationId;
  await Promise.all([
    workService.refreshConversation(context.topicId, context.threadId),
    workService.refreshRootOperation(rootOperationId),
  ]).catch((error) => {
    console.error('[AgentDocumentsExecutor] refresh document works failed:', error);
  });
};

const withWorkRefresh = async <T>(operation: Promise<T>, context?: DocumentWorkRefreshContext) => {
  const result = await operation;
  await refreshDocumentWorks(context);
  return result;
};

const runtime = new AgentDocumentsExecutionRuntime(
  {
    copyDocument: ({ agentId, id, newTitle, toolContext, trigger }) =>
      withWorkRefresh(
        agentDocumentService.copyDocument({ agentId, id, newTitle, toolContext, trigger }),
        toolContext,
      ),
    createDocument: ({ agentId, content, hintIsSkill, title, toolContext, trigger }) =>
      withWorkRefresh(
        agentDocumentService.createDocument({
          agentId,
          content,
          hintIsSkill,
          title,
          toolContext,
          trigger,
        }),
        toolContext,
      ),
    createTopicDocument: ({
      agentId,
      content,
      hintIsSkill,
      title,
      toolContext,
      topicId,
      trigger,
    }) =>
      withWorkRefresh(
        agentDocumentService.createForTopic({
          agentId,
          content,
          hintIsSkill,
          title,
          toolContext,
          topicId,
          trigger,
        }),
        toolContext,
      ),
    listDocuments: async ({ agentId, parentId, sourceType }) => {
      // The agent listing tool surfaces archived `.tool-results` so the model can
      // discover them; user-facing lists keep the default (filtered) behavior.
      const docs = await agentDocumentService.listDocuments({
        agentId,
        includeArchivedToolResults: true,
        parentId,
        sourceType,
      });
      return docs.map((d) => ({
        documentId: d.documentId,
        filename: d.filename,
        id: d.id,
        title: d.title,
      }));
    },
    listTopicDocuments: async ({ agentId, parentId, sourceType, topicId }) => {
      const docs = await agentDocumentService.listDocuments({
        agentId,
        includeArchivedToolResults: true,
        parentId,
        scope: 'currentTopic',
        sourceType,
        topicId,
      });
      return docs.map((d) => ({
        documentId: d.documentId,
        filename: d.filename,
        id: d.id,
        title: d.title,
      }));
    },
    modifyNodes: ({ agentId, id, operations, toolContext, trigger }) =>
      withWorkRefresh(
        agentDocumentService.modifyNodes({ agentId, id, operations, toolContext, trigger }),
        toolContext,
      ),
    readDocument: ({ agentId, format, id }) =>
      agentDocumentService.readDocument({ agentId, format: format ?? 'xml', id }),
    removeDocument: async ({ agentId, id, toolContext, trigger }) =>
      (
        await withWorkRefresh(
          agentDocumentService.removeDocument({ agentId, id, toolContext, trigger }),
          toolContext,
        )
      ).deleted,
    renameDocument: ({ agentId, id, newTitle, toolContext, trigger }) =>
      withWorkRefresh(
        agentDocumentService.renameDocument({ agentId, id, newTitle, toolContext, trigger }),
        toolContext,
      ),
    replaceDocumentContent: ({ agentId, content, id, toolContext, trigger }) =>
      withWorkRefresh(
        agentDocumentService.replaceDocumentContent({ agentId, content, id, toolContext, trigger }),
        toolContext,
      ),
    updateLoadRule: ({ agentId, id, rule }) =>
      agentDocumentService.updateLoadRule({
        agentId,
        id,
        rule: {
          ...rule,
          policyLoadFormat: rule.policyLoadFormat as DocumentLoadFormat | undefined,
          rule: rule.rule as DocumentLoadRule | undefined,
        },
      }),
  },
  {
    getDocumentUrl: ({ agentId, documentId }) =>
      buildAgentDocumentUrl(getAppOrigin(), agentId, documentId, {
        workspaceSlug: getActiveWorkspaceSlug(),
      }),
    // Revalidate the documents list after the agent mutates it. `onAfterCall`
    // carries no agentId, so resolve the active chat agent — the one whose run
    // just produced the tool call. Covers the server-runtime path where the
    // client service layer never invalidates.
    onDocumentsMutated: async () => {
      const agentId = useAgentStore.getState().activeAgentId;
      if (!agentId) return;
      await invalidateDocumentMutation({ agentId, cause: 'agent-document' });
    },
  },
);

export const agentDocumentsExecutor = new AgentDocumentsExecutor(runtime);
