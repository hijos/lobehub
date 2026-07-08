import type {
  RegisterTaskWorkParams,
  TaskItem,
  TaskWorkSummaryItem,
  TaskWorkVersionEventItem,
  TaskWorkVersionSnapshot,
  WorkItem,
  WorkVersionItem,
  WorkVersionSnapshot,
} from '@lobechat/types';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, or, sql } from 'drizzle-orm';

import { tasks } from '../../schemas/task';
import { works, workVersions } from '../../schemas/work';
import { taskOwnership, versionOwnership, type WorkContext, workOwnership } from './context';
import { getTotalCostByWorkIds } from './cost';
import { currentVersions, type TaskWorkSummaryQueryRow, versionEventSelection } from './internal';
import { createVersion, findById, resolveWorkUpsertConflict } from './writes';

const normalizeTaskLookup = (value?: string) => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('task_') ? trimmed : trimmed.toUpperCase();
};

export const taskSnapshot = (task: TaskItem): WorkVersionSnapshot => ({
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

const resolveTask = async (
  ctx: WorkContext,
  params: RegisterTaskWorkParams,
): Promise<TaskItem | null> => {
  const filters: SQL[] = [];
  const taskId = normalizeTaskLookup(params.taskId);
  const taskIdentifier = normalizeTaskLookup(params.taskIdentifier);

  if (taskId) {
    filters.push(taskId.startsWith('task_') ? eq(tasks.id, taskId) : eq(tasks.identifier, taskId));
  }

  if (taskIdentifier) {
    filters.push(
      taskIdentifier.startsWith('task_')
        ? eq(tasks.id, taskIdentifier)
        : eq(tasks.identifier, taskIdentifier),
    );
  }

  if (filters.length === 0) return null;

  const [task] = await ctx.db
    .select()
    .from(tasks)
    .where(and(taskOwnership(ctx), filters.length === 1 ? filters[0] : or(...filters)))
    .limit(1);

  return task ?? null;
};

const upsertTaskWork = async (ctx: WorkContext, task: TaskItem): Promise<WorkItem> => {
  const values = {
    resourceId: task.id,
    resourceIdentifier: task.identifier,
    resourceType: 'task' as const,
    type: 'task' as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId ?? null,
  };

  const conflict = resolveWorkUpsertConflict(ctx);

  const [work] = await ctx.db
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

const createTaskVersion = async (
  ctx: WorkContext,
  work: WorkItem,
  task: TaskItem,
  params: RegisterTaskWorkParams,
): Promise<WorkVersionItem> =>
  createVersion(ctx, work, params, () => ({
    snapshot: taskSnapshot(task),
  }));

export const registerTaskWork = async (
  ctx: WorkContext,
  params: RegisterTaskWorkParams,
): Promise<WorkItem | null> => {
  const task = await resolveTask(ctx, params);
  if (!task) return null;

  const work = await upsertTaskWork(ctx, task);
  await createTaskVersion(ctx, work, task, params);

  return findById(ctx, work.id);
};

export const listTaskVersionEvents = async (
  ctx: WorkContext,
  filters: SQL[],
  limit = 20,
): Promise<TaskWorkVersionEventItem[]> => {
  const rows = await ctx.db
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
    .innerJoin(works, and(eq(workVersions.workId, works.id), workOwnership(ctx)))
    // LEFT JOIN so orphaned task Works (task deleted without the tool path)
    // still surface; deletion is derived from the missing tasks row.
    .leftJoin(
      tasks,
      and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), taskOwnership(ctx)),
    )
    .where(and(versionOwnership(ctx), ...filters, eq(works.type, 'task')))
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

export const listTaskWorkSummaryRows = async (
  ctx: WorkContext,
  filters: SQL[],
  rowLimit: number,
): Promise<TaskWorkSummaryQueryRow[]> =>
  ctx.db
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
    .innerJoin(works, and(eq(workVersions.workId, works.id), workOwnership(ctx)))
    .innerJoin(currentVersions, eq(works.currentVersionId, currentVersions.id))
    // LEFT JOIN so orphaned task Works still surface in summaries.
    .leftJoin(
      tasks,
      and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), taskOwnership(ctx)),
    )
    .where(and(versionOwnership(ctx), ...filters, eq(works.type, 'task')))
    .orderBy(desc(workVersions.createdAt), desc(works.updatedAt))
    .limit(rowLimit);

export const toTaskWorkSummaries = async (
  ctx: WorkContext,
  rows: TaskWorkSummaryQueryRow[],
): Promise<TaskWorkSummaryItem[]> => {
  const costByWorkId = await getTotalCostByWorkIds(
    ctx,
    rows.map((row) => row.work.id),
  );

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
