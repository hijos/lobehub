import type {
  DocumentWorkSummaryItem,
  RegisterTaskWorkParams,
  TaskWorkListItem,
  TaskWorkSummaryItem,
  WorkItem,
  WorkVersionPreview,
  WorkVersionSnapshot,
} from '@lobechat/types';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { works, workVersions } from '../../schemas/work';
import { versionOwnership, type WorkContext, workOwnership } from './context';

/**
 * Second reference to `work_versions` for summary/list queries that both
 * filter by the mutation event (topicId / rootOperationId on the event row)
 * and render the Work's current content (works.currentVersionId join).
 */
export const currentVersions = alias(workVersions, 'current_work_versions');

/** Provenance fields shared by all four Register*WorkParams shapes. */
export type WorkVersionEventParams = Pick<
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
export interface CreateVersionInput {
  metadata?: (typeof workVersions.$inferInsert)['metadata'];
  snapshot: WorkVersionSnapshot;
}

/** Event-version columns embedded in list/summary rows (`WorkVersionPreview`). */
export const versionEventSelection = {
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

export interface TaskWorkSummaryQueryRow {
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
export type SnapshotWorkType = 'document' | 'github' | 'linear';

export interface SnapshotWorkSummaryQueryRow<Snapshot> {
  event: WorkVersionPreview;
  snapshot: Snapshot;
  version: DocumentWorkSummaryItem['version'];
  work: WorkItem;
}

/** Project the per-type snapshot object out of a version row's snapshot JSON. */
export const snapshotField = <Snapshot>(
  snapshotColumn: (typeof workVersions)['snapshot'] | (typeof currentVersions)['snapshot'],
  type: SnapshotWorkType,
) => sql<Snapshot>`${snapshotColumn}->${sql.raw(`'${type}'`)}`;

/**
 * Shared version-event query for snapshot-backed work types; `task` keeps
 * its own variant because it additionally joins the tasks table.
 */
export const listSnapshotVersionEventRows = <Snapshot>(
  ctx: WorkContext,
  type: SnapshotWorkType,
  filters: SQL[],
  limit: number,
) =>
  ctx.db
    .select({
      snapshot: snapshotField<Snapshot>(workVersions.snapshot, type),
      version: versionEventSelection,
      work: works,
    })
    .from(workVersions)
    .innerJoin(works, and(eq(workVersions.workId, works.id), workOwnership(ctx)))
    .where(and(versionOwnership(ctx), ...filters, eq(works.type, type)))
    .orderBy(desc(workVersions.createdAt))
    .limit(limit);

/**
 * Shared current-version summary query for snapshot-backed work types;
 * `task` keeps its own variant because it additionally joins the tasks table.
 */
export const listSnapshotWorkSummaryRows = <Snapshot>(
  ctx: WorkContext,
  type: SnapshotWorkType,
  filters: SQL[],
  rowLimit: number,
): Promise<SnapshotWorkSummaryQueryRow<Snapshot>[]> =>
  ctx.db
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
    .innerJoin(works, and(eq(workVersions.workId, works.id), workOwnership(ctx)))
    .innerJoin(currentVersions, eq(works.currentVersionId, currentVersions.id))
    .where(and(versionOwnership(ctx), ...filters, eq(works.type, type)))
    .orderBy(desc(workVersions.createdAt), desc(works.updatedAt))
    .limit(rowLimit);
