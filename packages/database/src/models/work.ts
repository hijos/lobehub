import type {
  DeleteDocumentWorkParams,
  DocumentWorkContextVersionItem,
  DocumentWorkListItem,
  DocumentWorkSummaryItem,
  DocumentWorkVersionSnapshot,
  GithubWorkContextVersionItem,
  GithubWorkListItem,
  GithubWorkPatchField,
  GithubWorkSummaryItem,
  GithubWorkVersionSnapshot,
  LinearWorkContextVersionItem,
  LinearWorkListItem,
  LinearWorkPatchField,
  LinearWorkSummaryItem,
  LinearWorkVersionSnapshot,
  RegisterDocumentWorkParams,
  RegisterGithubWorkParams,
  RegisterLinearWorkParams,
  RegisterSkillToolResultWorkParams,
  RegisterTaskWorkParams,
  TaskItem,
  TaskWorkContextVersionItem,
  TaskWorkListItem,
  TaskWorkSummaryItem,
  TaskWorkVersionSnapshot,
  UpdateWorkVersionCumulativeUsageParams,
  WorkContextPreview,
  WorkContextVersionItem,
  WorkContextVersionMap,
  WorkItem,
  WorkListItem,
  WorkSummaryItem,
  WorkSummaryMap,
  WorkVersionItem,
  WorkVersionListItem,
  WorkVersionSnapshot,
} from '@lobechat/types';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { agentDocuments } from '../schemas/agentDocuments';
import { type DocumentItem, documents } from '../schemas/file';
import { tasks } from '../schemas/task';
import { workContexts, works, workVersions } from '../schemas/work';
import type { LobeChatDatabase } from '../type';
import { buildWorkspaceWhere } from '../utils/workspace';
import { normalizeGithubToolResult } from './work/githubToolResult';
import { normalizeLinearToolResult } from './work/linearToolResult';

const MAX_VERSION_CREATE_RETRIES = 5;
const DOCUMENT_DESCRIPTION_PREFIX_LENGTH = 120;
const VERSION_CONTEXT_ROLES = ['created', 'updated'] as const;

interface TaskWorkSummaryQueryRow {
  context: typeof workContexts.$inferSelect;
  taskDescription: TaskWorkListItem['task']['description'];
  taskPriority: TaskWorkListItem['task']['priority'];
  taskStatus: TaskWorkListItem['task']['status'];
  version: TaskWorkSummaryItem['version'];
  work: WorkItem;
}

interface DocumentWorkSummaryQueryRow {
  context: typeof workContexts.$inferSelect;
  document: DocumentWorkVersionSnapshot;
  version: DocumentWorkSummaryItem['version'];
  work: WorkItem;
}

interface LinearWorkSummaryQueryRow {
  context: typeof workContexts.$inferSelect;
  linear: LinearWorkVersionSnapshot;
  version: LinearWorkSummaryItem['version'];
  work: WorkItem;
}

interface GithubWorkSummaryQueryRow {
  context: typeof workContexts.$inferSelect;
  github: GithubWorkVersionSnapshot;
  version: GithubWorkSummaryItem['version'];
  work: WorkItem;
}

const isUniqueViolation = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const cause = error instanceof Error ? error.cause : undefined;
  const causeCode =
    typeof cause === 'object' && cause && 'code' in cause
      ? String((cause as { code?: unknown }).code)
      : '';

  return (
    code === '23505' ||
    causeCode === '23505' ||
    message.includes('23505') ||
    message.includes('duplicate') ||
    message.includes('unique')
  );
};

const normalizeTaskLookup = (value?: string) => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('task_') ? trimmed : trimmed.toUpperCase();
};

const getDocumentContentPrefix = (content: string | null) => {
  const normalized = content?.replaceAll(/\s+/g, ' ').trim();
  if (!normalized) return null;

  return normalized.length > DOCUMENT_DESCRIPTION_PREFIX_LENGTH
    ? `${normalized.slice(0, DOCUMENT_DESCRIPTION_PREFIX_LENGTH)}...`
    : normalized;
};

