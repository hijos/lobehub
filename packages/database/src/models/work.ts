import type {
  DeleteDocumentWorkParams,
  DeleteTaskWorkParams,
  DocumentWorkListItem,
  DocumentWorkSummaryItem,
  DocumentWorkVersionEventItem,
  DocumentWorkVersionSnapshot,
  GithubWorkListItem,
  GithubWorkPatchField,
  GithubWorkSummaryItem,
  GithubWorkVersionEventItem,
  GithubWorkVersionSnapshot,
  LinearWorkListItem,
  LinearWorkPatchField,
  LinearWorkSummaryItem,
  LinearWorkVersionEventItem,
  LinearWorkVersionSnapshot,
  RegisterDocumentWorkParams,
  RegisterGithubWorkParams,
  RegisterLinearWorkParams,
  RegisterSkillToolResultWorkParams,
  RegisterTaskWorkParams,
  TaskItem,
  TaskWorkListItem,
  TaskWorkSummaryItem,
  TaskWorkVersionEventItem,
  TaskWorkVersionSnapshot,
  UpdateWorkVersionCumulativeUsageParams,
  WorkItem,
  WorkListItem,
  WorkSummaryItem,
  WorkSummaryMap,
  WorkVersionEventItem,
  WorkVersionEventMap,
  WorkVersionItem,
  WorkVersionPreview,
  WorkVersionSnapshot,
} from '@lobechat/types';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { agentDocuments } from '../schemas/agentDocuments';
import { type DocumentItem, documents } from '../schemas/file';
import { tasks } from '../schemas/task';
import { works, workVersions } from '../schemas/work';
import type { LobeChatDatabase } from '../type';
import { buildWorkspaceWhere } from '../utils/workspace';
import { normalizeGithubToolResult } from './work/githubToolResult';
import { normalizeLinearToolResult } from './work/linearToolResult';

const MAX_VERSION_CREATE_RETRIES = 5;
const DOCUMENT_DESCRIPTION_PREFIX_LENGTH = 120;
/**
 * Over-fetch multiplier for list/summary queries: one per Work provider type
 * (task / document / linear / github). Rows are fetched per type and deduped
 * to the latest item per work in JS, so each query over-fetches by this factor
 * before results are trimmed back down to `limit`.
 */
const WORK_TYPE_FANOUT = 4;
/**
 * Hard ceiling for the summary-row over-fetch LIMIT: `rootOperationIds` length
 * is caller-controlled (the tRPC schema caps only `limit`), so without a clamp
 * a long conversation's batched ids would inflate the per-type ORDER-BY
 * queries and the matching in-memory sort far beyond the final capped result.
 */
const MAX_SUMMARY_ROW_LIMIT = 1000;

/**
 * Second reference to `work_versions` for summary/list queries that both
 * filter by the mutation event (topicId / rootOperationId on the event row)
 * and render the Work's current content (works.currentVersionId join).
 */
const currentVersions = alias(workVersions, 'current_work_versions');

/** Provenance fields shared by all four Register*WorkParams shapes. */
type WorkVersionEventParams = Pick<
  RegisterTaskWorkParams,
  | 'actorAgentId'
  | 'role'
  | 'rootOperationId'
  | 'source'
  | 'sourceMessageId'
  | 'sourceToolCallId'
  | 'threadId'
  | 'topicId'
>;

/** Provider-specific inputs for one work-version insert attempt. */
interface CreateVersionInput {
  metadata?: (typeof workVersions.$inferInsert)['metadata'];
  snapshot: WorkVersionSnapshot;
}

/** Event-version columns embedded in list/summary rows (`WorkVersionPreview`). */
const versionEventSelection = {
  createdAt: workVersions.createdAt,
  cumulativeCost: workVersions.cumulativeCost,
  id: workVersions.id,
  metadata: workVersions.metadata,
  role: workVersions.role,
  rootOperationId: workVersions.rootOperationId,
  source: workVersions.source,
  sourceMessageId: workVersions.sourceMessageId,
  sourceToolCallId: workVersions.sourceToolCallId,
  version: workVersions.version,
};

interface TaskWorkSummaryQueryRow {
  event: WorkVersionPreview;
  taskDeleted: TaskWorkListItem['taskDeleted'];
  taskDescription: TaskWorkListItem['task']['description'];
  taskName: TaskWorkListItem['task']['name'];
  taskPriority: TaskWorkListItem['task']['priority'];
  taskStatus: TaskWorkListItem['task']['status'];
  version: TaskWorkSummaryItem['version'];
  work: WorkItem;
}

