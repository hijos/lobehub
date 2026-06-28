import type {
  RegisterTaskWorkParams,
  TaskItem,
  TaskWorkContextVersionItem,
  TaskWorkListItem,
  TaskWorkVersionSnapshot,
  WorkItem,
  WorkVersionItem,
  WorkVersionListItem,
  WorkVersionSnapshot,
} from '@lobechat/types';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { tasks } from '../schemas/task';
import { workContexts, works, workVersions } from '../schemas/work';
import type { LobeChatDatabase } from '../type';
import { buildWorkspaceWhere } from '../utils/workspace';

const MAX_VERSION_CREATE_RETRIES = 5;
const VERSION_CONTEXT_ROLES = ['created', 'updated'] as const;

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

  private contextOwnership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, workContexts);

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

  private taskTitle = (task: TaskItem, title?: string | null) =>
    title?.trim() || task.name?.trim() || task.identifier;

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
            displayAnchorAssistantMessageId: params.displayAnchorAssistantMessageId ?? null,
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

  registerTask = async (params: RegisterTaskWorkParams): Promise<WorkItem | null> => {
    const task = await this.resolveTask(params);
    if (!task) return null;

    const title = this.taskTitle(task, params.title);
    const work = await this.upsertTaskWork(task, title);
    await this.createTaskVersion(work, task, params);

    return this.findById(work.id);
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

  attachDisplayAnchorAssistantMessage = async (params: {
    displayAnchorAssistantMessageId?: string | null;
    rootOperationId?: string | null;
  }) => {
    if (!params.displayAnchorAssistantMessageId || !params.rootOperationId) return;

    await this.db
      .update(workContexts)
      .set({ displayAnchorAssistantMessageId: params.displayAnchorAssistantMessageId })
      .where(
        and(
          this.contextOwnership(),
          eq(workContexts.rootOperationId, params.rootOperationId),
          eq(workContexts.sourceType, 'tool'),
          isNull(workContexts.displayAnchorAssistantMessageId),
        ),
      );
  };

  private listTaskContextVersions = async (
    filters: SQL[],
    limit = 20,
  ): Promise<TaskWorkContextVersionItem[]> => {
    const rows = await this.db
      .select({
        context: workContexts,
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
      context: {
        createdAt: row.context.createdAt,
        displayAnchorAssistantMessageId: row.context.displayAnchorAssistantMessageId,
        id: row.context.id,
        role: row.context.role,
        rootOperationId: row.context.rootOperationId,
        source: row.context.source,
        sourceMessageId: row.context.sourceMessageId,
        sourceToolCallId: row.context.sourceToolCallId,
        sourceType: row.context.sourceType,
      },
      task: {
        priority: row.taskPriority,
        status: row.taskStatus,
      },
      version: row.version,
    }));
  };

  listByDisplayAnchorAssistantMessage = async (params: {
    displayAnchorAssistantMessageId?: string | null;
    displayAnchorAssistantMessageIds?: string[] | null;
    limit?: number;
  }): Promise<TaskWorkContextVersionItem[]> => {
    const messageIds = Array.from(
      new Set(
        [
          ...(params.displayAnchorAssistantMessageIds ?? []),
          params.displayAnchorAssistantMessageId,
        ].filter(Boolean) as string[],
      ),
    );
    if (messageIds.length === 0) return [];

    return this.listTaskContextVersions(
      [
        messageIds.length === 1
          ? eq(workContexts.displayAnchorAssistantMessageId, messageIds[0])
          : inArray(workContexts.displayAnchorAssistantMessageId, messageIds),
      ],
      params.limit ?? 20,
    );
  };

  listByRootOperation = async (params: {
    limit?: number;
    rootOperationId?: string | null;
  }): Promise<TaskWorkContextVersionItem[]> => {
    if (!params.rootOperationId) return [];

    return this.listTaskContextVersions(
      [eq(workContexts.rootOperationId, params.rootOperationId)],
      params.limit ?? 20,
    );
  };

  listByConversation = async (params: {
    limit?: number;
    threadId?: string | null;
    topicId?: string | null;
  }): Promise<TaskWorkListItem[]> => {
    if (!params.topicId) return [];

    const limit = params.limit ?? 50;
    const threadFilter = params.threadId
      ? eq(workContexts.threadId, params.threadId)
      : isNull(workContexts.threadId);

    const rows = await this.db
      .select({
        contextCreatedAt: workContexts.createdAt,
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

    const seen = new Set<string>();
    const items: TaskWorkListItem[] = [];

    for (const row of rows) {
      if (seen.has(row.work.id)) continue;
      seen.add(row.work.id);
      items.push({
        ...row.work,
        task: {
          priority: row.taskPriority,
          status: row.taskStatus,
        },
      });
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
              role: context.role,
              source: context.source,
              sourceType: context.sourceType,
            }
          : null,
      };
    });
  };
}
