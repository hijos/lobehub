import type {
  WorkContentRefType,
  WorkContextRole,
  WorkRenderType,
  WorkResourceType,
  WorkSourceType,
  WorkStatus,
  WorkType,
  WorkVersionCumulativeUsage,
  WorkVersionMetadata,
  WorkVersionSnapshot,
  WorkVisibility,
} from '@lobechat/types';
import { isNotNull, isNull } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { idGenerator } from '../utils/idGenerator';
import { amountNumeric, createdAt, updatedAt } from './_helpers';
import { agents } from './agent';
import { messages } from './message';
import { threads, topics } from './topic';
import { users } from './user';
import { workspaces } from './workspace';

/**
 * Stable Work identity. The same underlying resource (for MVP, a task) maps to
 * one Work row; edits append immutable rows in `work_versions`.
 */
export const works = pgTable(
  'works',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => idGenerator('works'))
      .notNull(),
    title: text('title').notNull(),
    type: text('type').$type<WorkType>().notNull(),
    status: text('status').$type<WorkStatus>().notNull().default('draft'),
    visibility: text('visibility').$type<WorkVisibility>().notNull().default('private'),
    currentVersionId: text('current_version_id'),

    resourceType: text('resource_type').$type<WorkResourceType>().notNull(),
    resourceId: text('resource_id').notNull(),
    resourceIdentifier: text('resource_identifier'),

    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('works_resource_user_unique')
      .on(t.resourceType, t.resourceId, t.userId)
      .where(isNull(t.workspaceId)),
    uniqueIndex('works_resource_workspace_unique')
      .on(t.workspaceId, t.resourceType, t.resourceId)
      .where(isNotNull(t.workspaceId)),
    index('works_user_id_idx').on(t.userId),
    index('works_workspace_id_idx').on(t.workspaceId),
    index('works_resource_idx').on(t.resourceType, t.resourceId),
    index('works_current_version_id_idx').on(t.currentVersionId),
    index('works_updated_at_idx').on(t.updatedAt),
  ],
);

/**
 * Immutable Work version content. Task MVP stores an inline task snapshot; later
 * renderers can point `contentRef*` at files, object storage, or URLs.
 */
export const workVersions = pgTable(
  'work_versions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => idGenerator('workVersions'))
      .notNull(),
    workId: text('work_id')
      .references(() => works.id, { onDelete: 'cascade' })
      .notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    renderType: text('render_type').$type<WorkRenderType>().notNull(),
    contentRefType: text('content_ref_type').$type<WorkContentRefType>(),
    contentRef: text('content_ref'),
    snapshot: jsonb('snapshot').$type<WorkVersionSnapshot>().notNull(),
    thumbnail: text('thumbnail'),
    metadata: jsonb('metadata').$type<WorkVersionMetadata>(),
    /**
     * Cumulative operation cost in USD when this version is produced.
     * For example, one operation may create Work A at $0.03 and Work B later at $0.05.
     * These are cumulative snapshots, not exclusive Work costs.
     */
    cumulativeCost: amountNumeric('cumulative_cost'),
    /** Runtime usage/cost detail captured with `cumulativeCost`, including tokens and breakdowns. */
    cumulativeUsage: jsonb('cumulative_usage').$type<WorkVersionCumulativeUsage>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('work_versions_work_id_version_unique').on(t.workId, t.version),
    index('work_versions_work_id_idx').on(t.workId),
    index('work_versions_created_at_idx').on(t.createdAt),
  ],
);

/**
 * Context/provenance events for where a Work appeared or was changed. Topic and
 * thread references are set-null so deleting a conversation context does not
 * delete the Work identity or its version history.
 */
export const workContexts = pgTable(
  'work_contexts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => idGenerator('workContexts'))
      .notNull(),
    workId: text('work_id')
      .references(() => works.id, { onDelete: 'cascade' })
      .notNull(),
    versionId: text('version_id').references(() => workVersions.id, { onDelete: 'set null' }),
    role: text('role').$type<WorkContextRole>().notNull(),
    sourceType: text('source_type').$type<WorkSourceType>().notNull(),
    source: text('source').notNull(),

    topicId: text('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    /**
     * Message that triggered this context. For sourceType='tool', this is the
     * persisted tool result message; other source types may point to a user
     * message or stay null when no chat message exists.
     */
    sourceMessageId: text('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    /** Root runtime operation that groups all contexts created during one assistant run. */
    rootOperationId: text('root_operation_id'),
    /** Runtime tool-call id that produced this context, used to dedupe repeated registration. */
    sourceToolCallId: text('source_tool_call_id'),
    /** Agent that triggered the Work change, when the source is agent/tool driven. */
    actorAgentId: text('actor_agent_id').references(() => agents.id, { onDelete: 'set null' }),

    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('work_contexts_work_id_source_tool_call_id_unique')
      .on(t.workId, t.sourceToolCallId)
      .where(isNotNull(t.sourceToolCallId)),
    index('work_contexts_work_id_idx').on(t.workId),
    index('work_contexts_version_id_idx').on(t.versionId),
    index('work_contexts_topic_id_idx').on(t.topicId),
    index('work_contexts_thread_id_idx').on(t.threadId),
    index('work_contexts_source_message_id_idx').on(t.sourceMessageId),
    index('work_contexts_root_operation_id_idx').on(t.rootOperationId),
    index('work_contexts_user_id_idx').on(t.userId),
    index('work_contexts_workspace_id_idx').on(t.workspaceId),
    index('work_contexts_source_idx').on(t.sourceType, t.source),
    index('work_contexts_created_at_idx').on(t.createdAt),
  ],
);

export type NewWork = typeof works.$inferInsert;
export type WorkItem = typeof works.$inferSelect;
export type NewWorkVersion = typeof workVersions.$inferInsert;
export type WorkVersionItem = typeof workVersions.$inferSelect;
export type NewWorkContext = typeof workContexts.$inferInsert;
export type WorkContextItem = typeof workContexts.$inferSelect;