export class WorkModel {
  private readonly db: LobeChatDatabase;
  private readonly userId: string;
  private readonly workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.db = db;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  private ownership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, works);

  private taskOwnership = () =>
    buildWorkspaceWhere(
      { userId: this.userId, workspaceId: this.workspaceId },
      { userId: tasks.createdByUserId, workspaceId: tasks.workspaceId },
    );

  private documentOwnership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, documents);

  private agentDocumentOwnership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, agentDocuments);

  private contextOwnership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, workContexts);

  private toWorkContext = (context: typeof workContexts.$inferSelect): WorkContextPreview => ({
    createdAt: context.createdAt,
    id: context.id,
    metadata: context.metadata,
    role: context.role,
    rootOperationId: context.rootOperationId,
    source: context.source,
    sourceMessageId: context.sourceMessageId,
    sourceToolCallId: context.sourceToolCallId,
    sourceType: context.sourceType,
  });

  private taskSnapshot = (task: TaskItem): WorkVersionSnapshot => ({
    task: {
      assigneeAgentId: task.assigneeAgentId,
      assigneeUserId: task.assigneeUserId,
      automationMode: task.automationMode,
      config: task.config,
      context: task.context,
      createdByAgentId: task.createdByAgentId,
      currentTopicId: task.currentTopicId,
      description: task.description,
      editorData: task.editorData,
      error: task.error,
      heartbeatInterval: task.heartbeatInterval,
      heartbeatTimeout: task.heartbeatTimeout,
      id: task.id,
      identifier: task.identifier,
      instruction: task.instruction,
      maxTopics: task.maxTopics,
      name: task.name,
      parentTaskId: task.parentTaskId,
      priority: task.priority,
      schedulePattern: task.schedulePattern,
      scheduleTimezone: task.scheduleTimezone,
      sortOrder: task.sortOrder,
      status: task.status,
      totalTopics: task.totalTopics,
    } satisfies TaskWorkVersionSnapshot,
  });

  private documentSnapshot = (
    doc: DocumentItem,
    params: Pick<RegisterDocumentWorkParams, 'description' | 'title' | 'url'>,
  ): WorkVersionSnapshot => {
    const description =
      params.description?.trim() ||
      doc.description?.trim() ||
      getDocumentContentPrefix(doc.content);

    return {
      document: {
        description,
        id: doc.id,
        title: params.title?.trim() || doc.title,
        url: params.url ?? null,
      } satisfies DocumentWorkVersionSnapshot,
    };
  };

  private linearSnapshot = (
    params: RegisterLinearWorkParams,
    previous?: LinearWorkVersionSnapshot | null,
  ): { linear: LinearWorkVersionSnapshot } => {
    const patchFields = new Set(params.patchFields ?? []);
    const pick = <T>(field: LinearWorkPatchField, value: T | null | undefined, fallback: T) =>
      patchFields.has(field)
        ? (value ?? fallback)
        : ((previous?.[field] as T | undefined) ?? fallback);

    return {
      linear: {
        assignee: pick('assignee', params.assignee, null),
        assigneeId: pick('assigneeId', params.assigneeId, null),
        color: pick('color', params.color, null),
        content: pick('content', params.content, null),
        createdAt: pick('createdAt', params.createdAt, null),
        description: pick('description', params.description, null),
        dueDate: pick('dueDate', params.dueDate, null),
        entityType: params.resourceType === 'linear_issue' ? 'issue' : 'document',
        id: params.resourceId,
        icon: pick('icon', params.icon, null),
        identifier: pick('identifier', params.resourceIdentifier, null),
        issueId: pick('issueId', params.issueId, null),
        issueIdentifier: pick('issueIdentifier', params.issueIdentifier, null),
        labels: pick('labels', params.labels, []),
        parentId: pick('parentId', params.parentId, null),
        priority: pick('priority', params.priority, null),
        priorityValue: pick('priorityValue', params.priorityValue, null),
        project: pick('project', params.project, null),
        projectId: pick('projectId', params.projectId, null),
        slugId: pick('slugId', params.slugId, null),
        status: pick('status', params.status, null),
        statusType: pick('statusType', params.statusType, null),
        targetId: pick('targetId', params.targetId, null),
        targetIdentifier: pick('targetIdentifier', params.targetIdentifier, null),
        targetType: pick('targetType', params.targetType, null),
        team: pick('team', params.team, null),
        teamId: pick('teamId', params.teamId, null),
        title: pick('title', params.title, null),
        updatedAt: pick('updatedAt', params.updatedAt, null),
        url: pick('url', params.url, null),
      } satisfies LinearWorkVersionSnapshot,
    };
  };

  private githubSnapshot = (
    params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceId: string },
    previous?: GithubWorkVersionSnapshot | null,
  ): { github: GithubWorkVersionSnapshot } => {
    const patchFields = new Set(params.patchFields ?? []);
    // GitHub update responses can be partial (e.g. merge results); keep prior fields.
    const pick = <T>(field: GithubWorkPatchField, value: T | null | undefined, fallback: T) =>
      patchFields.has(field)
        ? (value ?? fallback)
        : ((previous?.[field] as T | undefined) ?? fallback);

    return {
      github: {
        assignees: pick('assignees', params.assignees, []),
        author: pick('author', params.author, null),
        baseRef: pick('baseRef', params.baseRef, null),
        body: pick('body', params.body, null),
        closedAt: pick('closedAt', params.closedAt, null),
        createdAt: pick('createdAt', params.createdAt, null),
        draft: pick('draft', params.draft, null),
        entityType: params.resourceType === 'github_issue' ? 'issue' : 'pull_request',
        headRef: pick('headRef', params.headRef, null),
        id: params.resourceId,
        labels: pick('labels', params.labels, []),
        merged: pick('merged', params.merged, null),
        mergedAt: pick('mergedAt', params.mergedAt, null),
        number: pick('number', params.number, null),
        repo: pick('repo', params.repo, null),
        state: pick('state', params.state, null),
        stateReason: pick('stateReason', params.stateReason, null),
        title: pick('title', params.title, null),
        updatedAt: pick('updatedAt', params.updatedAt, null),
        url: pick('url', params.url, null),
      } satisfies GithubWorkVersionSnapshot,
    };
  };

  private resolveTask = async (params: RegisterTaskWorkParams): Promise<TaskItem | null> => {
    const filters: SQL[] = [];
    const taskId = normalizeTaskLookup(params.taskId);
    const taskIdentifier = normalizeTaskLookup(params.taskIdentifier);

    if (taskId) {
      filters.push(
        taskId.startsWith('task_') ? eq(tasks.id, taskId) : eq(tasks.identifier, taskId),
      );
    }

    if (taskIdentifier) {
      filters.push(
        taskIdentifier.startsWith('task_')
          ? eq(tasks.id, taskIdentifier)
          : eq(tasks.identifier, taskIdentifier),
      );
    }

    if (filters.length === 0) return null;

    const [task] = await this.db
      .select()
      .from(tasks)
      .where(and(this.taskOwnership(), filters.length === 1 ? filters[0] : or(...filters)))
      .limit(1);

    return task ?? null;
  };

  private resolveDocument = async (
    params: Pick<RegisterDocumentWorkParams, 'agentDocumentId' | 'agentId' | 'documentId'>,
  ): Promise<DocumentItem | null> => {
    const [doc] = await this.db
      .select()
      .from(documents)
      .where(and(this.documentOwnership(), eq(documents.id, params.documentId)))
      .limit(1);

    if (!doc) return null;
    if (!params.agentDocumentId) return doc;

    const filters: SQL[] = [
      this.agentDocumentOwnership(),
      eq(agentDocuments.id, params.agentDocumentId),
      eq(agentDocuments.documentId, doc.id),
      isNull(agentDocuments.deletedAt),
      ...(params.agentId ? [eq(agentDocuments.agentId, params.agentId)] : []),
    ];

    const [agentDocument] = await this.db
      .select({ id: agentDocuments.id })
      .from(agentDocuments)
      .where(and(...filters))
      .limit(1);

    return agentDocument ? doc : null;
  };

  private taskTitle = (task: TaskItem, title?: string | null) =>
    title?.trim() || task.name?.trim() || task.identifier;

  private documentTitle = (doc: DocumentItem, title?: string | null) =>
    title?.trim() || doc.title?.trim() || doc.filename?.trim() || doc.id;

  private linearTitle = (params: RegisterLinearWorkParams, fallbackTitle?: string | null) =>
    params.title?.trim() ||
    fallbackTitle?.trim() ||
    params.resourceIdentifier?.trim() ||
    `${params.resourceType.replace('linear_', 'Linear ')} ${params.resourceId}`;

  private githubTitle = (
    params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceId: string },
    fallbackTitle?: string | null,
  ) =>
    params.title?.trim() ||
    fallbackTitle?.trim() ||
    params.resourceIdentifier?.trim() ||
    `${params.resourceType === 'github_issue' ? 'GitHub issue' : 'GitHub pull request'} ${params.resourceId}`;

  private upsertTaskWork = async (task: TaskItem, title: string): Promise<WorkItem> => {
    const values = {
      resourceId: task.id,
      resourceIdentifier: task.identifier,
      resourceType: 'task' as const,
      title,
      type: 'task' as const,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const conflict = this.workspaceId
      ? {
          target: [works.workspaceId, works.resourceType, works.resourceId],
          targetWhere: isNotNull(works.workspaceId),
        }
      : {
          target: [works.resourceType, works.resourceId, works.userId],
          targetWhere: isNull(works.workspaceId),
        };

    const [work] = await this.db
      .insert(works)
      .values(values)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          resourceIdentifier: task.identifier,
          title,
          updatedAt: new Date(),
        },
      })
      .returning();

    return work;
  };

  private upsertDocumentWork = async (doc: DocumentItem, title: string): Promise<WorkItem> => {
    const values = {
      resourceId: doc.id,
      resourceIdentifier: doc.filename,
      resourceType: 'document' as const,
      title,
      type: 'document' as const,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const conflict = this.workspaceId
      ? {
          target: [works.workspaceId, works.resourceType, works.resourceId],
          targetWhere: isNotNull(works.workspaceId),
        }
      : {
          target: [works.resourceType, works.resourceId, works.userId],
          targetWhere: isNull(works.workspaceId),
        };

    const [work] = await this.db
      .insert(works)
      .values(values)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          resourceIdentifier: doc.filename,
          title,
          updatedAt: new Date(),
        },
      })
      .returning();

    return work;
  };

  private upsertLinearWork = async (params: RegisterLinearWorkParams): Promise<WorkItem> => {
    const insertTitle = this.linearTitle(params);
    const updateTitle = params.patchFields?.includes('title') ? params.title?.trim() || null : null;
    const values = {
      resourceId: params.resourceId,
      resourceIdentifier: params.resourceIdentifier ?? null,
      resourceType: params.resourceType,
      title: insertTitle,
      type: 'linear' as const,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const conflict = this.workspaceId
      ? {
          target: [works.workspaceId, works.resourceType, works.resourceId],
          targetWhere: isNotNull(works.workspaceId),
        }
      : {
          target: [works.resourceType, works.resourceId, works.userId],
          targetWhere: isNull(works.workspaceId),
        };

    const [work] = await this.db
      .insert(works)
      .values(values)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          resourceIdentifier: sql`COALESCE(${params.resourceIdentifier ?? null}, ${works.resourceIdentifier})`,
          title: sql`COALESCE(${updateTitle}, ${works.title})`,
          updatedAt: new Date(),
        },
      })
      .returning();

    return work;
  };

  private upsertGithubWork = async (
    params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceId: string },
  ): Promise<WorkItem> => {
    const insertTitle = this.githubTitle(params);
    const updateTitle = params.patchFields?.includes('title') ? params.title?.trim() || null : null;
    const values = {
      resourceId: params.resourceId,
      resourceIdentifier: params.resourceIdentifier ?? null,
      resourceType: params.resourceType,
      title: insertTitle,
      type: 'github' as const,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const conflict = this.workspaceId
      ? {
          target: [works.workspaceId, works.resourceType, works.resourceId],
          targetWhere: isNotNull(works.workspaceId),
        }
      : {
          target: [works.resourceType, works.resourceId, works.userId],
          targetWhere: isNull(works.workspaceId),
        };

    const [work] = await this.db
      .insert(works)
      .values(values)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          resourceIdentifier: sql`COALESCE(${params.resourceIdentifier ?? null}, ${works.resourceIdentifier})`,
          title: sql`COALESCE(${updateTitle}, ${works.title})`,
          updatedAt: new Date(),
        },
      })
      .returning();

    return work;
  };

  private findById = async (workId: string): Promise<WorkItem | null> => {
    const [work] = await this.db
      .select()
      .from(works)
      .where(and(eq(works.id, workId), this.ownership()))
      .limit(1);

    return work ?? null;
  };

  private findVersionBySourceToolCall = async (
    workId: string,
    sourceToolCallId?: string | null,
  ): Promise<WorkVersionItem | null> => {
    if (!sourceToolCallId) return null;

    const [row] = await this.db
      .select({ version: workVersions })
      .from(workContexts)
      .innerJoin(workVersions, eq(workContexts.versionId, workVersions.id))
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .where(
        and(
          this.contextOwnership(),
          eq(workContexts.workId, workId),
          eq(workContexts.sourceToolCallId, sourceToolCallId),
        ),
      )
      .limit(1);

    return row?.version ?? null;
  };

  private findCurrentLinearSnapshot = async (
    workId: string,
  ): Promise<LinearWorkVersionSnapshot | null> => {
    const [row] = await this.db
      .select({
        linear: sql<LinearWorkVersionSnapshot>`${workVersions.snapshot}->'linear'`,
      })
      .from(works)
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .where(and(eq(works.id, workId), this.ownership(), eq(works.type, 'linear')))
      .limit(1);

    return row?.linear ?? null;
  };

  private findCurrentGithubSnapshot = async (
    workId: string,
  ): Promise<GithubWorkVersionSnapshot | null> => {
    const [row] = await this.db
      .select({
        github: sql<GithubWorkVersionSnapshot>`${workVersions.snapshot}->'github'`,
      })
      .from(works)
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .where(and(eq(works.id, workId), this.ownership(), eq(works.type, 'github')))
      .limit(1);

    return row?.github ?? null;
  };

  private createTaskVersion = async (
    work: WorkItem,
    task: TaskItem,
    params: RegisterTaskWorkParams,
  ): Promise<WorkVersionItem> => {
    const existing = await this.findVersionBySourceToolCall(work.id, params.sourceToolCallId);
    if (existing) return existing;

    const title = this.taskTitle(task, params.title);
    const snapshot = this.taskSnapshot(task);

    for (let attempt = 0; attempt < MAX_VERSION_CREATE_RETRIES; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const now = new Date();
          const [next] = await tx
            .select({
              version: sql<number>`COALESCE(MAX(${workVersions.version}), 0) + 1`,
            })
            .from(workVersions)
            .where(eq(workVersions.workId, work.id));

          const [version] = await tx
            .insert(workVersions)
            .values({
              contentRefType: 'inline_snapshot',
              renderType: 'task_snapshot',
              snapshot,
              title,
              version: Number(next.version),
              workId: work.id,
            })
            .returning();

          await tx.insert(workContexts).values({
            actorAgentId: params.actorAgentId ?? null,
            role: params.role,
            rootOperationId: params.rootOperationId ?? null,
            source: params.source,
            sourceMessageId: params.sourceMessageId ?? null,
            sourceToolCallId: params.sourceToolCallId ?? null,
            sourceType: params.sourceType ?? 'tool',
            threadId: params.threadId ?? null,
            topicId: params.topicId ?? null,
            userId: this.userId,
            versionId: version.id,
            workId: work.id,
            workspaceId: this.workspaceId ?? null,
          });

          await tx
            .update(works)
            .set({ currentVersionId: version.id, title, updatedAt: now })
            .where(and(eq(works.id, work.id), this.ownership()));

          return version;
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === MAX_VERSION_CREATE_RETRIES - 1) throw error;

        const existingAfterConflict = await this.findVersionBySourceToolCall(
          work.id,
          params.sourceToolCallId,
        );
        if (existingAfterConflict) return existingAfterConflict;
      }
    }

    throw new Error('Failed to create work version after max retries');
  };

  private createDocumentVersion = async (
    work: WorkItem,
    doc: DocumentItem,
    params: RegisterDocumentWorkParams,
  ): Promise<WorkVersionItem> => {
    const existing = await this.findVersionBySourceToolCall(work.id, params.sourceToolCallId);
    if (existing) return existing;

    const title = this.documentTitle(doc, params.title);
    const snapshot = this.documentSnapshot(doc, params);

    for (let attempt = 0; attempt < MAX_VERSION_CREATE_RETRIES; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const now = new Date();
          const [next] = await tx
            .select({
              version: sql<number>`COALESCE(MAX(${workVersions.version}), 0) + 1`,
            })
            .from(workVersions)
            .where(eq(workVersions.workId, work.id));

          const [version] = await tx
            .insert(workVersions)
            .values({
              contentRefType: 'inline_snapshot',
              renderType: 'document_snapshot',
              snapshot,
              title,
              version: Number(next.version),
              workId: work.id,
            })
            .returning();

          await tx.insert(workContexts).values({
            actorAgentId: params.actorAgentId ?? null,
            metadata: params.agentDocumentId ? { agentDocumentId: params.agentDocumentId } : null,
            role: params.role,
            rootOperationId: params.rootOperationId ?? null,
            source: params.source,
            sourceMessageId: params.sourceMessageId ?? null,
            sourceToolCallId: params.sourceToolCallId ?? null,
            sourceType: params.sourceType ?? 'tool',
            threadId: params.threadId ?? null,
            topicId: params.topicId ?? null,
            userId: this.userId,
            versionId: version.id,
            workId: work.id,
            workspaceId: this.workspaceId ?? null,
          });

          await tx
            .update(works)
            .set({ currentVersionId: version.id, title, updatedAt: now })
            .where(and(eq(works.id, work.id), this.ownership()));

          return version;
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === MAX_VERSION_CREATE_RETRIES - 1) throw error;

        const existingAfterConflict = await this.findVersionBySourceToolCall(
          work.id,
          params.sourceToolCallId,
        );
        if (existingAfterConflict) return existingAfterConflict;
      }
    }

    throw new Error('Failed to create document work version after max retries');
  };

  private createLinearVersion = async (
    work: WorkItem,
    params: RegisterLinearWorkParams,
  ): Promise<WorkVersionItem> => {
    const existing = await this.findVersionBySourceToolCall(work.id, params.sourceToolCallId);
    if (existing) return existing;

    const previousSnapshot = await this.findCurrentLinearSnapshot(work.id);
    // Linear update responses can be partial, e.g. { id, state }; keep prior labels/team.
    const snapshot = this.linearSnapshot(params, previousSnapshot);
    const title = snapshot.linear.title?.trim() || work.title;

    for (let attempt = 0; attempt < MAX_VERSION_CREATE_RETRIES; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const now = new Date();
          const [next] = await tx
            .select({
              version: sql<number>`COALESCE(MAX(${workVersions.version}), 0) + 1`,
            })
            .from(workVersions)
            .where(eq(workVersions.workId, work.id));

          const [version] = await tx
            .insert(workVersions)
            .values({
              contentRefType: 'inline_snapshot',
              renderType: 'linear_snapshot',
              snapshot,
              title,
              version: Number(next.version),
              workId: work.id,
            })
            .returning();

          await tx.insert(workContexts).values({
            actorAgentId: params.actorAgentId ?? null,
            role: params.role,
            rootOperationId: params.rootOperationId ?? null,
            source: params.source,
            sourceMessageId: params.sourceMessageId ?? null,
            sourceToolCallId: params.sourceToolCallId ?? null,
            sourceType: params.sourceType ?? 'tool',
            threadId: params.threadId ?? null,
            topicId: params.topicId ?? null,
            userId: this.userId,
            versionId: version.id,
            workId: work.id,
            workspaceId: this.workspaceId ?? null,
          });

          await tx
            .update(works)
            .set({ currentVersionId: version.id, title, updatedAt: now })
            .where(and(eq(works.id, work.id), this.ownership()));

          return version;
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === MAX_VERSION_CREATE_RETRIES - 1) throw error;

        const existingAfterConflict = await this.findVersionBySourceToolCall(
          work.id,
          params.sourceToolCallId,
        );
        if (existingAfterConflict) return existingAfterConflict;
      }
    }

    throw new Error('Failed to create linear work version after max retries');
  };

  private createGithubVersion = async (
    work: WorkItem,
    params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceId: string },
  ): Promise<WorkVersionItem> => {
    const existing = await this.findVersionBySourceToolCall(work.id, params.sourceToolCallId);
    if (existing) return existing;

    const previousSnapshot = await this.findCurrentGithubSnapshot(work.id);
    const snapshot = this.githubSnapshot(params, previousSnapshot);
    const title = snapshot.github.title?.trim() || work.title;

    for (let attempt = 0; attempt < MAX_VERSION_CREATE_RETRIES; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const now = new Date();
          const [next] = await tx
            .select({
              version: sql<number>`COALESCE(MAX(${workVersions.version}), 0) + 1`,
            })
            .from(workVersions)
            .where(eq(workVersions.workId, work.id));

          const [version] = await tx
            .insert(workVersions)
            .values({
              contentRefType: 'inline_snapshot',
              renderType: 'github_snapshot',
              snapshot,
              title,
              version: Number(next.version),
              workId: work.id,
            })
            .returning();

          await tx.insert(workContexts).values({
            actorAgentId: params.actorAgentId ?? null,
            role: params.role,
            rootOperationId: params.rootOperationId ?? null,
            source: params.source,
            sourceMessageId: params.sourceMessageId ?? null,
            sourceToolCallId: params.sourceToolCallId ?? null,
            sourceType: params.sourceType ?? 'tool',
            threadId: params.threadId ?? null,
            topicId: params.topicId ?? null,
            userId: this.userId,
            versionId: version.id,
            workId: work.id,
            workspaceId: this.workspaceId ?? null,
          });

          await tx
            .update(works)
            .set({ currentVersionId: version.id, title, updatedAt: now })
            .where(and(eq(works.id, work.id), this.ownership()));

          return version;
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === MAX_VERSION_CREATE_RETRIES - 1) throw error;

        const existingAfterConflict = await this.findVersionBySourceToolCall(
          work.id,
          params.sourceToolCallId,
        );
        if (existingAfterConflict) return existingAfterConflict;
      }
    }

    throw new Error('Failed to create github work version after max retries');
  };

  registerTask = async (params: RegisterTaskWorkParams): Promise<WorkItem | null> => {
    const task = await this.resolveTask(params);
    if (!task) return null;

    const title = this.taskTitle(task, params.title);
    const work = await this.upsertTaskWork(task, title);
    await this.createTaskVersion(work, task, params);

    return this.findById(work.id);
  };

  registerDocument = async (params: RegisterDocumentWorkParams): Promise<WorkItem | null> => {
    const doc = await this.resolveDocument(params);
    if (!doc) return null;

    const title = this.documentTitle(doc, params.title);
    const work = await this.upsertDocumentWork(doc, title);
    await this.createDocumentVersion(work, doc, params);

    return this.findById(work.id);
  };

  registerLinear = async (params: RegisterLinearWorkParams): Promise<WorkItem | null> => {
    const work = await this.upsertLinearWork(params);
    await this.createLinearVersion(work, params);

    return this.findById(work.id);
  };

  registerGithub = async (
    params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceId: string },
  ): Promise<WorkItem | null> => {
    const work = await this.upsertGithubWork(params);
    await this.createGithubVersion(work, params);

    return this.findById(work.id);
  };

  /**
   * Append a version to an existing GitHub work matched by `owner/repo#number`.
   * Used when a tool result lacks a stable GitHub id — a new Work row is never
   * created in that case (LOBE-10967 acceptance criteria).
   */
  private appendGithubByIdentifier = async (
    params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceIdentifier: string },
  ): Promise<WorkItem | null> => {
    const [work] = await this.db
      .select()
      .from(works)
      .where(
        and(
          this.ownership(),
          eq(works.type, 'github'),
          eq(works.resourceType, params.resourceType),
          eq(works.resourceIdentifier, params.resourceIdentifier),
        ),
      )
      .orderBy(desc(works.updatedAt))
      .limit(1);
    if (!work) return null;

    await this.createGithubVersion(work, { ...params, resourceId: work.resourceId });

    return this.findById(work.id);
  };

  private handleGithubToolResult = async (
    params: Omit<RegisterSkillToolResultWorkParams, 'provider'>,
  ): Promise<WorkItem | null> => {
    const operation = normalizeGithubToolResult(params);
    if (!operation) return null;

    return operation.type === 'register'
      ? this.registerGithub(operation.params)
      : this.appendGithubByIdentifier(operation.params);
  };

  handleSkillToolResult = async (
    params: RegisterSkillToolResultWorkParams,
  ): Promise<WorkItem | null> => {
    const { provider, ...rest } = params;

    switch (provider) {
      case 'github': {
        return this.handleGithubToolResult(rest);
      }

      case 'linear': {
        const operation = normalizeLinearToolResult(rest);
        if (!operation) return null;

        return this.registerLinear(operation.params);
      }

      default: {
        return null;
      }
    }
  };

  deleteDocumentWork = async (params: DeleteDocumentWorkParams): Promise<void> => {
    const [doc] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(this.documentOwnership(), eq(documents.id, params.documentId)))
      .limit(1);
    if (!doc) return;

    await this.db
      .delete(works)
      .where(
        and(this.ownership(), eq(works.resourceType, 'document'), eq(works.resourceId, doc.id)),
      );
  };

  attachSourceMessage = async (params: {
    rootOperationId?: string | null;
    sourceMessageId?: string | null;
    sourceToolCallId?: string | null;
  }) => {
    if (!params.sourceMessageId || !params.sourceToolCallId) return;

    const filters = [
      this.contextOwnership(),
      eq(workContexts.sourceToolCallId, params.sourceToolCallId),
      isNull(workContexts.sourceMessageId),
    ];
    if (params.rootOperationId) {
      filters.push(eq(workContexts.rootOperationId, params.rootOperationId));
    }

    await this.db
      .update(workContexts)
      .set({ sourceMessageId: params.sourceMessageId })
      .where(and(...filters));
  };

  updateVersionCumulativeUsage = async (params: UpdateWorkVersionCumulativeUsageParams) => {
    if (!params.rootOperationId || !params.sourceToolCallId) return;

    const updates: Partial<typeof workVersions.$inferInsert> = {};
    if (params.cumulativeCost !== undefined) updates.cumulativeCost = params.cumulativeCost;
    if (params.cumulativeUsage !== undefined) updates.cumulativeUsage = params.cumulativeUsage;
    if (Object.keys(updates).length === 0) return;

    const rows = await this.db
      .select({ versionId: workContexts.versionId })
      .from(workContexts)
      .where(
        and(
          this.contextOwnership(),
          eq(workContexts.rootOperationId, params.rootOperationId),
          eq(workContexts.sourceToolCallId, params.sourceToolCallId),
          isNotNull(workContexts.versionId),
        ),
      );

    const versionIds = rows
      .map((row) => row.versionId)
      .filter((versionId): versionId is string => !!versionId);
    if (versionIds.length === 0) return;

    await this.db.update(workVersions).set(updates).where(inArray(workVersions.id, versionIds));
  };

  private listTaskContextVersions = async (
    filters: SQL[],
    limit = 20,
  ): Promise<TaskWorkContextVersionItem[]> => {
    const rows = await this.db
      .select({
        context: workContexts,
        taskDescription: sql<string | null>`${workVersions.snapshot}->'task'->>'description'`,
        taskPriority: tasks.priority,
        taskStatus: tasks.status,
        version: {
          createdAt: workVersions.createdAt,
          cumulativeCost: workVersions.cumulativeCost,
          id: workVersions.id,
          title: workVersions.title,
          version: workVersions.version,
        },
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(workContexts.versionId, workVersions.id))
      .innerJoin(
        tasks,
        and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), this.taskOwnership()),
      )
      .where(
        and(
          this.contextOwnership(),
          ...filters,
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
          eq(works.type, 'task'),
        ),
      )
      .orderBy(desc(workContexts.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row.work,
      context: this.toWorkContext(row.context),
      resourceType: 'task' as const,
      task: {
        description: row.taskDescription,
        priority: row.taskPriority,
        status: row.taskStatus,
      },
      type: 'task' as const,
      version: row.version,
    }));
  };

  private listDocumentContextVersions = async (
    filters: SQL[],
    limit = 20,
  ): Promise<DocumentWorkContextVersionItem[]> => {
    const rows = await this.db
      .select({
        context: workContexts,
        document: sql<DocumentWorkVersionSnapshot>`${workVersions.snapshot}->'document'`,
        version: {
          createdAt: workVersions.createdAt,
          cumulativeCost: workVersions.cumulativeCost,
          id: workVersions.id,
          title: workVersions.title,
          version: workVersions.version,
        },
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(workContexts.versionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          ...filters,
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
          eq(works.type, 'document'),
        ),
      )
      .orderBy(desc(workContexts.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row.work,
      context: this.toWorkContext(row.context),
      document: row.document,
      resourceType: 'document' as const,
      type: 'document' as const,
      version: row.version,
    }));
  };

  private listLinearContextVersions = async (
    filters: SQL[],
    limit = 20,
  ): Promise<LinearWorkContextVersionItem[]> => {
    const rows = await this.db
      .select({
        context: workContexts,
        linear: sql<LinearWorkVersionSnapshot>`${workVersions.snapshot}->'linear'`,
        version: {
          createdAt: workVersions.createdAt,
          cumulativeCost: workVersions.cumulativeCost,
          id: workVersions.id,
          title: workVersions.title,
          version: workVersions.version,
        },
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(workContexts.versionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          ...filters,
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
          eq(works.type, 'linear'),
        ),
      )
      .orderBy(desc(workContexts.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row.work,
      context: this.toWorkContext(row.context),
      linear: row.linear,
      resourceType: row.work.resourceType as LinearWorkListItem['resourceType'],
      type: 'linear' as const,
      version: row.version,
    }));
  };

  private listGithubContextVersions = async (
    filters: SQL[],
    limit = 20,
  ): Promise<GithubWorkContextVersionItem[]> => {
    const rows = await this.db
      .select({
        context: workContexts,
        github: sql<GithubWorkVersionSnapshot>`${workVersions.snapshot}->'github'`,
        version: {
          createdAt: workVersions.createdAt,
          cumulativeCost: workVersions.cumulativeCost,
          id: workVersions.id,
          title: workVersions.title,
          version: workVersions.version,
        },
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(workContexts.versionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          ...filters,
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
          eq(works.type, 'github'),
        ),
      )
      .orderBy(desc(workContexts.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row.work,
      context: this.toWorkContext(row.context),
      github: row.github,
      resourceType: row.work.resourceType as GithubWorkListItem['resourceType'],
      type: 'github' as const,
      version: row.version,
    }));
  };

  listByRootOperation = async (params: {
    limit?: number;
    rootOperationId?: string | null;
  }): Promise<WorkContextVersionItem[]> => {
    if (!params.rootOperationId) return [];

    const map = await this.listByRootOperations({
      limit: params.limit,
      rootOperationIds: [params.rootOperationId],
    });

    return map[params.rootOperationId] ?? [];
  };

  listByRootOperations = async (params: {
    limit?: number;
    rootOperationIds?: string[] | null;
  }): Promise<WorkContextVersionMap> => {
    const rootOperationIds = Array.from(
      new Set((params.rootOperationIds ?? []).filter((id): id is string => !!id)),
    ).sort();
    if (rootOperationIds.length === 0) return {};

    const limit = params.limit ?? 20;
    const result: WorkContextVersionMap = {};
    const entries = await Promise.all(
      rootOperationIds.map(async (rootOperationId) => {
        const filters = [eq(workContexts.rootOperationId, rootOperationId)];
        const [taskItems, documentItems, linearItems, githubItems] = await Promise.all([
          this.listTaskContextVersions(filters, limit),
          this.listDocumentContextVersions(filters, limit),
          this.listLinearContextVersions(filters, limit),
          this.listGithubContextVersions(filters, limit),
        ]);
        const items = [...taskItems, ...documentItems, ...linearItems, ...githubItems]
          .sort((a, b) => b.context.createdAt.getTime() - a.context.createdAt.getTime())
          .slice(0, limit);

        return [rootOperationId, items] as const;
      }),
    );

    for (const [rootOperationId, items] of entries) {
      result[rootOperationId] = items;
    }

    return result;
  };

  private getTotalCostByWorkIds = async (workIds: string[]) => {
    const ids = Array.from(new Set(workIds));
    const result = new Map<string, number | null>();
    if (ids.length === 0) return result;

    const rows = await this.db
      .select({
        costCount: sql<number>`COUNT(${workVersions.cumulativeCost})`.mapWith(Number),
        totalCost: sql<number>`COALESCE(SUM(${workVersions.cumulativeCost}), 0)`.mapWith(Number),
        workId: workVersions.workId,
      })
      .from(workVersions)
      .where(inArray(workVersions.workId, ids))
      .groupBy(workVersions.workId);

    for (const row of rows) {
      result.set(row.workId, row.costCount > 0 ? row.totalCost : null);
    }

    return result;
  };

  private listTaskWorkSummaryRows = async (
    filters: SQL[],
    rowLimit: number,
  ): Promise<TaskWorkSummaryQueryRow[]> =>
    this.db
      .select({
        context: workContexts,
        taskDescription: sql<string | null>`${workVersions.snapshot}->'task'->>'description'`,
        taskPriority: tasks.priority,
        taskStatus: tasks.status,
        version: {
          createdAt: workVersions.createdAt,
          id: workVersions.id,
          title: workVersions.title,
          version: workVersions.version,
        },
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .innerJoin(
        tasks,
        and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), this.taskOwnership()),
      )
      .where(
        and(
          this.contextOwnership(),
          ...filters,
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
          eq(works.type, 'task'),
        ),
      )
      .orderBy(desc(workContexts.createdAt), desc(works.updatedAt))
      .limit(rowLimit);

  private toTaskWorkSummaries = async (
    rows: TaskWorkSummaryQueryRow[],
  ): Promise<TaskWorkSummaryItem[]> => {
    const costByWorkId = await this.getTotalCostByWorkIds(rows.map((row) => row.work.id));

    return rows.map((row) => ({
      ...row.work,
      context: this.toWorkContext(row.context),
      resourceType: 'task' as const,
      task: {
        description: row.taskDescription,
        priority: row.taskPriority,
        status: row.taskStatus,
      },
      totalCost: costByWorkId.get(row.work.id) ?? null,
      type: 'task' as const,
      version: row.version,
    }));
  };

  private listDocumentWorkSummaryRows = async (
    filters: SQL[],
    rowLimit: number,
  ): Promise<DocumentWorkSummaryQueryRow[]> =>
    this.db
      .select({
        context: workContexts,
        document: sql<DocumentWorkVersionSnapshot>`${workVersions.snapshot}->'document'`,
        version: {
          createdAt: workVersions.createdAt,
          id: workVersions.id,
          title: workVersions.title,
          version: workVersions.version,
        },
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          ...filters,
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
          eq(works.type, 'document'),
        ),
      )
      .orderBy(desc(workContexts.createdAt), desc(works.updatedAt))
      .limit(rowLimit);

  private listLinearWorkSummaryRows = async (
    filters: SQL[],
    rowLimit: number,
  ): Promise<LinearWorkSummaryQueryRow[]> =>
    this.db
      .select({
        context: workContexts,
        linear: sql<LinearWorkVersionSnapshot>`${workVersions.snapshot}->'linear'`,
        version: {
          createdAt: workVersions.createdAt,
          id: workVersions.id,
          title: workVersions.title,
          version: workVersions.version,
        },
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          ...filters,
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
          eq(works.type, 'linear'),
        ),
      )
      .orderBy(desc(workContexts.createdAt), desc(works.updatedAt))
      .limit(rowLimit);

  private toDocumentWorkSummaries = async (
    rows: DocumentWorkSummaryQueryRow[],
  ): Promise<DocumentWorkSummaryItem[]> => {
    const costByWorkId = await this.getTotalCostByWorkIds(rows.map((row) => row.work.id));

    return rows.map((row) => ({
      ...row.work,
      context: this.toWorkContext(row.context),
      document: row.document,
      resourceType: 'document' as const,
      totalCost: costByWorkId.get(row.work.id) ?? null,
      type: 'document' as const,
      version: row.version,
    }));
  };

  private toLinearWorkSummaries = async (
    rows: LinearWorkSummaryQueryRow[],
  ): Promise<LinearWorkSummaryItem[]> => {
    const costByWorkId = await this.getTotalCostByWorkIds(rows.map((row) => row.work.id));

    return rows.map((row) => ({
      ...row.work,
      context: this.toWorkContext(row.context),
      linear: row.linear,
      resourceType: row.work.resourceType as LinearWorkSummaryItem['resourceType'],
      totalCost: costByWorkId.get(row.work.id) ?? null,
      type: 'linear' as const,
      version: row.version,
    }));
  };

  private listGithubWorkSummaryRows = async (
    filters: SQL[],
    rowLimit: number,
  ): Promise<GithubWorkSummaryQueryRow[]> =>
    this.db
      .select({
        context: workContexts,
        github: sql<GithubWorkVersionSnapshot>`${workVersions.snapshot}->'github'`,
        version: {
          createdAt: workVersions.createdAt,
          id: workVersions.id,
          title: workVersions.title,
          version: workVersions.version,
        },
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          ...filters,
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
          eq(works.type, 'github'),
        ),
      )
      .orderBy(desc(workContexts.createdAt), desc(works.updatedAt))
      .limit(rowLimit);

  private toGithubWorkSummaries = async (
    rows: GithubWorkSummaryQueryRow[],
  ): Promise<GithubWorkSummaryItem[]> => {
    const costByWorkId = await this.getTotalCostByWorkIds(rows.map((row) => row.work.id));

    return rows.map((row) => ({
      ...row.work,
      context: this.toWorkContext(row.context),
      github: row.github,
      resourceType: row.work.resourceType as GithubWorkSummaryItem['resourceType'],
      totalCost: costByWorkId.get(row.work.id) ?? null,
      type: 'github' as const,
      version: row.version,
    }));
  };

  private latestSummaryItemsByWork = (items: WorkSummaryItem[], limit?: number) => {
    const seen = new Set<string>();
    const latestItems: WorkSummaryItem[] = [];

    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      latestItems.push(item);
      if (limit && latestItems.length >= limit) break;
    }

    return latestItems;
  };

  listSummariesByRootOperations = async (params: {
    limit?: number;
    rootOperationIds?: string[] | null;
  }): Promise<WorkSummaryMap> => {
    const rootOperationIds = Array.from(
      new Set((params.rootOperationIds ?? []).filter((id): id is string => !!id)),
    ).sort();
    const result: WorkSummaryMap = Object.fromEntries(
      rootOperationIds.map((rootOperationId) => [rootOperationId, []]),
    );
    if (rootOperationIds.length === 0) return result;

    const limit = params.limit ?? 20;
    const filters = [inArray(workContexts.rootOperationId, rootOperationIds)];
    const rowLimit = rootOperationIds.length * limit * 4;
    const [taskRows, documentRows, linearRows, githubRows] = await Promise.all([
      this.listTaskWorkSummaryRows(filters, rowLimit),
      this.listDocumentWorkSummaryRows(filters, rowLimit),
      this.listLinearWorkSummaryRows(filters, rowLimit),
      this.listGithubWorkSummaryRows(filters, rowLimit),
    ]);
    const summaries = this.latestSummaryItemsByWork(
      [
        ...(await this.toTaskWorkSummaries(taskRows)),
        ...(await this.toDocumentWorkSummaries(documentRows)),
        ...(await this.toLinearWorkSummaries(linearRows)),
        ...(await this.toGithubWorkSummaries(githubRows)),
      ].sort((a, b) => b.context.createdAt.getTime() - a.context.createdAt.getTime()),
    );

    for (const summary of summaries) {
      const rootOperationId = summary.context.rootOperationId;
      if (!rootOperationId || !(rootOperationId in result)) continue;
      if (result[rootOperationId].length >= limit) continue;
      result[rootOperationId].push(summary);
    }

    return result;
  };

  listSummariesByConversation = async (params: {
    limit?: number;
    threadId?: string | null;
    topicId?: string | null;
  }): Promise<WorkSummaryItem[]> => {
    if (!params.topicId) return [];

    const limit = params.limit ?? 50;
    const threadFilter = params.threadId
      ? eq(workContexts.threadId, params.threadId)
      : isNull(workContexts.threadId);
    const filters = [eq(workContexts.topicId, params.topicId), threadFilter];
    const [taskRows, documentRows, linearRows, githubRows] = await Promise.all([
      this.listTaskWorkSummaryRows(filters, limit * 4),
      this.listDocumentWorkSummaryRows(filters, limit * 4),
      this.listLinearWorkSummaryRows(filters, limit * 4),
      this.listGithubWorkSummaryRows(filters, limit * 4),
    ]);

    return this.latestSummaryItemsByWork(
      [
        ...(await this.toTaskWorkSummaries(taskRows)),
        ...(await this.toDocumentWorkSummaries(documentRows)),
        ...(await this.toLinearWorkSummaries(linearRows)),
        ...(await this.toGithubWorkSummaries(githubRows)),
      ].sort((a, b) => b.context.createdAt.getTime() - a.context.createdAt.getTime()),
      limit,
    );
  };

  listByConversation = async (params: {
    limit?: number;
    threadId?: string | null;
    topicId?: string | null;
  }): Promise<WorkListItem[]> => {
    if (!params.topicId) return [];

    const limit = params.limit ?? 50;
    const threadFilter = params.threadId
      ? eq(workContexts.threadId, params.threadId)
      : isNull(workContexts.threadId);

    const taskRows = await this.db
      .select({
        contextCreatedAt: workContexts.createdAt,
        taskDescription: tasks.description,
        taskPriority: tasks.priority,
        taskStatus: tasks.status,
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(
        tasks,
        and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), this.taskOwnership()),
      )
      .where(
        and(
          this.contextOwnership(),
          eq(workContexts.topicId, params.topicId),
          threadFilter,
          eq(works.type, 'task'),
        ),
      )
      .orderBy(desc(workContexts.createdAt), desc(works.updatedAt))
      .limit(limit * 4);

    const documentRows = await this.db
      .select({
        contextCreatedAt: workContexts.createdAt,
        document: sql<DocumentWorkVersionSnapshot>`${workVersions.snapshot}->'document'`,
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          eq(workContexts.topicId, params.topicId),
          threadFilter,
          eq(works.type, 'document'),
        ),
      )
      .orderBy(desc(workContexts.createdAt), desc(works.updatedAt))
      .limit(limit * 4);

    const linearRows = await this.db
      .select({
        contextCreatedAt: workContexts.createdAt,
        linear: sql<LinearWorkVersionSnapshot>`${workVersions.snapshot}->'linear'`,
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          eq(workContexts.topicId, params.topicId),
          threadFilter,
          eq(works.type, 'linear'),
        ),
      )
      .orderBy(desc(workContexts.createdAt), desc(works.updatedAt))
      .limit(limit * 4);

    const githubRows = await this.db
      .select({
        contextCreatedAt: workContexts.createdAt,
        github: sql<GithubWorkVersionSnapshot>`${workVersions.snapshot}->'github'`,
        work: works,
      })
      .from(workContexts)
      .innerJoin(works, and(eq(workContexts.workId, works.id), this.ownership()))
      .innerJoin(workVersions, eq(works.currentVersionId, workVersions.id))
      .where(
        and(
          this.contextOwnership(),
          eq(workContexts.topicId, params.topicId),
          threadFilter,
          eq(works.type, 'github'),
        ),
      )
      .orderBy(desc(workContexts.createdAt), desc(works.updatedAt))
      .limit(limit * 4);

    const seen = new Set<string>();
    const items: WorkListItem[] = [];
    const rows = [
      ...taskRows.map((row) => ({
        contextCreatedAt: row.contextCreatedAt,
        item: {
          ...row.work,
          resourceType: 'task' as const,
          task: {
            description: row.taskDescription,
            priority: row.taskPriority,
            status: row.taskStatus,
          },
          type: 'task' as const,
        } satisfies TaskWorkListItem,
      })),
      ...documentRows.map((row) => ({
        contextCreatedAt: row.contextCreatedAt,
        item: {
          ...row.work,
          document: row.document,
          resourceType: 'document' as const,
          type: 'document' as const,
        } satisfies DocumentWorkListItem,
      })),
      ...linearRows.map((row) => ({
        contextCreatedAt: row.contextCreatedAt,
        item: {
          ...row.work,
          linear: row.linear,
          resourceType: row.work.resourceType as LinearWorkListItem['resourceType'],
          type: 'linear' as const,
        } satisfies LinearWorkListItem,
      })),
      ...githubRows.map((row) => ({
        contextCreatedAt: row.contextCreatedAt,
        item: {
          ...row.work,
          github: row.github,
          resourceType: row.work.resourceType as GithubWorkListItem['resourceType'],
          type: 'github' as const,
        } satisfies GithubWorkListItem,
      })),
    ].sort((a, b) => b.contextCreatedAt.getTime() - a.contextCreatedAt.getTime());

    for (const row of rows) {
      if (seen.has(row.item.id)) continue;
      seen.add(row.item.id);
      items.push(row.item);
      if (items.length >= limit) break;
    }

    return items;
  };

  listVersions = async (workId: string): Promise<WorkVersionListItem[]> => {
    const rows = await this.db
      .select({ version: workVersions })
      .from(workVersions)
      .innerJoin(works, and(eq(workVersions.workId, works.id), this.ownership()))
      .where(eq(workVersions.workId, workId))
      .orderBy(desc(workVersions.version));

    const versions = rows.map((row) => row.version);
    const versionIds = versions.map((version) => version.id);
    if (versionIds.length === 0) return [];

    const contextRows = await this.db
      .select({ context: workContexts })
      .from(workContexts)
      .where(
        and(
          this.contextOwnership(),
          inArray(workContexts.versionId, versionIds),
          inArray(workContexts.role, VERSION_CONTEXT_ROLES),
        ),
      )
      .orderBy(desc(workContexts.createdAt));

    const contextByVersionId = new Map<string, typeof workContexts.$inferSelect>();
    for (const row of contextRows) {
      if (!row.context.versionId || contextByVersionId.has(row.context.versionId)) continue;
      contextByVersionId.set(row.context.versionId, row.context);
    }

    return versions.map((version) => {
      const context = contextByVersionId.get(version.id);
      return {
        ...version,
        context: context
          ? {
              createdAt: context.createdAt,
              id: context.id,
              metadata: context.metadata,
              role: context.role,
              source: context.source,
              sourceType: context.sourceType,
            }
          : null,
      };
    });
  };
}
