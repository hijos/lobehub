import { buildAgentDocumentUrl } from '@lobechat/builtin-tool-agent-documents';

import { WorkModel } from '@/database/models/work';
import { WorkspaceModel } from '@/database/models/workspace';
import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';

const getAgentDocumentAppUrl = (): string | undefined => {
  try {
    return appEnv.APP_URL;
  } catch {
    return process.env.APP_URL;
  }
};

/** Source/operation context normalized from either the server-runtime ToolExecutionContext or the lambda router's tool-context schema. */
export interface DocumentWorkContext {
  actorAgentId?: string | null;
  rootOperationId?: string | null;
  sourceMessageId?: string | null;
  sourceToolCallId?: string | null;
  threadId?: string | null;
  topicId?: string | null;
}

/**
 * Shared best-effort Work registration for agent documents, used by both the
 * server tool runtime and the lambda `agentDocument` router so the two
 * registration paths cannot drift (field set, document URL building, error
 * handling). Failures are swallowed on purpose: Work bookkeeping must never
 * fail the document operation itself.
 *
 * The workspace slug lookup for URL building is memoized per registrar
 * instance, so create one registrar per runtime/request and reuse it.
 */
export const createDocumentWorkRegistrar = (deps: {
  db: LobeChatDatabase;
  /** Log prefix identifying the call site, e.g. '[agentDocumentsRuntime]'. */
  logPrefix: string;
  userId: string;
  workspaceId?: string | null;
}) => {
  const workModel = new WorkModel(deps.db, deps.userId, deps.workspaceId ?? undefined);
  let workspaceSlugPromise: Promise<string | undefined> | undefined;

  const resolveWorkspaceSlugForUrl = async (): Promise<string | undefined> => {
    if (!deps.workspaceId) return undefined;

    workspaceSlugPromise ??= new WorkspaceModel(deps.db, deps.userId)
      .findById(deps.workspaceId)
      .then((workspace) => workspace?.slug)
      .catch((error) => {
        console.error(`${deps.logPrefix} Failed to resolve workspace slug:`, error);
        return undefined;
      });

    return workspaceSlugPromise;
  };

  const buildRegisteredDocumentUrl = async (agentId: string, documentId?: string | null) => {
    if (!documentId) return undefined;
    const workspaceSlug = await resolveWorkspaceSlugForUrl();
    if (deps.workspaceId && !workspaceSlug) return undefined;

    return buildAgentDocumentUrl(getAgentDocumentAppUrl(), agentId, documentId, {
      workspaceSlug,
    });
  };

  const registerDocumentWork = async (input: {
    agentDocumentId?: string | null;
    agentId: string;
    context: DocumentWorkContext;
    description?: string | null;
    documentId?: string | null;
    role: 'created' | 'updated';
    source: string;
  }) => {
    if (!input.documentId) return;

    try {
      await workModel.registerDocument({
        actorAgentId: input.context.actorAgentId,
        agentDocumentId: input.agentDocumentId,
        agentId: input.agentId,
        description: input.description,
        documentId: input.documentId,
        role: input.role,
        rootOperationId: input.context.rootOperationId,
        source: input.source,
        sourceMessageId: input.context.sourceMessageId,
        sourceToolCallId: input.context.sourceToolCallId,
        threadId: input.context.threadId,
        topicId: input.context.topicId,
        url: await buildRegisteredDocumentUrl(input.agentId, input.documentId),
      });
    } catch (error) {
      console.error(
        `${deps.logPrefix} register document work failed:`,
        {
          agentDocumentId: input.agentDocumentId,
          documentId: input.documentId,
          rootOperationId: input.context.rootOperationId,
          sourceToolCallId: input.context.sourceToolCallId,
        },
        error,
      );
    }
  };

  const deleteDocumentWork = async (input: {
    agentDocumentId?: string | null;
    agentId: string;
    documentId?: string | null;
  }) => {
    if (!input.documentId) return;

    try {
      await workModel.deleteDocumentWork({
        agentDocumentId: input.agentDocumentId,
        agentId: input.agentId,
        documentId: input.documentId,
      });
    } catch (error) {
      console.error(
        `${deps.logPrefix} delete document work failed:`,
        {
          agentDocumentId: input.agentDocumentId,
          documentId: input.documentId,
        },
        error,
      );
    }
  };

  return { buildRegisteredDocumentUrl, deleteDocumentWork, registerDocumentWork };
};

export type DocumentWorkRegistrar = ReturnType<typeof createDocumentWorkRegistrar>;
