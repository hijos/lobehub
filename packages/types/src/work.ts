import type { TaskAutomationMode, TaskStatus } from './task';

export type WorkType = 'document' | 'task';
export type WorkStatus = 'archived' | 'draft' | 'published';
export type WorkVisibility = 'private' | 'public' | 'workspace';
export type WorkResourceType = 'document' | 'task';
export type WorkRenderType = 'document_snapshot' | 'task_snapshot';
export type WorkContentRefType = 'file' | 'inline_snapshot' | 'storage' | 'url';
export type WorkContextRole =
  | 'created'
  | 'published'
  | 'referenced'
  | 'updated'
  | 'used_as_context';
export type WorkSourceType = 'import' | 'system' | 'tool' | 'user';

export interface TaskWorkVersionSnapshot {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  automationMode: TaskAutomationMode | null;
  config: unknown;
  context: unknown;
  createdByAgentId: string | null;
  currentTopicId: string | null;
  description: string | null;
  editorData: unknown;
  error: string | null;
  heartbeatInterval: number | null;
  heartbeatTimeout: number | null;
  id: string;
  identifier: string;
  instruction: string;
  maxTopics: number | null;
  name: string | null;
  parentTaskId: string | null;
  priority: number | null;
  schedulePattern: string | null;
  scheduleTimezone: string | null;
  sortOrder: number | null;
  status: TaskStatus | string;
  totalTopics: number | null;
}

export interface DocumentWorkVersionSnapshot {
  description: string | null;
  id: string;
  title: string | null;
  url: string | null;
}

export type WorkVersionSnapshot =
  | {
      document: DocumentWorkVersionSnapshot;
    }
  | {
      task: TaskWorkVersionSnapshot;
    };

export interface WorkContextMetadata {
  agentDocumentId?: string;
}

export interface WorkVersionMetadata {
  changeSummary?: string;
}

export interface WorkVersionCumulativeUsage {
  capturedAt: string;
  cost?: unknown;
  usage?: unknown;
}

export interface WorkItem {
  createdAt: Date;
  currentVersionId: string | null;
  id: string;
  resourceId: string;
  resourceIdentifier: string | null;
  resourceType: WorkResourceType;
  status: WorkStatus;
  title: string;
  type: WorkType;
  updatedAt: Date;
  userId: string;
  visibility: WorkVisibility;
  workspaceId: string | null;
}

export interface WorkVersionItem {
  contentRef: string | null;
  contentRefType: WorkContentRefType | null;
  createdAt: Date;
  cumulativeCost: number | null;
  cumulativeUsage: WorkVersionCumulativeUsage | null;
  id: string;
  metadata: WorkVersionMetadata | null;
  renderType: WorkRenderType;
  snapshot: WorkVersionSnapshot;
  thumbnail: string | null;
  title: string;
  version: number;
  workId: string;
}

export interface WorkContextItem {
  actorAgentId: string | null;
  createdAt: Date;
  id: string;
  metadata: WorkContextMetadata | null;
  role: WorkContextRole;
  rootOperationId: string | null;
  source: string;
  sourceMessageId: string | null;
  sourceToolCallId: string | null;
  sourceType: WorkSourceType;
  threadId: string | null;
  topicId: string | null;
  userId: string;
  versionId: string | null;
  workId: string;
  workspaceId: string | null;
}

export interface TaskWorkListItem extends WorkItem {
  resourceType: 'task';
  task: {
    description: string | null;
    priority: number | null;
    status: TaskStatus | string | null;
  };
  type: 'task';
}

export interface DocumentWorkListItem extends WorkItem {
  document: DocumentWorkVersionSnapshot;
  resourceType: 'document';
  type: 'document';
}

export type WorkListItem = DocumentWorkListItem | TaskWorkListItem;

export type WorkContextPreview = Pick<
  WorkContextItem,
  | 'createdAt'
  | 'id'
  | 'metadata'
  | 'role'
  | 'rootOperationId'
  | 'source'
  | 'sourceMessageId'
  | 'sourceToolCallId'
  | 'sourceType'
>;

export interface TaskWorkContextVersionItem extends TaskWorkListItem {
  context: WorkContextPreview;
  version: Pick<WorkVersionItem, 'createdAt' | 'cumulativeCost' | 'id' | 'title' | 'version'>;
}

export interface DocumentWorkContextVersionItem extends DocumentWorkListItem {
  context: WorkContextPreview;
  version: Pick<WorkVersionItem, 'createdAt' | 'cumulativeCost' | 'id' | 'title' | 'version'>;
}

export type WorkContextVersionItem = DocumentWorkContextVersionItem | TaskWorkContextVersionItem;
export type TaskWorkContextVersionMap = Record<string, TaskWorkContextVersionItem[]>;
export type WorkContextVersionMap = Record<string, WorkContextVersionItem[]>;

export interface TaskWorkSummaryItem extends TaskWorkListItem {
  context: WorkContextPreview;
  totalCost: number | null;
  version: Pick<WorkVersionItem, 'createdAt' | 'id' | 'title' | 'version'> | null;
}

export interface DocumentWorkSummaryItem extends DocumentWorkListItem {
  context: WorkContextPreview;
  totalCost: number | null;
  version: Pick<WorkVersionItem, 'createdAt' | 'id' | 'title' | 'version'> | null;
}

export type WorkSummaryItem = DocumentWorkSummaryItem | TaskWorkSummaryItem;
export type TaskWorkSummaryMap = Record<string, TaskWorkSummaryItem[]>;
export type WorkSummaryMap = Record<string, WorkSummaryItem[]>;

export interface WorkVersionListItem extends WorkVersionItem {
  context?: Pick<
    WorkContextItem,
    'createdAt' | 'id' | 'metadata' | 'role' | 'source' | 'sourceType'
  > | null;
}

export interface RegisterDocumentWorkParams {
  actorAgentId?: string | null;
  agentDocumentId?: string | null;
  agentId?: string | null;
  description?: string | null;
  documentId: string;
  role: Extract<WorkContextRole, 'created' | 'updated'>;
  rootOperationId?: string | null;
  source: string;
  sourceMessageId?: string | null;
  sourceToolCallId?: string | null;
  sourceType?: WorkSourceType;
  threadId?: string | null;
  title?: string | null;
  topicId?: string | null;
  url?: string | null;
}

export interface DeleteDocumentWorkParams {
  agentDocumentId?: string | null;
  agentId?: string | null;
  documentId: string;
}

export interface RegisterTaskWorkParams {
  actorAgentId?: string | null;
  role: Extract<WorkContextRole, 'created' | 'updated'>;
  rootOperationId?: string | null;
  source: string;
  sourceMessageId?: string | null;
  sourceToolCallId?: string | null;
  sourceType?: WorkSourceType;
  taskId?: string;
  taskIdentifier?: string;
  threadId?: string | null;
  title?: string | null;
  topicId?: string | null;
}

export interface UpdateWorkVersionCumulativeUsageParams {
  cumulativeCost?: number | null;
  cumulativeUsage?: WorkVersionCumulativeUsage | null;
  rootOperationId?: string | null;
  sourceToolCallId?: string | null;
}