/**
 * Work types whose list rows are fully described by the version's snapshot
 * JSON (unlike `task`, which additionally joins the tasks table).
 */
type SnapshotWorkType = 'document' | 'github' | 'linear';

interface SnapshotWorkSummaryQueryRow<Snapshot> {
  event: WorkVersionPreview;
  snapshot: Snapshot;
  version: DocumentWorkSummaryItem['version'];
  work: WorkItem;
}

/** Project the per-type snapshot object out of a version row's snapshot JSON. */
const snapshotField = <Snapshot>(
  snapshotColumn: (typeof workVersions)['snapshot'] | (typeof currentVersions)['snapshot'],
  type: SnapshotWorkType,
) => sql<Snapshot>`${snapshotColumn}->${sql.raw(`'${type}'`)}`;

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

  private versionOwnership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, workVersions);

  private taskOwnership = () =>
    buildWorkspaceWhere(
      { userId: this.userId, workspaceId: this.workspaceId },
      { userId: tasks.createdByUserId, workspaceId: tasks.workspaceId },
    );

  private documentOwnership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, documents);

  private agentDocumentOwnership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, agentDocuments);

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
    params: Pick<RegisterDocumentWorkParams, 'description' | 'url'>,
  ): WorkVersionSnapshot => {
    const description =
      params.description?.trim() ||
      doc.description?.trim() ||
      getDocumentContentPrefix(doc.content);

    return {
      document: {
        description,
        id: doc.id,
        title: doc.title,
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

  /**
   * `works` has two partial unique indexes (workspace-scoped vs personal);
   * pick the ON CONFLICT target matching this model's scope.
   */
  private resolveWorkUpsertConflict = () =>
    this.workspaceId
      ? {
          target: [works.workspaceId, works.resourceType, works.resourceId],
          targetWhere: isNotNull(works.workspaceId),
        }
      : {
          target: [works.resourceType, works.resourceId, works.userId],
          targetWhere: isNull(works.workspaceId),
        };

  private upsertTaskWork = async (task: TaskItem): Promise<WorkItem> => {
    const values = {
      resourceId: task.id,
      resourceIdentifier: task.identifier,
      resourceType: 'task' as const,
      type: 'task' as const,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const conflict = this.resolveWorkUpsertConflict();

    const [work] = await this.db
      .insert(works)
      .values(values)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          resourceIdentifier: task.identifier,
          updatedAt: new Date(),
        },
      })
      .returning();

    return work;
  };

  private upsertDocumentWork = async (doc: DocumentItem): Promise<WorkItem> => {
    const values = {
      resourceId: doc.id,
      resourceIdentifier: doc.filename,
      resourceType: 'document' as const,
      type: 'document' as const,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const conflict = this.resolveWorkUpsertConflict();

    const [work] = await this.db
      .insert(works)
      .values(values)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          resourceIdentifier: doc.filename,
          updatedAt: new Date(),
        },
      })
      .returning();

    return work;
  };

  private upsertLinearWork = async (params: RegisterLinearWorkParams): Promise<WorkItem> => {
    const values = {
      resourceId: params.resourceId,
      resourceIdentifier: params.resourceIdentifier ?? null,
      resourceType: params.resourceType,
      type: 'linear' as const,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const conflict = this.resolveWorkUpsertConflict();

    const [work] = await this.db
      .insert(works)
      .values(values)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          resourceIdentifier: sql`COALESCE(${params.resourceIdentifier ?? null}, ${works.resourceIdentifier})`,
          updatedAt: new Date(),
        },
      })
      .returning();

    return work;
  };

  private upsertGithubWork = async (
    params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceId: string },
  ): Promise<WorkItem> => {
    const values = {
      resourceId: params.resourceId,
      resourceIdentifier: params.resourceIdentifier ?? null,
      resourceType: params.resourceType,
      type: 'github' as const,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const conflict = this.resolveWorkUpsertConflict();

    const [work] = await this.db
      .insert(works)
      .values(values)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          resourceIdentifier: sql`COALESCE(${params.resourceIdentifier ?? null}, ${works.resourceIdentifier})`,
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

    const [version] = await this.db
      .select()
      .from(workVersions)
      .where(
        and(
          this.versionOwnership(),
          eq(workVersions.workId, workId),
          eq(workVersions.sourceToolCallId, sourceToolCallId),
        ),
      )
      .limit(1);

    return version ?? null;
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

  /**
   * Shared version-create pipeline: dedupe by sourceToolCallId, allocate the
   * next version number in a transaction, insert the version row, bump
   * works.currentVersionId, and retry on unique-violation races (either the
   * `(workId, version)` or the `(workId, sourceToolCallId)` unique index).
   *
   * `buildInput` runs inside every retry attempt on purpose: a retry means a
   * concurrent registration for the same Work won the version race, so inputs
   * patch-merged against the previous snapshot (linear/github) must be rebuilt
   * from the winner's committed state — reusing the pre-race merge would
   * silently revert the winner's fields.
   */
  private createVersion = async (
    work: WorkItem,
    params: WorkVersionEventParams,
    buildInput: () => CreateVersionInput | Promise<CreateVersionInput>,
  ): Promise<WorkVersionItem> => {
    const existing = await this.findVersionBySourceToolCall(work.id, params.sourceToolCallId);
    if (existing) return existing;

    for (let attempt = 0; attempt < MAX_VERSION_CREATE_RETRIES; attempt += 1) {
      const { metadata, snapshot } = await buildInput();

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
              actorAgentId: params.actorAgentId ?? null,
              metadata: metadata ?? null,
              role: params.role,
              rootOperationId: params.rootOperationId ?? null,
              snapshot,
              source: params.source,
              sourceMessageId: params.sourceMessageId ?? null,
              sourceToolCallId: params.sourceToolCallId ?? null,
              threadId: params.threadId ?? null,
              topicId: params.topicId ?? null,
              userId: this.userId,
              version: Number(next.version),
              workId: work.id,
              workspaceId: this.workspaceId ?? null,
            })
            .returning();

          await tx
            .update(works)
            .set({ currentVersionId: version.id, updatedAt: now })
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

    throw new Error(`Failed to create ${work.type} work version after max retries`);
  };

  private createTaskVersion = async (
    work: WorkItem,
    task: TaskItem,
    params: RegisterTaskWorkParams,
  ): Promise<WorkVersionItem> =>
    this.createVersion(work, params, () => ({
      snapshot: this.taskSnapshot(task),
    }));

  private createDocumentVersion = async (
    work: WorkItem,
    doc: DocumentItem,
    params: RegisterDocumentWorkParams,
  ): Promise<WorkVersionItem> =>
    this.createVersion(work, params, () => ({
      metadata: params.agentDocumentId ? { agentDocumentId: params.agentDocumentId } : null,
      snapshot: this.documentSnapshot(doc, params),
    }));

  private createLinearVersion = async (
    work: WorkItem,
    params: RegisterLinearWorkParams,
  ): Promise<WorkVersionItem> =>
    this.createVersion(work, params, async () => {
      // Re-read on every attempt (see createVersion): the patch-merge base must
      // be the race winner's committed snapshot, not the pre-race one.
      const previousSnapshot = await this.findCurrentLinearSnapshot(work.id);
      // Linear update responses can be partial, e.g. { id, state }; keep prior labels/team.
      return { snapshot: this.linearSnapshot(params, previousSnapshot) };
    });

  private createGithubVersion = async (
    work: WorkItem,
    params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceId: string },
  ): Promise<WorkVersionItem> =>
    this.createVersion(work, params, async () => {
      // Re-read on every attempt (see createVersion): the patch-merge base must
      // be the race winner's committed snapshot, not the pre-race one.
      const previousSnapshot = await this.findCurrentGithubSnapshot(work.id);
      return { snapshot: this.githubSnapshot(params, previousSnapshot) };
    });

  registerTask = async (params: RegisterTaskWorkParams): Promise<WorkItem | null> => {
    const task = await this.resolveTask(params);
    if (!task) return null;

    const work = await this.upsertTaskWork(task);
    await this.createTaskVersion(work, task, params);

    return this.findById(work.id);
  };

  registerDocument = async (params: RegisterDocumentWorkParams): Promise<WorkItem | null> => {
    const doc = await this.resolveDocument(params);
    if (!doc) return null;

    const work = await this.upsertDocumentWork(doc);
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

  handleSkillToolResult = async (
    params: RegisterSkillToolResultWorkParams,
  ): Promise<WorkItem | null> => {
    const { provider, ...rest } = params;

    switch (provider) {
      case 'github': {
        const operation = normalizeGithubToolResult(rest);
        if (!operation) return null;

        return this.registerGithub(operation.params);
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

  /**
   * Delete the task Work (and its versions via the `work_versions.workId`
   * cascade) for a task the agent removed through the deleteTask tool.
   *
   * Unlike {@link deleteDocumentWork} this does NOT re-resolve the resource
   * first: the task row is already gone by the time the tool-execution dispatch
   * layer calls this, so we can only locate the Work by its polymorphic
   * `resourceId` (= the task's internal id, captured into `result.state.taskId`
   * before deletion). Ownership still scopes the delete to the caller.
   */
  deleteTaskWork = async (params: DeleteTaskWorkParams): Promise<void> => {
    await this.db
      .delete(works)
      .where(
        and(this.ownership(), eq(works.resourceType, 'task'), eq(works.resourceId, params.taskId)),
      );
  };

  attachSourceMessage = async (params: {
    rootOperationId?: string | null;
    sourceMessageId?: string | null;
    sourceToolCallId?: string | null;
  }) => {
    if (!params.sourceMessageId || !params.sourceToolCallId) return;

    const filters = [
      this.versionOwnership(),
      eq(workVersions.sourceToolCallId, params.sourceToolCallId),
      isNull(workVersions.sourceMessageId),
    ];
    if (params.rootOperationId) {
      filters.push(eq(workVersions.rootOperationId, params.rootOperationId));
    }

    await this.db
      .update(workVersions)
      .set({ sourceMessageId: params.sourceMessageId })
      .where(and(...filters));
  };

  updateVersionCumulativeUsage = async (params: UpdateWorkVersionCumulativeUsageParams) => {
    if (!params.rootOperationId || !params.sourceToolCallId) return;

    const updates: Partial<typeof workVersions.$inferInsert> = {};
    if (params.cumulativeCost !== undefined) updates.cumulativeCost = params.cumulativeCost;
    if (params.cumulativeUsage !== undefined) updates.cumulativeUsage = params.cumulativeUsage;
    if (Object.keys(updates).length === 0) return;

    await this.db
      .update(workVersions)
      .set(updates)
      .where(
        and(
          this.versionOwnership(),
          eq(workVersions.rootOperationId, params.rootOperationId),
          eq(workVersions.sourceToolCallId, params.sourceToolCallId),
        ),
      );
  };

  private listTaskVersionEvents = async (
    filters: SQL[],
    limit = 20,
  ): Promise<TaskWorkVersionEventItem[]> => {
    const rows = await this.db
      .select({
        // A LEFT JOIN miss (deleted task) leaves the whole tasks row null; the
        // live columns below coalesce onto the version snapshot so the orphan
        // still renders, while `tasks.id is null` is the deletion signal.
        taskDeleted: sql<boolean>`${tasks.id} is null`,
        taskDescription: sql<string | null>`${workVersions.snapshot}->'task'->>'description'`,
        taskName: sql<
          string | null
        >`coalesce(${tasks.name}, ${workVersions.snapshot}->'task'->>'name')`,
        taskPriority: sql<
          number | null
        >`coalesce(${tasks.priority}, (${workVersions.snapshot}->'task'->>'priority')::integer)`,
        taskStatus: sql<
          string | null
        >`coalesce(${tasks.status}, ${workVersions.snapshot}->'task'->>'status')`,
        version: versionEventSelection,
        work: works,
      })
      .from(workVersions)
      .innerJoin(works, and(eq(workVersions.workId, works.id), this.ownership()))
      // LEFT JOIN so orphaned task Works (task deleted without the tool path)
      // still surface; deletion is derived from the missing tasks row.
      .leftJoin(
        tasks,
        and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), this.taskOwnership()),
      )
      .where(and(this.versionOwnership(), ...filters, eq(works.type, 'task')))
      .orderBy(desc(workVersions.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row.work,
      resourceType: 'task' as const,
      task: {
        description: row.taskDescription,
        name: row.taskName,
        priority: row.taskPriority,
        status: row.taskStatus,
      },
      taskDeleted: row.taskDeleted,
      type: 'task' as const,
      version: row.version,
    }));
  };

  /**
   * Shared version-event query for snapshot-backed work types; `task` keeps
   * its own variant because it additionally joins the tasks table.
   */
  private listSnapshotVersionEventRows = <Snapshot>(
    type: SnapshotWorkType,
    filters: SQL[],
    limit: number,
  ) =>
    this.db
      .select({
        snapshot: snapshotField<Snapshot>(workVersions.snapshot, type),
        version: versionEventSelection,
        work: works,
      })
      .from(workVersions)
      .innerJoin(works, and(eq(workVersions.workId, works.id), this.ownership()))
      .where(and(this.versionOwnership(), ...filters, eq(works.type, type)))
      .orderBy(desc(workVersions.createdAt))
      .limit(limit);

  private listDocumentVersionEvents = async (
    filters: SQL[],
    limit = 20,
  ): Promise<DocumentWorkVersionEventItem[]> => {
    const rows = await this.listSnapshotVersionEventRows<DocumentWorkVersionSnapshot>(
      'document',
      filters,
      limit,
    );

    return rows.map((row) => ({
      ...row.work,
      document: row.snapshot,
      resourceType: 'document' as const,
      type: 'document' as const,
      version: row.version,
    }));
  };

  private listLinearVersionEvents = async (
    filters: SQL[],
    limit = 20,
  ): Promise<LinearWorkVersionEventItem[]> => {
    const rows = await this.listSnapshotVersionEventRows<LinearWorkVersionSnapshot>(
      'linear',
      filters,
      limit,
    );

    return rows.map((row) => ({
      ...row.work,
      linear: row.snapshot,
      resourceType: row.work.resourceType as LinearWorkListItem['resourceType'],
      type: 'linear' as const,
      version: row.version,
    }));
  };

  private listGithubVersionEvents = async (
    filters: SQL[],
    limit = 20,
  ): Promise<GithubWorkVersionEventItem[]> => {
    const rows = await this.listSnapshotVersionEventRows<GithubWorkVersionSnapshot>(
      'github',
      filters,
      limit,
    );

    return rows.map((row) => ({
      ...row.work,
      github: row.snapshot,
      resourceType: row.work.resourceType as GithubWorkListItem['resourceType'],
      type: 'github' as const,
      version: row.version,
    }));
  };

  listByRootOperation = async (params: {
    limit?: number;
    rootOperationId?: string | null;
  }): Promise<WorkVersionEventItem[]> => {
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
  }): Promise<WorkVersionEventMap> => {
    const rootOperationIds = Array.from(
      new Set((params.rootOperationIds ?? []).filter((id): id is string => !!id)),
    ).sort();
    if (rootOperationIds.length === 0) return {};

    const limit = params.limit ?? 20;
    const result: WorkVersionEventMap = Object.fromEntries(
      rootOperationIds.map((rootOperationId) => [rootOperationId, []]),
    );
    // One batched query per work type across all ids (instead of 4 queries per
    // id); rows are re-partitioned per rootOperationId below. Each per-type
    // query over-fetches up to `limit` rows per id, clamped like the sibling
    // listSummariesByRootOperations.
    const filters = [inArray(workVersions.rootOperationId, rootOperationIds)];
    const rowLimit = Math.min(rootOperationIds.length * limit, MAX_SUMMARY_ROW_LIMIT);
    const [taskItems, documentItems, linearItems, githubItems] = await Promise.all([
      this.listTaskVersionEvents(filters, rowLimit),
      this.listDocumentVersionEvents(filters, rowLimit),
      this.listLinearVersionEvents(filters, rowLimit),
      this.listGithubVersionEvents(filters, rowLimit),
    ]);

    const items = [...taskItems, ...documentItems, ...linearItems, ...githubItems].sort(
      (a, b) => b.version.createdAt.getTime() - a.version.createdAt.getTime(),
    );

    for (const item of items) {
      const rootOperationId = item.version.rootOperationId;
      if (!rootOperationId || !(rootOperationId in result)) continue;
      if (result[rootOperationId].length >= limit) continue;
      result[rootOperationId].push(item);
    }

    return result;
  };

  /**
   * `cumulativeCost` is a running snapshot of the whole operation's spend at
   * the time each version was written (see schemas/work.ts), not a per-version
   * delta — so versions produced by the same root operation must not be added
   * together (v2 already contains v1's spend). Take MAX per operation, then
   * sum across operations. Versions without a rootOperationId are treated as
   * independent operations.
   */
  private getTotalCostByWorkIds = async (workIds: string[]) => {
    const ids = Array.from(new Set(workIds));
    const result = new Map<string, number | null>();
    if (ids.length === 0) return result;

    const rows = await this.db
      .select({
        cumulativeCost: workVersions.cumulativeCost,
        rootOperationId: workVersions.rootOperationId,
        versionId: workVersions.id,
        workId: workVersions.workId,
      })
      .from(workVersions)
      .where(inArray(workVersions.workId, ids));

    const maxCostByOperation = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (row.cumulativeCost === null) continue;

      const operationKey = row.rootOperationId ?? row.versionId;
      const operations = maxCostByOperation.get(row.workId) ?? new Map<string, number>();
      operations.set(operationKey, Math.max(operations.get(operationKey) ?? 0, row.cumulativeCost));
      maxCostByOperation.set(row.workId, operations);
    }

    for (const [workId, operations] of maxCostByOperation) {
      let totalCost = 0;
      for (const cost of operations.values()) totalCost += cost;
      result.set(workId, totalCost);
    }

    return result;
  };

  private listTaskWorkSummaryRows = async (
    filters: SQL[],
    rowLimit: number,
  ): Promise<TaskWorkSummaryQueryRow[]> =>
    this.db
      .select({
        event: versionEventSelection,
        // A LEFT JOIN miss (deleted task) nulls the tasks row; live columns
        // coalesce onto the current-version snapshot so the orphan card still
        // renders, and `tasks.id is null` is the deletion signal. Description
        // stays snapshot-only (matches summary semantics — never live).
        taskDeleted: sql<boolean>`${tasks.id} is null`,
        taskDescription: sql<string | null>`${currentVersions.snapshot}->'task'->>'description'`,
        taskName: sql<
          string | null
        >`coalesce(${tasks.name}, ${currentVersions.snapshot}->'task'->>'name')`,
        taskPriority: sql<
          number | null
        >`coalesce(${tasks.priority}, (${currentVersions.snapshot}->'task'->>'priority')::integer)`,
        taskStatus: sql<
          string | null
        >`coalesce(${tasks.status}, ${currentVersions.snapshot}->'task'->>'status')`,
        version: {
          createdAt: currentVersions.createdAt,
          id: currentVersions.id,
          version: currentVersions.version,
        },
        work: works,
      })
      .from(workVersions)
      .innerJoin(works, and(eq(workVersions.workId, works.id), this.ownership()))
      .innerJoin(currentVersions, eq(works.currentVersionId, currentVersions.id))
      // LEFT JOIN so orphaned task Works still surface in summaries.
      .leftJoin(
        tasks,
        and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), this.taskOwnership()),
      )
      .where(and(this.versionOwnership(), ...filters, eq(works.type, 'task')))
      .orderBy(desc(workVersions.createdAt), desc(works.updatedAt))
      .limit(rowLimit);

  private toTaskWorkSummaries = async (
    rows: TaskWorkSummaryQueryRow[],
  ): Promise<TaskWorkSummaryItem[]> => {
    const costByWorkId = await this.getTotalCostByWorkIds(rows.map((row) => row.work.id));

    return rows.map((row) => ({
      ...row.work,
      event: row.event,
      resourceType: 'task' as const,
      task: {
        description: row.taskDescription,
        name: row.taskName,
        priority: row.taskPriority,
        status: row.taskStatus,
      },
      taskDeleted: row.taskDeleted,
      totalCost: costByWorkId.get(row.work.id) ?? null,
      type: 'task' as const,
      version: row.version,
    }));
  };

  /**
   * Shared current-version summary query for snapshot-backed work types;
   * `task` keeps its own variant because it additionally joins the tasks table.
   */
  private listSnapshotWorkSummaryRows = <Snapshot>(
    type: SnapshotWorkType,
    filters: SQL[],
    rowLimit: number,
  ): Promise<SnapshotWorkSummaryQueryRow<Snapshot>[]> =>
    this.db
      .select({
        event: versionEventSelection,
        snapshot: snapshotField<Snapshot>(currentVersions.snapshot, type),
        version: {
          createdAt: currentVersions.createdAt,
          id: currentVersions.id,
          version: currentVersions.version,
        },
        work: works,
      })
      .from(workVersions)
      .innerJoin(works, and(eq(workVersions.workId, works.id), this.ownership()))
      .innerJoin(currentVersions, eq(works.currentVersionId, currentVersions.id))
      .where(and(this.versionOwnership(), ...filters, eq(works.type, type)))
      .orderBy(desc(workVersions.createdAt), desc(works.updatedAt))
      .limit(rowLimit);

  private listDocumentWorkSummaryRows = (filters: SQL[], rowLimit: number) =>
    this.listSnapshotWorkSummaryRows<DocumentWorkVersionSnapshot>('document', filters, rowLimit);

  private listLinearWorkSummaryRows = (filters: SQL[], rowLimit: number) =>
    this.listSnapshotWorkSummaryRows<LinearWorkVersionSnapshot>('linear', filters, rowLimit);

  private listGithubWorkSummaryRows = (filters: SQL[], rowLimit: number) =>
    this.listSnapshotWorkSummaryRows<GithubWorkVersionSnapshot>('github', filters, rowLimit);

  private toDocumentWorkSummaries = async (
    rows: SnapshotWorkSummaryQueryRow<DocumentWorkVersionSnapshot>[],
  ): Promise<DocumentWorkSummaryItem[]> => {
    const costByWorkId = await this.getTotalCostByWorkIds(rows.map((row) => row.work.id));

    return rows.map((row) => ({
      ...row.work,
      document: row.snapshot,
      event: row.event,
      resourceType: 'document' as const,
      totalCost: costByWorkId.get(row.work.id) ?? null,
      type: 'document' as const,
      version: row.version,
    }));
  };

  private toLinearWorkSummaries = async (
    rows: SnapshotWorkSummaryQueryRow<LinearWorkVersionSnapshot>[],
  ): Promise<LinearWorkSummaryItem[]> => {
    const costByWorkId = await this.getTotalCostByWorkIds(rows.map((row) => row.work.id));

    return rows.map((row) => ({
      ...row.work,
      event: row.event,
      linear: row.snapshot,
      resourceType: row.work.resourceType as LinearWorkSummaryItem['resourceType'],
      totalCost: costByWorkId.get(row.work.id) ?? null,
      type: 'linear' as const,
      version: row.version,
    }));
  };

  private toGithubWorkSummaries = async (
    rows: SnapshotWorkSummaryQueryRow<GithubWorkVersionSnapshot>[],
  ): Promise<GithubWorkSummaryItem[]> => {
    const costByWorkId = await this.getTotalCostByWorkIds(rows.map((row) => row.work.id));

    return rows.map((row) => ({
      ...row.work,
      event: row.event,
      github: row.snapshot,
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
    const filters = [inArray(workVersions.rootOperationId, rootOperationIds)];
    const rowLimit = Math.min(
      rootOperationIds.length * limit * WORK_TYPE_FANOUT,
      MAX_SUMMARY_ROW_LIMIT,
    );
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
      ].sort((a, b) => b.event.createdAt.getTime() - a.event.createdAt.getTime()),
    );

    for (const summary of summaries) {
      const rootOperationId = summary.event.rootOperationId;
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
      ? eq(workVersions.threadId, params.threadId)
      : isNull(workVersions.threadId);
    const filters = [eq(workVersions.topicId, params.topicId), threadFilter];
    const [taskRows, documentRows, linearRows, githubRows] = await Promise.all([
      this.listTaskWorkSummaryRows(filters, limit * WORK_TYPE_FANOUT),
      this.listDocumentWorkSummaryRows(filters, limit * WORK_TYPE_FANOUT),
      this.listLinearWorkSummaryRows(filters, limit * WORK_TYPE_FANOUT),
      this.listGithubWorkSummaryRows(filters, limit * WORK_TYPE_FANOUT),
    ]);

    return this.latestSummaryItemsByWork(
      [
        ...(await this.toTaskWorkSummaries(taskRows)),
        ...(await this.toDocumentWorkSummaries(documentRows)),
        ...(await this.toLinearWorkSummaries(linearRows)),
        ...(await this.toGithubWorkSummaries(githubRows)),
      ].sort((a, b) => b.event.createdAt.getTime() - a.event.createdAt.getTime()),
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
      ? eq(workVersions.threadId, params.threadId)
      : isNull(workVersions.threadId);

    const taskRows = await this.db
      .select({
        eventCreatedAt: workVersions.createdAt,
        // LEFT JOIN so orphaned task Works still surface; live columns coalesce
        // onto the current-version snapshot and `tasks.id is null` flags deletion.
        taskDeleted: sql<boolean>`${tasks.id} is null`,
        taskDescription: sql<
          string | null
        >`coalesce(${tasks.description}, ${currentVersions.snapshot}->'task'->>'description')`,
        taskName: sql<
          string | null
        >`coalesce(${tasks.name}, ${currentVersions.snapshot}->'task'->>'name')`,
        taskPriority: sql<
          number | null
        >`coalesce(${tasks.priority}, (${currentVersions.snapshot}->'task'->>'priority')::integer)`,
        taskStatus: sql<
          string | null
        >`coalesce(${tasks.status}, ${currentVersions.snapshot}->'task'->>'status')`,
        work: works,
      })
      .from(workVersions)
      .innerJoin(works, and(eq(workVersions.workId, works.id), this.ownership()))
      .innerJoin(currentVersions, eq(works.currentVersionId, currentVersions.id))
      .leftJoin(
        tasks,
        and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), this.taskOwnership()),
      )
      .where(
        and(
          this.versionOwnership(),
          eq(workVersions.topicId, params.topicId),
          threadFilter,
          eq(works.type, 'task'),
        ),
      )
      .orderBy(desc(workVersions.createdAt), desc(works.updatedAt))
      .limit(limit * WORK_TYPE_FANOUT);

    const snapshotRows = <Snapshot>(type: SnapshotWorkType) =>
      this.db
        .select({
          eventCreatedAt: workVersions.createdAt,
          snapshot: snapshotField<Snapshot>(currentVersions.snapshot, type),
          work: works,
        })
        .from(workVersions)
        .innerJoin(works, and(eq(workVersions.workId, works.id), this.ownership()))
        .innerJoin(currentVersions, eq(works.currentVersionId, currentVersions.id))
        .where(
          and(
            this.versionOwnership(),
            eq(workVersions.topicId, params.topicId!),
            threadFilter,
            eq(works.type, type),
          ),
        )
        .orderBy(desc(workVersions.createdAt), desc(works.updatedAt))
        .limit(limit * WORK_TYPE_FANOUT);

    const [documentRows, linearRows, githubRows] = await Promise.all([
      snapshotRows<DocumentWorkVersionSnapshot>('document'),
      snapshotRows<LinearWorkVersionSnapshot>('linear'),
      snapshotRows<GithubWorkVersionSnapshot>('github'),
    ]);

    const seen = new Set<string>();
    const items: WorkListItem[] = [];
    const rows = [
      ...taskRows.map((row) => ({
        eventCreatedAt: row.eventCreatedAt,
        item: {
          ...row.work,
          resourceType: 'task' as const,
          task: {
            description: row.taskDescription,
            name: row.taskName,
            priority: row.taskPriority,
            status: row.taskStatus,
          },
          taskDeleted: row.taskDeleted,
          type: 'task' as const,
        } satisfies TaskWorkListItem,
      })),
      ...documentRows.map((row) => ({
        eventCreatedAt: row.eventCreatedAt,
        item: {
          ...row.work,
          document: row.snapshot,
          resourceType: 'document' as const,
          type: 'document' as const,
        } satisfies DocumentWorkListItem,
      })),
      ...linearRows.map((row) => ({
        eventCreatedAt: row.eventCreatedAt,
        item: {
          ...row.work,
          linear: row.snapshot,
          resourceType: row.work.resourceType as LinearWorkListItem['resourceType'],
          type: 'linear' as const,
        } satisfies LinearWorkListItem,
      })),
      ...githubRows.map((row) => ({
        eventCreatedAt: row.eventCreatedAt,
        item: {
          ...row.work,
          github: row.snapshot,
          resourceType: row.work.resourceType as GithubWorkListItem['resourceType'],
          type: 'github' as const,
        } satisfies GithubWorkListItem,
      })),
    ].sort((a, b) => b.eventCreatedAt.getTime() - a.eventCreatedAt.getTime());

    for (const row of rows) {
      if (seen.has(row.item.id)) continue;
      seen.add(row.item.id);
      items.push(row.item);
      if (items.length >= limit) break;
    }

    return items;
  };

  listVersions = async (workId: string): Promise<WorkVersionItem[]> => {
    const rows = await this.db
      .select({ version: workVersions })
      .from(workVersions)
      .innerJoin(works, and(eq(workVersions.workId, works.id), this.ownership()))
      .where(eq(workVersions.workId, workId))
      .orderBy(desc(workVersions.version));

    return rows.map((row) => row.version);
  };
}
