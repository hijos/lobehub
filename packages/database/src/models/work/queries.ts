import type {
  DocumentWorkListItem,
  DocumentWorkVersionSnapshot,
  GithubWorkListItem,
  GithubWorkVersionSnapshot,
  LinearWorkListItem,
  LinearWorkVersionSnapshot,
  TaskWorkListItem,
  WorkListItem,
  WorkSummaryItem,
  WorkSummaryMap,
  WorkVersionEventItem,
  WorkVersionEventMap,
  WorkVersionItem,
} from '@lobechat/types';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { tasks } from '../../schemas/task';
import { works, workVersions } from '../../schemas/work';
import { taskOwnership, versionOwnership, type WorkContext, workOwnership } from './context';
import {
  listDocumentVersionEvents,
  listDocumentWorkSummaryRows,
  toDocumentWorkSummaries,
} from './document';
import {
  listGithubVersionEvents,
  listGithubWorkSummaryRows,
  toGithubWorkSummaries,
} from './github';
import { currentVersions, snapshotField, type SnapshotWorkType } from './internal';
import {
  listLinearVersionEvents,
  listLinearWorkSummaryRows,
  toLinearWorkSummaries,
} from './linear';
import { listTaskVersionEvents, listTaskWorkSummaryRows, toTaskWorkSummaries } from './task';

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

const latestSummaryItemsByWork = (items: WorkSummaryItem[], limit?: number) => {
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

export const listByRootOperation = async (
  ctx: WorkContext,
  params: {
    limit?: number;
    rootOperationId?: string | null;
  },
): Promise<WorkVersionEventItem[]> => {
  if (!params.rootOperationId) return [];

  const map = await listByRootOperations(ctx, {
    limit: params.limit,
    rootOperationIds: [params.rootOperationId],
  });

  return map[params.rootOperationId] ?? [];
};

export const listByRootOperations = async (
  ctx: WorkContext,
  params: {
    limit?: number;
    rootOperationIds?: string[] | null;
  },
): Promise<WorkVersionEventMap> => {
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
    listTaskVersionEvents(ctx, filters, rowLimit),
    listDocumentVersionEvents(ctx, filters, rowLimit),
    listLinearVersionEvents(ctx, filters, rowLimit),
    listGithubVersionEvents(ctx, filters, rowLimit),
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

export const listSummariesByRootOperations = async (
  ctx: WorkContext,
  params: {
    limit?: number;
    rootOperationIds?: string[] | null;
  },
): Promise<WorkSummaryMap> => {
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
    listTaskWorkSummaryRows(ctx, filters, rowLimit),
    listDocumentWorkSummaryRows(ctx, filters, rowLimit),
    listLinearWorkSummaryRows(ctx, filters, rowLimit),
    listGithubWorkSummaryRows(ctx, filters, rowLimit),
  ]);
  const summaries = latestSummaryItemsByWork(
    [
      ...(await toTaskWorkSummaries(ctx, taskRows)),
      ...(await toDocumentWorkSummaries(ctx, documentRows)),
      ...(await toLinearWorkSummaries(ctx, linearRows)),
      ...(await toGithubWorkSummaries(ctx, githubRows)),
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

export const listByConversation = async (
  ctx: WorkContext,
  params: {
    limit?: number;
    threadId?: string | null;
    topicId?: string | null;
  },
): Promise<WorkListItem[]> => {
  if (!params.topicId) return [];

  const limit = params.limit ?? 50;
  const threadFilter = params.threadId
    ? eq(workVersions.threadId, params.threadId)
    : isNull(workVersions.threadId);

  const taskRows = await ctx.db
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
    .innerJoin(works, and(eq(workVersions.workId, works.id), workOwnership(ctx)))
    .innerJoin(currentVersions, eq(works.currentVersionId, currentVersions.id))
    .leftJoin(
      tasks,
      and(eq(works.resourceType, 'task'), eq(works.resourceId, tasks.id), taskOwnership(ctx)),
    )
    .where(
      and(
        versionOwnership(ctx),
        eq(workVersions.topicId, params.topicId),
        threadFilter,
        eq(works.type, 'task'),
      ),
    )
    .orderBy(desc(workVersions.createdAt), desc(works.updatedAt))
    .limit(limit * WORK_TYPE_FANOUT);

  const snapshotRows = <Snapshot>(type: SnapshotWorkType) =>
    ctx.db
      .select({
        eventCreatedAt: workVersions.createdAt,
        snapshot: snapshotField<Snapshot>(currentVersions.snapshot, type),
        work: works,
      })
      .from(workVersions)
      .innerJoin(works, and(eq(workVersions.workId, works.id), workOwnership(ctx)))
      .innerJoin(currentVersions, eq(works.currentVersionId, currentVersions.id))
      .where(
        and(
          versionOwnership(ctx),
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

export const listVersions = async (
  ctx: WorkContext,
  workId: string,
): Promise<WorkVersionItem[]> => {
  const rows = await ctx.db
    .select({ version: workVersions })
    .from(workVersions)
    .innerJoin(works, and(eq(workVersions.workId, works.id), workOwnership(ctx)))
    .where(eq(workVersions.workId, workId))
    .orderBy(desc(workVersions.version));

  return rows.map((row) => row.version);
};
