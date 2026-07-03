import type {
  WorkContentRefType,
  WorkContextMetadata,
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
    /** Display title, kept in sync with the latest version's title on upsert. */
    title: text('title').notNull(),
    /** Provider domain of the Work: 'task' | 'document' | 'linear' | 'github'. */
    type: text('type').$type<WorkType>().notNull(),
    /** Lifecycle state; only 'draft' is produced today, reserved for publish/archive flows. */
    status: text('status').$type<WorkStatus>().notNull().default('draft'),
    /** Sharing scope; only 'private' is produced today, reserved for workspace/public sharing. */
    visibility: text('visibility').$type<WorkVisibility>().notNull().default('private'),
    /**
     * Latest `work_versions` row. Soft reference (no FK): work_versions.workId
     * already references works, so a real FK here would create a circular
     * dependency between the two tables.
     */
    currentVersionId: text('current_version_id'),

    /** Fine-grained resource kind, e.g. 'task' | 'linear_issue' | 'github_pull_request'. */
    resourceType: text('resource_type').$type<WorkResourceType>().notNull(),
    /**
     * Stable dedup key of the underlying resource within (resourceType, user/workspace).
     * task: task id; linear: issue identifier or document id; github: `owner/repo#number`
     * (the gh CLI surface never returns a node_id, so both github surfaces share this key).
     */
    resourceId: text('resource_id').notNull(),
    /** Human-readable external identifier for display, e.g. `LOBE-123` or `owner/repo#456`. */
    resourceIdentifier: text('resource_identifier'),

    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** Null for personal Works; determines which resource unique index applies below. */
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
    /** 1-based sequence within a Work, unique per (workId, version). */
    version: integer('version').notNull(),
    /** Title at the time this version was captured. */
    title: text('title').notNull(),
    /** Which renderer displays this version, e.g. 'task_snapshot' | 'github_snapshot'. */
    renderType: text('render_type').$type<WorkRenderType>().notNull(),
    /** How `contentRef` should be resolved ('file' | 'storage' | 'url'); null for inline snapshots. */
    contentRefType: text('content_ref_type').$type<WorkContentRefType>(),
    /** Pointer to externally stored content; unused in the MVP where content lives in `snapshot`. */
    contentRef: text('content_ref'),
    /**
     * Normalized, white-listed resource fields (never raw connector payloads).
     * Partial tool results are patch-merged over the previous version's snapshot
     * using the normalizer's `patchFields`.
     */
    snapshot: jsonb('snapshot').$type<WorkVersionSnapshot>().notNull(),
    /** Preview image URL for gallery-style rendering. */
    thumbnail: text('thumbnail'),
    /** Version annotations, e.g. a human-readable change summary. */
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
    /** Version produced by this event; null for events that did not change content. */
    versionId: text('version_id').references(() => workVersions.id, { onDelete: 'set null' }),
    /** How the Work was involved: 'created' | 'updated' | 'referenced' | 'used_as_context' | 'published'. */
    role: text('role').$type<WorkContextRole>().notNull(),
    /** What kind of actor produced the event: 'tool' | 'user' | 'system' | 'import'. */
    sourceType: text('source_type').$type<WorkSourceType>().notNull(),
    /** Concrete source within `sourceType`, e.g. the tool name for sourceType='tool'. */
    source: text('source').notNull(),

    /** Conversation where the event happened; set-null keeps Work history after topic deletion. */
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
    /** Resource-specific tool provenance, such as the agent document binding used by a document tool. */
    metadata: jsonb('metadata').$type<WorkContextMetadata>(),

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
