import type { TaskAutomationMode, TaskStatus } from './task';

export type WorkType = 'task';
export type WorkStatus = 'archived' | 'draft' | 'published';
export type WorkVisibility = 'private' | 'public' | 'workspace';
export type WorkResourceType = 'task';
export type WorkRenderType = 'task_snapshot';
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

export interface WorkVersionSnapshot {
  task: TaskWorkVersionSnapshot;
}

export interface WorkVersionMetadata {
  changeSummary?: string;
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
  agentId: string | null;
  createdAt: Date;
  id: string;
  messageId: string | null;
  operationId: string | null;
  role: WorkContextRole;
  source: string;
  sourceType: WorkSourceType;
  threadId: string | null;
  toolCallId: string | null;
  topicId: string | null;
  userId: string;
  versionId: string | null;
  workId: string;
  workspaceId: string | null;
}

export interface TaskWorkListItem extends WorkItem {
  task: {
    priority: number | null;
    status: TaskStatus | string | null;
  };
}

export interface WorkVersionListItem extends WorkVersionItem {
  context?: Pick<WorkContextItem, 'createdAt' | 'id' | 'role' | 'source' | 'sourceType'> | null;
}

export interface RegisterTaskWorkParams {
  agentId?: string | null;
  messageId?: string | null;
  operationId?: string | null;
  role: Extract<WorkContextRole, 'created' | 'updated'>;
  source: string;
  sourceType?: WorkSourceType;
  taskId?: string;
  taskIdentifier?: string;
  threadId?: string | null;
  title?: string | null;
  toolCallId?: string | null;
  topicId?: string | null;
}
