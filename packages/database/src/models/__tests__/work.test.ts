// @vitest-environment node
import type {
  DocumentWorkSummaryItem,
  DocumentWorkVersionSnapshot,
  GithubWorkSummaryItem,
  GithubWorkVersionSnapshot,
  LinearWorkSummaryItem,
  LinearWorkVersionSnapshot,
  TaskWorkSummaryItem,
  TaskWorkVersionSnapshot,
  WorkSummaryItem,
  WorkVersionSnapshot,
} from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  agents,
  messages,
  tasks,
  threads,
  topics,
  users,
  workContexts,
  works,
  workVersions,
} from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { AgentDocumentModel } from '../agentDocuments';
import { TaskModel } from '../task';
import { WorkModel } from '../work';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'work-test-user-id';
const userId2 = 'work-test-user-id-2';
const topicId = 'work-test-topic-id';
const threadId = 'work-test-thread-id';
const agentId = 'work-test-agent-id';
const agentId2 = 'work-test-agent-id-2';

const expectTaskSnapshot = (snapshot: WorkVersionSnapshot): TaskWorkVersionSnapshot => {
  expect(snapshot).toHaveProperty('task');

  if (!('task' in snapshot)) {
    throw new Error('Expected task work snapshot');
  }

  return snapshot.task;
};

const expectDocumentSnapshot = (snapshot: WorkVersionSnapshot): DocumentWorkVersionSnapshot => {
  expect(snapshot).toHaveProperty('document');

  if (!('document' in snapshot)) {
    throw new Error('Expected document work snapshot');
  }

  return snapshot.document;
};

const expectLinearSnapshot = (snapshot: WorkVersionSnapshot): LinearWorkVersionSnapshot => {
  expect(snapshot).toHaveProperty('linear');

  if (!('linear' in snapshot)) {
    throw new Error('Expected linear work snapshot');
  }

  return snapshot.linear;
};

const expectTaskSummaryItem = (item?: WorkSummaryItem): TaskWorkSummaryItem => {
  expect(item).toBeDefined();

  if (!item || item.type !== 'task') {
    throw new Error('Expected task work summary');
  }

  return item;
};

const expectDocumentSummaryItem = (item?: WorkSummaryItem): DocumentWorkSummaryItem => {
  expect(item).toBeDefined();

  if (!item || item.type !== 'document') {
    throw new Error('Expected document work summary');
  }

  return item;
};

const expectLinearSummaryItem = (item?: WorkSummaryItem): LinearWorkSummaryItem => {
  expect(item).toBeDefined();

  if (!item || item.type !== 'linear') {
    throw new Error('Expected linear work summary');
  }

  return item;
};

const expectGithubSnapshot = (snapshot: WorkVersionSnapshot): GithubWorkVersionSnapshot => {
  expect(snapshot).toHaveProperty('github');

  if (!('github' in snapshot)) {
    throw new Error('Expected github work snapshot');
  }

  return snapshot.github;
};

const expectGithubSummaryItem = (item?: WorkSummaryItem): GithubWorkSummaryItem => {
  expect(item).toBeDefined();

  if (!item || item.type !== 'github') {
    throw new Error('Expected github work summary');
  }

  return item;
};

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: userId2 }]);
  await serverDB.insert(agents).values([
    { id: agentId, title: 'Work test agent', userId },
    { id: agentId2, title: 'Work test agent 2', userId: userId2 },
  ]);
  await serverDB.insert(topics).values({ id: topicId, userId });
  await serverDB.insert(threads).values({
    id: threadId,
    title: 'Work test thread',
    topicId,
    type: 'standalone',
    userId,
  });
});

afterEach(async () => {
  await serverDB.delete(users);
});

describe('WorkModel', () => {
  it('registers a task work with v1 and conversation context', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const task = await taskModel.create({
      instruction: 'Write the MVP plan',
      name: 'Work MVP plan',
      priority: 2,
    });
    await serverDB.insert(messages).values([
      {
        content: '',
        id: 'msg-assistant',
        role: 'assistant',
        topicId,
        userId,
      },
      {
        content: '',
        id: 'msg-tool',
        parentId: 'msg-assistant',
        role: 'tool',
        topicId,
        userId,
      },
    ]);

    const work = await workModel.registerTask({
      role: 'created',
      rootOperationId: 'op-root',
      source: 'createTask',
      sourceMessageId: 'msg-tool',
      sourceToolCallId: 'tool-call-create',
      taskId: task.id,
      threadId,
      topicId,
    });

    expect(work).toBeDefined();
    expect(work?.resourceId).toBe(task.id);
    expect(work?.resourceIdentifier).toBe(task.identifier);
    expect(work?.currentVersionId).toBeTruthy();

    const versions = await workModel.listVersions(work!.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      context: expect.objectContaining({ role: 'created', source: 'createTask' }),
      title: 'Work MVP plan',
      version: 1,
    });
    expect(expectTaskSnapshot(versions[0].snapshot).identifier).toBe(task.identifier);

    const worksInConversation = await workModel.listByConversation({ threadId, topicId });
    expect(worksInConversation).toHaveLength(1);
    expect(worksInConversation[0]).toMatchObject({
      id: work?.id,
      task: { priority: 2, status: 'backlog' },
    });

    const [context] = await serverDB
      .select()
      .from(workContexts)
      .where(eq(workContexts.workId, work!.id));
    expect(context).toMatchObject({
      rootOperationId: 'op-root',
      sourceMessageId: 'msg-tool',
      sourceToolCallId: 'tool-call-create',
    });

    const byOperation = await workModel.listByRootOperation({ rootOperationId: 'op-root' });
    expect(byOperation).toHaveLength(1);
    expect(byOperation[0].id).toBe(work?.id);

    const byOperations = await workModel.listByRootOperations({
      rootOperationIds: ['op-missing', 'op-root'],
    });
    expect(byOperations['op-root']).toHaveLength(1);
    expect(byOperations['op-root']?.[0]).toMatchObject({
      context: expect.objectContaining({
        rootOperationId: 'op-root',
        sourceMessageId: 'msg-tool',
      }),
      id: work?.id,
    });
    expect(byOperations['op-missing']).toEqual([]);
  });

  it('groups context versions by root operation', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const firstTask = await taskModel.create({
      instruction: 'First tool work',
      name: 'First work',
    });
    const secondTask = await taskModel.create({
      instruction: 'Second tool work',
      name: 'Second work',
    });

    await workModel.registerTask({
      role: 'created',
      rootOperationId: 'op-first',
      source: 'createTask',
      sourceToolCallId: 'tool-call-1',
      taskId: firstTask.id,
      topicId,
    });
    await workModel.registerTask({
      role: 'created',
      rootOperationId: 'op-second',
      source: 'createTask',
      sourceToolCallId: 'tool-call-2',
      taskId: secondTask.id,
      topicId,
    });

    const byOperations = await workModel.listByRootOperations({
      rootOperationIds: ['op-missing', 'op-second', 'op-first', 'op-first'],
    });

    expect(byOperations['op-first']?.map((item) => item.resourceId)).toEqual([firstTask.id]);
    expect(byOperations['op-second']?.map((item) => item.resourceId)).toEqual([secondTask.id]);
    expect(byOperations['op-missing']).toEqual([]);
  });

  it('updates cumulative usage for the version produced by a tool call', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const firstTask = await taskModel.create({
      instruction: 'First tool work',
      name: 'First work',
    });
    const secondTask = await taskModel.create({
      instruction: 'Second tool work',
      name: 'Second work',
    });

    const firstWork = await workModel.registerTask({
      role: 'created',
      rootOperationId: 'op-cumulative',
      source: 'createTask',
      sourceToolCallId: 'tool-call-first',
      taskId: firstTask.id,
      topicId,
    });
    const secondWork = await workModel.registerTask({
      role: 'created',
      rootOperationId: 'op-cumulative',
      source: 'createTask',
      sourceToolCallId: 'tool-call-second',
      taskId: secondTask.id,
      topicId,
    });

    await workModel.updateVersionCumulativeUsage({
      cumulativeCost: 0.03,
      cumulativeUsage: {
        capturedAt: '2026-06-30T08:00:00.000Z',
        cost: { total: 0.03 },
        usage: { llm: { tokens: { input: 1200, output: 300, total: 1500 } } },
      },
      rootOperationId: 'op-cumulative',
      sourceToolCallId: 'tool-call-first',
    });

    const [firstVersion] = await serverDB
      .select()
      .from(workVersions)
      .where(eq(workVersions.workId, firstWork!.id));
    const [secondVersion] = await serverDB
      .select()
      .from(workVersions)
      .where(eq(workVersions.workId, secondWork!.id));

    expect(firstVersion.cumulativeCost).toBe(0.03);
    expect(firstVersion.cumulativeUsage).toMatchObject({
      capturedAt: '2026-06-30T08:00:00.000Z',
      cost: { total: 0.03 },
    });
    expect(secondVersion.cumulativeCost).toBeNull();
    expect(secondVersion.cumulativeUsage).toBeNull();

    const byOperation = await workModel.listByRootOperation({ rootOperationId: 'op-cumulative' });
    const firstOperationWork = byOperation.find((item) => item.id === firstWork!.id);
    expect(firstOperationWork?.version.cumulativeCost).toBe(0.03);
  });

  it('keeps one work row and appends versions for task edits', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const task = await taskModel.create({ instruction: 'Original', name: 'Original title' });
    await serverDB.insert(messages).values({
      content: '',
      id: 'msg-tool-edit',
      role: 'tool',
      topicId,
      userId,
    });

    const first = await workModel.registerTask({
      role: 'created',
      rootOperationId: 'op-create',
      source: 'createTask',
      sourceToolCallId: 'tool-call-create',
      taskId: task.id,
      topicId,
    });

    await taskModel.update(task.id, {
      instruction: 'Updated instruction',
      name: 'Updated title',
    });

    const second = await workModel.registerTask({
      role: 'updated',
      rootOperationId: 'op-edit',
      source: 'editTask',
      sourceToolCallId: 'tool-call-edit',
      taskIdentifier: task.identifier,
      topicId,
    });
    await workModel.attachSourceMessage({
      rootOperationId: 'op-edit',
      sourceMessageId: 'msg-tool-edit',
      sourceToolCallId: 'tool-call-edit',
    });

    expect(second?.id).toBe(first?.id);
    expect(second?.title).toBe('Updated title');

    const workRows = await serverDB.select().from(works).where(eq(works.resourceId, task.id));
    expect(workRows).toHaveLength(1);

    const versions = await workModel.listVersions(first!.id);
    expect(versions.map((item) => item.version)).toEqual([2, 1]);
    expect(versions[0].context?.role).toBe('updated');
    expect(versions[0].context?.id).toBeTruthy();
    expect(expectTaskSnapshot(versions[0].snapshot).instruction).toBe('Updated instruction');

    const [updatedContext] = await serverDB
      .select()
      .from(workContexts)
      .where(eq(workContexts.sourceToolCallId, 'tool-call-edit'));
    expect(updatedContext.sourceMessageId).toBe('msg-tool-edit');
  });

  it('summarizes a task work on its latest operation with total version cost', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const task = await taskModel.create({
      description: 'Original description',
      instruction: 'Original',
      name: 'Original title',
    });

    const first = await workModel.registerTask({
      role: 'created',
      rootOperationId: 'op-summary-create',
      source: 'createTask',
      sourceToolCallId: 'tool-call-summary-create',
      taskId: task.id,
      topicId,
    });

    await taskModel.update(task.id, {
      description: 'Updated description',
      instruction: 'Updated instruction',
      name: 'Updated title',
    });

    await workModel.registerTask({
      role: 'updated',
      rootOperationId: 'op-summary-edit',
      source: 'editTask',
      sourceToolCallId: 'tool-call-summary-edit',
      taskIdentifier: task.identifier,
      topicId,
    });
    await taskModel.update(task.id, { description: 'Live task description after snapshot' });

    const pendingByOperation = await workModel.listSummariesByRootOperations({
      rootOperationIds: ['op-summary-create', 'op-summary-edit'],
    });
    expect(pendingByOperation['op-summary-create']).toEqual([]);
    expect(pendingByOperation['op-summary-edit']).toHaveLength(1);
    const pendingSummary = expectTaskSummaryItem(pendingByOperation['op-summary-edit']?.[0]);
    expect(pendingSummary).toMatchObject({
      context: expect.objectContaining({ role: 'updated', rootOperationId: 'op-summary-edit' }),
      id: first?.id,
      title: 'Updated title',
      totalCost: null,
      version: expect.objectContaining({ title: 'Updated title', version: 2 }),
    });
    expect(pendingSummary.task.description).toBe('Updated description');

    await workModel.updateVersionCumulativeUsage({
      cumulativeCost: 0.000_295,
      rootOperationId: 'op-summary-create',
      sourceToolCallId: 'tool-call-summary-create',
    });

    const partialCostByOperation = await workModel.listSummariesByRootOperations({
      rootOperationIds: ['op-summary-create', 'op-summary-edit'],
    });
    expect(partialCostByOperation['op-summary-edit']?.[0].totalCost).toBeCloseTo(0.000_295, 6);

    await workModel.updateVersionCumulativeUsage({
      cumulativeCost: 0.000_692,
      rootOperationId: 'op-summary-edit',
      sourceToolCallId: 'tool-call-summary-edit',
    });

    const byOperation = await workModel.listSummariesByRootOperations({
      rootOperationIds: ['op-summary-create', 'op-summary-edit'],
    });
    expect(byOperation['op-summary-create']).toEqual([]);
    expect(byOperation['op-summary-edit']).toHaveLength(1);
    expect(byOperation['op-summary-edit']?.[0].totalCost).toBeCloseTo(0.000_987, 6);

    const byConversation = await workModel.listSummariesByConversation({ topicId });
    expect(byConversation).toHaveLength(1);
    expect(byConversation[0]).toMatchObject({
      context: expect.objectContaining({ role: 'updated', rootOperationId: 'op-summary-edit' }),
      id: first?.id,
      version: expect.objectContaining({ title: 'Updated title', version: 2 }),
    });
    expect(byConversation[0].totalCost).toBeCloseTo(0.000_987, 6);
  });

  it('registers a document work using the backing document id', async () => {
    const agentDocumentModel = new AgentDocumentModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const doc = await agentDocumentModel.create(agentId, 'research.md', 'Research body', {
      metadata: { description: 'Research notes' },
      title: 'Research Notes',
    });

    const work = await workModel.registerDocument({
      agentDocumentId: doc.id,
      agentId,
      documentId: doc.documentId,
      role: 'created',
      rootOperationId: 'op-doc-create',
      source: 'createDocument',
      sourceToolCallId: 'tool-call-doc-create',
      title: doc.title,
      topicId,
      url: 'https://app.example.com/agent/agent-1/docs/doc-1',
    });

    expect(work).toBeDefined();
    expect(work).toMatchObject({
      resourceId: doc.documentId,
      resourceIdentifier: 'research.md',
      resourceType: 'document',
      title: 'Research Notes',
      type: 'document',
    });

    const versions = await workModel.listVersions(work!.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].snapshot).toMatchObject({
      document: {
        description: 'Research notes',
        id: doc.documentId,
        title: 'Research Notes',
        url: 'https://app.example.com/agent/agent-1/docs/doc-1',
      },
    });
    expect(versions[0].context?.metadata).toEqual({ agentDocumentId: doc.id });

    const [context] = await serverDB
      .select()
      .from(workContexts)
      .where(eq(workContexts.workId, work!.id));
    expect(context).toMatchObject({
      metadata: { agentDocumentId: doc.id },
      rootOperationId: 'op-doc-create',
      sourceToolCallId: 'tool-call-doc-create',
    });

    const byOperation = await workModel.listByRootOperation({ rootOperationId: 'op-doc-create' });
    expect(byOperation[0]).toMatchObject({
      document: expect.objectContaining({ id: doc.documentId, title: 'Research Notes' }),
      id: work?.id,
      type: 'document',
    });

    const summaries = await workModel.listSummariesByRootOperations({
      rootOperationIds: ['op-doc-create'],
    });
    expect(summaries['op-doc-create']?.[0]).toMatchObject({
      context: expect.objectContaining({
        metadata: { agentDocumentId: doc.id },
      }),
      document: expect.objectContaining({ description: 'Research notes', id: doc.documentId }),
      id: work?.id,
      type: 'document',
    });
  });

  it('uses the document content prefix when document description is empty', async () => {
    const agentDocumentModel = new AgentDocumentModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const content = [
      'This document explains how Work cards should display a useful document excerpt.',
      'It keeps the product panel populated even when document metadata has no description.',
      'The extra sentence makes the value long enough to verify truncation.',
    ].join('\n\n');
    const normalizedContent = content.replaceAll(/\s+/g, ' ').trim();
    const expectedDescription = `${normalizedContent.slice(0, 120)}...`;
    const doc = await agentDocumentModel.create(agentId, 'empty-description.md', content, {
      title: 'No Description',
    });

    const work = await workModel.registerDocument({
      agentDocumentId: doc.id,
      agentId,
      documentId: doc.documentId,
      role: 'created',
      rootOperationId: 'op-doc-empty-description',
      source: 'createDocument',
      sourceToolCallId: 'tool-call-doc-empty-description',
      title: doc.title,
      topicId,
    });

    const versions = await workModel.listVersions(work!.id);
    expect(expectDocumentSnapshot(versions[0].snapshot).description).toBe(expectedDescription);

    const byOperation = await workModel.listByRootOperation({
      rootOperationId: 'op-doc-empty-description',
    });
    expect(byOperation[0]).toMatchObject({
      document: expect.objectContaining({ description: expectedDescription }),
    });

    const summaries = await workModel.listSummariesByRootOperations({
      rootOperationIds: ['op-doc-empty-description'],
    });
    const documentSummary = expectDocumentSummaryItem(summaries['op-doc-empty-description']?.[0]);
    expect(documentSummary.document.description).toBe(expectedDescription);

    const byConversation = await workModel.listByConversation({ topicId });
    expect(byConversation[0]).toMatchObject({
      document: expect.objectContaining({ description: expectedDescription }),
    });
  });

  it('keeps one document work row and appends versions for document edits', async () => {
    const agentDocumentModel = new AgentDocumentModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const doc = await agentDocumentModel.create(agentId, 'draft.md', 'Draft body', {
      title: 'Draft',
    });

    const first = await workModel.registerDocument({
      agentDocumentId: doc.id,
      agentId,
      documentId: doc.documentId,
      role: 'created',
      rootOperationId: 'op-doc-create',
      source: 'createDocument',
      sourceToolCallId: 'tool-call-doc-create',
      title: 'Draft',
      topicId,
    });

    await agentDocumentModel.rename(doc.id, 'Renamed Draft');

    const second = await workModel.registerDocument({
      agentDocumentId: doc.id,
      agentId,
      documentId: doc.documentId,
      role: 'updated',
      rootOperationId: 'op-doc-rename',
      source: 'renameDocument',
      sourceToolCallId: 'tool-call-doc-rename',
      title: 'Renamed Draft',
      topicId,
    });

    const replay = await workModel.registerDocument({
      agentDocumentId: doc.id,
      agentId,
      documentId: doc.documentId,
      role: 'updated',
      rootOperationId: 'op-doc-rename',
      source: 'renameDocument',
      sourceToolCallId: 'tool-call-doc-rename',
      title: 'Renamed Draft',
      topicId,
    });

    expect(second?.id).toBe(first?.id);
    expect(replay?.id).toBe(first?.id);

    const workRows = await serverDB
      .select()
      .from(works)
      .where(eq(works.resourceId, doc.documentId));
    expect(workRows).toHaveLength(1);

    const versions = await workModel.listVersions(first!.id);
    expect(versions.map((item) => item.version)).toEqual([2, 1]);
    expect(versions[0].snapshot).toMatchObject({
      document: { id: doc.documentId, title: 'Renamed Draft' },
    });

    const contexts = await serverDB
      .select()
      .from(workContexts)
      .where(eq(workContexts.workId, first!.id));
    expect(contexts).toHaveLength(2);
  });

  it('deletes document work and cascades versions and contexts when agent document is removed', async () => {
    const agentDocumentModel = new AgentDocumentModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const doc = await agentDocumentModel.create(agentId, 'delete.md', 'Delete body', {
      title: 'Delete me',
    });

    const work = await workModel.registerDocument({
      agentDocumentId: doc.id,
      agentId,
      documentId: doc.documentId,
      role: 'created',
      source: 'createDocument',
      sourceToolCallId: 'tool-call-doc-delete',
      title: doc.title,
    });

    await agentDocumentModel.delete(doc.id);
    await workModel.deleteDocumentWork({
      agentDocumentId: doc.id,
      agentId,
      documentId: doc.documentId,
    });

    const workRows = await serverDB.select().from(works).where(eq(works.id, work!.id));
    const versionRows = await serverDB
      .select()
      .from(workVersions)
      .where(eq(workVersions.workId, work!.id));
    const contextRows = await serverDB
      .select()
      .from(workContexts)
      .where(eq(workContexts.workId, work!.id));

    expect(workRows).toHaveLength(0);
    expect(versionRows).toHaveLength(0);
    expect(contextRows).toHaveLength(0);
  });

  it('does not let another user register someone else document work', async () => {
    const agentDocumentModel = new AgentDocumentModel(serverDB, userId);
    const otherWorkModel = new WorkModel(serverDB, userId2);
    const doc = await agentDocumentModel.create(agentId, 'private.md', 'Private body');

    const work = await otherWorkModel.registerDocument({
      agentDocumentId: doc.id,
      agentId,
      documentId: doc.documentId,
      role: 'created',
      source: 'createDocument',
      sourceToolCallId: 'tool-call-other-doc-user',
      title: doc.title,
      topicId,
    });

    expect(work).toBeNull();
    const workRows = await serverDB.select().from(works);
    expect(workRows).toHaveLength(0);
  });

  it('registers Linear issue creates and appends versions for edits', async () => {
    const workModel = new WorkModel(serverDB, userId);

    const first = await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { team: 'Engineering', title: 'Linear Work issue' },
      data: {
        description: 'Track Linear issue as Work',
        id: 'issue-uuid-10966',
        identifier: 'LOBE-10966',
        labels: ['claude code'],
        priority: { name: 'High', value: 2 },
        state: { name: 'Backlog' },
        statusType: 'backlog',
        team: 'Engineering',
        teamId: 'team-1',
        title: 'Linear Work issue',
        url: 'https://linear.app/lobehub/issue/LOBE-10966/linear-work-issue',
      },
      rootOperationId: 'op-linear-issue-create',
      sourceToolCallId: 'tool-call-linear-issue-create',
      toolName: 'save_issue',
      topicId,
    });

    const second = await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { id: 'issue-uuid-10966', state: 'In Progress' },
      data: {
        id: 'issue-uuid-10966',
        state: 'In Progress',
        statusType: 'started',
        updatedAt: '2026-07-01T13:23:10.614Z',
      },
      rootOperationId: 'op-linear-issue-edit',
      sourceToolCallId: 'tool-call-linear-issue-edit',
      toolName: 'save_issue',
      topicId,
    });
    const replay = await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { id: 'issue-uuid-10966', state: 'In Progress' },
      data: {
        id: 'issue-uuid-10966',
        state: 'In Progress',
      },
      rootOperationId: 'op-linear-issue-edit',
      sourceToolCallId: 'tool-call-linear-issue-edit',
      toolName: 'save_issue',
      topicId,
    });

    expect(second?.id).toBe(first?.id);
    expect(replay?.id).toBe(first?.id);
    expect(second).toMatchObject({
      resourceId: 'issue-uuid-10966',
      resourceIdentifier: 'LOBE-10966',
      resourceType: 'linear_issue',
      title: 'Linear Work issue',
      type: 'linear',
    });

    const versions = await workModel.listVersions(first!.id);
    expect(versions.map((item) => item.version)).toEqual([2, 1]);
    expect(versions[0].context?.role).toBe('updated');
    expect(expectLinearSnapshot(versions[0].snapshot)).toMatchObject({
      description: 'Track Linear issue as Work',
      entityType: 'issue',
      id: 'issue-uuid-10966',
      identifier: 'LOBE-10966',
      labels: ['claude code'],
      priority: 'High',
      priorityValue: 2,
      status: 'In Progress',
      statusType: 'started',
      team: 'Engineering',
      teamId: 'team-1',
      title: 'Linear Work issue',
      updatedAt: '2026-07-01T13:23:10.614Z',
    });
    expect(expectLinearSnapshot(versions[0].snapshot)).not.toHaveProperty('raw');
    expect(expectLinearSnapshot(versions[1].snapshot).status).toBe('Backlog');
    expect(expectLinearSnapshot(versions[1].snapshot)).toMatchObject({
      labels: ['claude code'],
      priority: 'High',
      priorityValue: 2,
      team: 'Engineering',
      teamId: 'team-1',
    });

    const byOperation = await workModel.listSummariesByRootOperations({
      rootOperationIds: ['op-linear-issue-create', 'op-linear-issue-edit'],
    });
    expect(byOperation['op-linear-issue-create']).toEqual([]);
    const issueSummary = expectLinearSummaryItem(byOperation['op-linear-issue-edit']?.[0]);
    expect(issueSummary.linear).toMatchObject({
      entityType: 'issue',
      identifier: 'LOBE-10966',
      labels: ['claude code'],
      priority: 'High',
      status: 'In Progress',
      team: 'Engineering',
    });

    const byConversation = await workModel.listByConversation({ topicId });
    expect(byConversation).toHaveLength(1);
    expect(byConversation[0]).toMatchObject({
      linear: expect.objectContaining({ entityType: 'issue' }),
      resourceType: 'linear_issue',
      type: 'linear',
    });

    await workModel.handleSkillToolResult({
      provider: 'linear',
      data: { id: 'issue-uuid-read', title: 'Read only' },
      sourceToolCallId: 'tool-call-linear-read',
      toolName: 'get_issue',
      topicId,
    });
    await workModel.handleSkillToolResult({
      provider: 'linear',
      data: { error: 'Invalid issue', isError: true },
      sourceToolCallId: 'tool-call-linear-error',
      toolName: 'save_issue',
      topicId,
    });

    const workRows = await serverDB
      .select()
      .from(works)
      .where(eq(works.resourceType, 'linear_issue'));
    expect(workRows).toHaveLength(1);
  });

  it('registers Linear documents and keeps merged snapshots across partial updates', async () => {
    const workModel = new WorkModel(serverDB, userId);

    const document = await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { title: 'Linear document', team: 'Engineering' },
      data: JSON.stringify({
        document: {
          content: 'Document body',
          id: 'doc-1',
          slug: 'linear-document',
          title: 'Linear document',
          url: 'https://linear.app/lobehub/document/linear-document',
        },
      }),
      rootOperationId: 'op-linear-document-create',
      sourceToolCallId: 'tool-call-linear-document-create',
      toolName: 'create_document',
      topicId,
    });
    const editedDocument = await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { content: 'Updated body', id: 'doc-1' },
      data: {
        content: 'Updated body',
        id: 'doc-1',
        slugId: '8298fa69b2e3',
        title: 'Linear document updated',
        url: 'https://linear.app/lobehub/document/linear-document-8298fa69b2e3',
      },
      rootOperationId: 'op-linear-document-edit',
      sourceToolCallId: 'tool-call-linear-document-edit',
      toolName: 'save_document',
      topicId,
    });
    const partialDocumentUpdate = await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { content: 'Partial body', id: 'doc-1' },
      data: {
        content: 'Partial body',
        id: 'doc-1',
      },
      rootOperationId: 'op-linear-document-partial-edit',
      sourceToolCallId: 'tool-call-linear-document-partial-edit',
      toolName: 'save_document',
      topicId,
    });

    // Comments are intentionally NOT adapted as Work entities — a comment
    // mutation must neither create its own work nor touch the parent issue.
    const comment = await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { body: 'Looks good', issueId: 'LOBE-10966' },
      data: {
        body: 'Looks good',
        id: 'comment-1',
        url: 'https://linear.app/lobehub/issue/LOBE-10966#comment-1',
      },
      rootOperationId: 'op-linear-comment-create',
      sourceToolCallId: 'tool-call-linear-comment-create',
      toolName: 'save_comment',
      topicId,
    });
    expect(comment).toBeNull();

    expect(document).toMatchObject({
      resourceId: 'doc-1',
      resourceIdentifier: 'linear-document',
      resourceType: 'linear_document',
      type: 'linear',
    });
    expect(editedDocument).toMatchObject({
      resourceIdentifier: 'linear-document-8298fa69b2e3',
      title: 'Linear document updated',
    });
    expect(partialDocumentUpdate).toMatchObject({
      resourceIdentifier: 'linear-document-8298fa69b2e3',
      title: 'Linear document updated',
    });

    const documentVersions = await workModel.listVersions(document!.id);
    expect(documentVersions.map((item) => item.version)).toEqual([3, 2, 1]);
    expect(expectLinearSnapshot(documentVersions[0].snapshot)).toMatchObject({
      content: 'Partial body',
      entityType: 'document',
      id: 'doc-1',
      identifier: 'linear-document-8298fa69b2e3',
      slugId: '8298fa69b2e3',
      title: 'Linear document updated',
    });
    expect(expectLinearSnapshot(documentVersions[1].snapshot)).toMatchObject({
      content: 'Updated body',
      identifier: 'linear-document-8298fa69b2e3',
    });

    await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { id: 'comment-1' },
      data: { id: 'comment-1' },
      sourceToolCallId: 'tool-call-linear-comment-delete',
      toolName: 'delete_comment',
      topicId,
    });

    const commentWork = await serverDB
      .select()
      .from(works)
      .where(eq(works.resourceId, 'comment-1'));
    const documentWork = await serverDB.select().from(works).where(eq(works.resourceId, 'doc-1'));
    expect(commentWork).toHaveLength(0);
    expect(documentWork).toHaveLength(1);
  });

  it('registers GitHub issue creates and appends versions for edits', async () => {
    const workModel = new WorkModel(serverDB, userId);

    const first = await workModel.handleSkillToolResult({
      provider: 'github',
      args: { owner: 'lobehub', repo: 'lobehub', title: 'GitHub Work issue' },
      data: {
        assignees: [{ login: 'arvinxx' }],
        body: 'Track GitHub issue as Work',
        html_url: 'https://github.com/lobehub/lobehub/issues/123',
        id: 3_001,
        labels: [{ name: 'enhancement' }],
        node_id: 'I_kwDOJj1234',
        number: 123,
        state: 'open',
        title: 'GitHub Work issue',
        updated_at: '2026-07-02T08:00:00Z',
        user: { login: 'yutengjing' },
      },
      rootOperationId: 'op-github-issue-create',
      sourceToolCallId: 'tool-call-github-issue-create',
      toolName: 'create_issue',
      topicId,
    });

    const second = await workModel.handleSkillToolResult({
      provider: 'github',
      args: { issue_number: 123, owner: 'lobehub', repo: 'lobehub', state: 'closed' },
      data: {
        html_url: 'https://github.com/lobehub/lobehub/issues/123',
        node_id: 'I_kwDOJj1234',
        number: 123,
        state: 'closed',
        state_reason: 'completed',
        updated_at: '2026-07-02T09:30:00Z',
      },
      rootOperationId: 'op-github-issue-edit',
      sourceToolCallId: 'tool-call-github-issue-edit',
      toolName: 'update_issue',
      topicId,
    });
    const replay = await workModel.handleSkillToolResult({
      provider: 'github',
      args: { issue_number: 123, owner: 'lobehub', repo: 'lobehub', state: 'closed' },
      data: {
        node_id: 'I_kwDOJj1234',
        number: 123,
        state: 'closed',
      },
      rootOperationId: 'op-github-issue-edit',
      sourceToolCallId: 'tool-call-github-issue-edit',
      toolName: 'update_issue',
      topicId,
    });

    expect(second?.id).toBe(first?.id);
    expect(replay?.id).toBe(first?.id);
    // `owner/repo#number` is the canonical identity — the gh CLI surface never
    // returns node_id, so both surfaces must share this dedup key.
    expect(second).toMatchObject({
      resourceId: 'lobehub/lobehub#123',
      resourceIdentifier: 'lobehub/lobehub#123',
      resourceType: 'github_issue',
      title: 'GitHub Work issue',
      type: 'github',
    });

    const versions = await workModel.listVersions(first!.id);
    expect(versions.map((item) => item.version)).toEqual([2, 1]);
    expect(versions[0].context?.role).toBe('updated');
    // Partial update responses keep prior snapshot fields (title/body/labels).
    expect(expectGithubSnapshot(versions[0].snapshot)).toMatchObject({
      assignees: ['arvinxx'],
      author: 'yutengjing',
      body: 'Track GitHub issue as Work',
      entityType: 'issue',
      id: 'lobehub/lobehub#123',
      labels: ['enhancement'],
      number: 123,
      repo: 'lobehub/lobehub',
      state: 'closed',
      stateReason: 'completed',
      title: 'GitHub Work issue',
      updatedAt: '2026-07-02T09:30:00Z',
      url: 'https://github.com/lobehub/lobehub/issues/123',
    });
    expect(expectGithubSnapshot(versions[1].snapshot).state).toBe('open');

    const byOperation = await workModel.listSummariesByRootOperations({
      rootOperationIds: ['op-github-issue-create', 'op-github-issue-edit'],
    });
    expect(byOperation['op-github-issue-create']).toEqual([]);
    const issueSummary = expectGithubSummaryItem(byOperation['op-github-issue-edit']?.[0]);
    expect(issueSummary.github).toMatchObject({
      entityType: 'issue',
      repo: 'lobehub/lobehub',
      state: 'closed',
    });

    const byConversation = await workModel.listByConversation({ topicId });
    expect(byConversation).toHaveLength(1);
    expect(byConversation[0]).toMatchObject({
      github: expect.objectContaining({ entityType: 'issue' }),
      resourceType: 'github_issue',
      type: 'github',
    });

    // Read-only queries and failed results never register Works.
    await workModel.handleSkillToolResult({
      provider: 'github',
      data: { node_id: 'I_kwDOJjRead', number: 200, title: 'Read only' },
      sourceToolCallId: 'tool-call-github-read',
      toolName: 'get_issue',
      topicId,
    });
    await workModel.handleSkillToolResult({
      provider: 'github',
      data: { error: 'Validation failed', isError: true },
      sourceToolCallId: 'tool-call-github-error',
      toolName: 'create_issue',
      topicId,
    });

    const workRows = await serverDB
      .select()
      .from(works)
      .where(eq(works.resourceType, 'github_issue'));
    expect(workRows).toHaveLength(1);
  });

  it('registers GitHub pull requests and dedupes updates by owner/repo#number', async () => {
    const workModel = new WorkModel(serverDB, userId);

    const pullRequest = await workModel.handleSkillToolResult({
      provider: 'github',
      args: { base: 'canary', head: 'feat/work-registry', owner: 'lobehub', repo: 'lobehub' },
      data: JSON.stringify({
        base: { ref: 'canary', repo: { full_name: 'lobehub/lobehub' } },
        body: 'Adds the Work registry',
        draft: false,
        head: { ref: 'feat/work-registry' },
        html_url: 'https://github.com/lobehub/lobehub/pull/456',
        id: 9_001,
        merged: false,
        node_id: 'PR_kwDOJj5678',
        number: 456,
        state: 'open',
        title: 'feat: add work registry',
        user: { login: 'yutengjing' },
      }),
      rootOperationId: 'op-github-pr-create',
      sourceToolCallId: 'tool-call-github-pr-create',
      toolName: 'create_pull_request',
      topicId,
    });

    expect(pullRequest).toMatchObject({
      resourceId: 'lobehub/lobehub#456',
      resourceIdentifier: 'lobehub/lobehub#456',
      resourceType: 'github_pull_request',
      title: 'feat: add work registry',
      type: 'github',
    });

    // Merge-style responses carry no node_id; the target still resolves to
    // the same `owner/repo#number` identity and lands on the existing Work.
    const merged = await workModel.handleSkillToolResult({
      provider: 'github',
      args: { owner: 'lobehub', pull_number: 456, repo: 'lobehub' },
      data: {
        merged: true,
        message: 'Pull Request successfully merged',
        sha: 'abc123def456',
      },
      rootOperationId: 'op-github-pr-merge',
      sourceToolCallId: 'tool-call-github-pr-merge',
      toolName: 'update_pull_request',
      topicId,
    });

    expect(merged?.id).toBe(pullRequest?.id);

    const versions = await workModel.listVersions(pullRequest!.id);
    expect(versions.map((item) => item.version)).toEqual([2, 1]);
    expect(expectGithubSnapshot(versions[0].snapshot)).toMatchObject({
      baseRef: 'canary',
      body: 'Adds the Work registry',
      entityType: 'pull_request',
      headRef: 'feat/work-registry',
      merged: true,
      number: 456,
      repo: 'lobehub/lobehub',
      title: 'feat: add work registry',
    });

    // An update addressing an entity not registered before still creates its
    // own Work row keyed by identity (consistent with the Linear adaptation).
    const unknownTarget = await workModel.handleSkillToolResult({
      provider: 'github',
      args: { owner: 'lobehub', pull_number: 999, repo: 'lobehub' },
      data: { merged: true, sha: 'fff000' },
      sourceToolCallId: 'tool-call-github-pr-unknown',
      toolName: 'update_pull_request',
      topicId,
    });
    expect(unknownTarget?.resourceId).toBe('lobehub/lobehub#999');
    expect(unknownTarget?.id).not.toBe(pullRequest?.id);

    // A result with no resolvable `owner/repo#number` identity is skipped.
    const unresolvable = await workModel.handleSkillToolResult({
      provider: 'github',
      args: {},
      data: { merged: true },
      sourceToolCallId: 'tool-call-github-pr-unresolvable',
      toolName: 'update_pull_request',
      topicId,
    });
    expect(unresolvable).toBeNull();

    const workRows = await serverDB
      .select()
      .from(works)
      .where(eq(works.resourceType, 'github_pull_request'));
    expect(workRows).toHaveLength(2);
  });

  it('registers GitHub works from sandbox gh CLI runCommand results', async () => {
    const workModel = new WorkModel(serverDB, userId);

    // The dominant github skill surface: `gh` executed in the cloud sandbox,
    // where the result is only {command, exitCode, output}.
    const created = await workModel.handleSkillToolResult({
      provider: 'github',
      args: {
        command:
          'issue create -R lobehub-biz/lobehub-cloud --title "CLI Issue" --body "created from sandbox"',
        description: 'Create a test issue',
      },
      data: {
        command:
          'gh issue create -R lobehub-biz/lobehub-cloud --title "CLI Issue" --body "created from sandbox"',
        exitCode: 0,
        output: 'https://github.com/lobehub-biz/lobehub-cloud/issues/952\n',
      },
      rootOperationId: 'op-github-cli-create',
      sourceToolCallId: 'tool-call-github-cli-create',
      toolName: 'runCommand',
      topicId,
    });

    expect(created).toMatchObject({
      resourceId: 'lobehub-biz/lobehub-cloud#952',
      resourceIdentifier: 'lobehub-biz/lobehub-cloud#952',
      resourceType: 'github_issue',
      title: 'CLI Issue',
      type: 'github',
    });

    // Chained commands: the trailing stdout URL identifies the edited entity.
    const edited = await workModel.handleSkillToolResult({
      provider: 'github',
      data: {
        command:
          'git status && gh issue edit 952 -R lobehub-biz/lobehub-cloud --body "updated body"',
        exitCode: 0,
        output: 'On branch main\nhttps://github.com/lobehub-biz/lobehub-cloud/issues/952\n',
      },
      rootOperationId: 'op-github-cli-edit',
      sourceToolCallId: 'tool-call-github-cli-edit',
      toolName: 'runCommand',
      topicId,
    });
    expect(edited?.id).toBe(created?.id);

    const versions = await workModel.listVersions(created!.id);
    expect(versions.map((item) => item.version)).toEqual([2, 1]);
    expect(versions[0].context?.role).toBe('updated');
    // Patch merge keeps create-time title/state while applying the new body.
    expect(expectGithubSnapshot(versions[0].snapshot)).toMatchObject({
      body: 'updated body',
      entityType: 'issue',
      number: 952,
      repo: 'lobehub-biz/lobehub-cloud',
      state: 'open',
      title: 'CLI Issue',
      url: 'https://github.com/lobehub-biz/lobehub-cloud/issues/952',
    });

    const pullRequest = await workModel.handleSkillToolResult({
      provider: 'github',
      data: {
        command:
          'gh pr create -R lobehub-biz/lobehub-cloud --title "CLI PR" --body "pr body" --base main --head feat/cli --draft',
        exitCode: 0,
        output: 'https://github.com/lobehub-biz/lobehub-cloud/pull/953\n',
      },
      sourceToolCallId: 'tool-call-github-cli-pr',
      toolName: 'runCommand',
      topicId,
    });
    expect(pullRequest).toMatchObject({
      resourceId: 'lobehub-biz/lobehub-cloud#953',
      resourceType: 'github_pull_request',
      title: 'CLI PR',
    });
    const prVersions = await workModel.listVersions(pullRequest!.id);
    expect(expectGithubSnapshot(prVersions[0].snapshot)).toMatchObject({
      baseRef: 'main',
      draft: true,
      entityType: 'pull_request',
      headRef: 'feat/cli',
      state: 'open',
    });

    // Failed commands, read-only subcommands, and non-gh commands are skipped.
    const failed = await workModel.handleSkillToolResult({
      provider: 'github',
      data: {
        command: 'gh issue create -R lobehub-biz/lobehub-cloud --title X',
        exitCode: 1,
        output: 'GraphQL: Resource not accessible',
      },
      sourceToolCallId: 'tool-call-github-cli-failed',
      toolName: 'runCommand',
      topicId,
    });
    const readOnly = await workModel.handleSkillToolResult({
      provider: 'github',
      data: {
        command: 'gh issue view 952 -R lobehub-biz/lobehub-cloud',
        exitCode: 0,
        output: 'CLI Issue #952\nhttps://github.com/lobehub-biz/lobehub-cloud/issues/952',
      },
      sourceToolCallId: 'tool-call-github-cli-view',
      toolName: 'runCommand',
      topicId,
    });
    const nonGh = await workModel.handleSkillToolResult({
      provider: 'github',
      data: { command: 'git push origin main', exitCode: 0, output: 'Everything up-to-date' },
      sourceToolCallId: 'tool-call-github-cli-git',
      toolName: 'runCommand',
      topicId,
    });
    expect(failed).toBeNull();
    expect(readOnly).toBeNull();
    expect(nonGh).toBeNull();

    const workRows = await serverDB.select().from(works).where(eq(works.type, 'github'));
    expect(workRows).toHaveLength(2);
  });

  it('keeps Linear works isolated by user for the same external resource', async () => {
    const otherTopicId = 'work-test-other-linear-topic-id';
    await serverDB.insert(topics).values({ id: otherTopicId, userId: userId2 });

    const workModel = new WorkModel(serverDB, userId);
    const otherWorkModel = new WorkModel(serverDB, userId2);

    const ownerWork = await workModel.handleSkillToolResult({
      provider: 'linear',
      args: { team: 'Engineering', title: 'Owner issue title' },
      data: {
        id: 'shared-issue-uuid',
        identifier: 'LOBE-10966',
        title: 'Owner issue title',
        url: 'https://linear.app/lobehub/issue/LOBE-10966/shared-issue',
      },
      sourceToolCallId: 'tool-call-linear-owner-issue',
      toolName: 'save_issue',
      topicId,
    });
    const otherWork = await otherWorkModel.handleSkillToolResult({
      provider: 'linear',
      args: { id: 'shared-issue-uuid', title: 'Other user issue title' },
      data: {
        id: 'shared-issue-uuid',
        identifier: 'LOBE-10966',
        title: 'Other user issue title',
        url: 'https://linear.app/lobehub/issue/LOBE-10966/shared-issue',
      },
      sourceToolCallId: 'tool-call-linear-other-issue',
      toolName: 'save_issue',
      topicId: otherTopicId,
    });

    expect(ownerWork?.id).not.toBe(otherWork?.id);

    const ownerItems = await workModel.listByConversation({ topicId });
    const otherItems = await otherWorkModel.listByConversation({ topicId: otherTopicId });
    expect(ownerItems).toHaveLength(1);
    expect(ownerItems[0]).toMatchObject({
      id: ownerWork!.id,
      resourceId: 'shared-issue-uuid',
      title: 'Owner issue title',
      type: 'linear',
    });
    expect(otherItems).toHaveLength(1);
    expect(otherItems[0]).toMatchObject({
      id: otherWork!.id,
      title: 'Other user issue title',
      type: 'linear',
    });
  });

  it('does not let another user register someone else task', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const otherWorkModel = new WorkModel(serverDB, userId2);
    const task = await taskModel.create({ instruction: 'Private task' });

    const work = await otherWorkModel.registerTask({
      role: 'created',
      source: 'createTask',
      sourceToolCallId: 'tool-call-other-user',
      taskIdentifier: task.identifier,
      topicId,
    });

    expect(work).toBeNull();
    const workRows = await serverDB.select().from(works);
    expect(workRows).toHaveLength(0);
  });

  it('does not expose another user task work summaries', async () => {
    const otherTopicId = 'work-test-other-topic-id';
    await serverDB.insert(topics).values({ id: otherTopicId, userId: userId2 });
    const otherTaskModel = new TaskModel(serverDB, userId2);
    const otherWorkModel = new WorkModel(serverDB, userId2);
    const workModel = new WorkModel(serverDB, userId);
    const otherTask = await otherTaskModel.create({
      instruction: 'Other user summary',
      name: 'Private summary',
    });

    await otherWorkModel.registerTask({
      role: 'created',
      rootOperationId: 'op-other-summary',
      source: 'createTask',
      sourceToolCallId: 'tool-call-other-summary',
      taskId: otherTask.id,
      topicId: otherTopicId,
    });

    expect(await workModel.listSummariesByConversation({ topicId: otherTopicId })).toEqual([]);
    expect(
      await workModel.listSummariesByRootOperations({ rootOperationIds: ['op-other-summary'] }),
    ).toEqual({ 'op-other-summary': [] });
  });

  it('deletes task work and cascades versions and contexts when the task is deleted', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const task = await taskModel.create({ instruction: 'Delete task work', name: 'Delete me' });

    const work = await workModel.registerTask({
      role: 'created',
      rootOperationId: 'op-delete-task',
      source: 'createTask',
      sourceToolCallId: 'tool-call-delete-task',
      taskId: task.id,
      threadId,
      topicId,
    });

    await taskModel.delete(task.id);

    const workRows = await serverDB.select().from(works).where(eq(works.id, work!.id));
    const versionRows = await serverDB
      .select()
      .from(workVersions)
      .where(eq(workVersions.workId, work!.id));
    const contextRows = await serverDB
      .select()
      .from(workContexts)
      .where(eq(workContexts.workId, work!.id));

    expect(workRows).toHaveLength(0);
    expect(versionRows).toHaveLength(0);
    expect(contextRows).toHaveLength(0);
    expect(await workModel.listByRootOperation({ rootOperationId: 'op-delete-task' })).toEqual([]);
    expect(await workModel.listByConversation({ threadId, topicId })).toEqual([]);
  });

  it('clears task works for the current owner without touching another owner', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const otherTaskModel = new TaskModel(serverDB, userId2);
    const workModel = new WorkModel(serverDB, userId);
    const otherWorkModel = new WorkModel(serverDB, userId2);
    const task = await taskModel.create({ instruction: 'Owner task' });
    const otherTask = await otherTaskModel.create({ instruction: 'Other owner task' });

    const work = await workModel.registerTask({
      role: 'created',
      source: 'createTask',
      sourceToolCallId: 'tool-call-owner-clear',
      taskId: task.id,
    });
    const otherWork = await otherWorkModel.registerTask({
      role: 'created',
      source: 'createTask',
      sourceToolCallId: 'tool-call-other-clear',
      taskId: otherTask.id,
    });

    await taskModel.deleteAll();

    const deletedTasks = await serverDB.select().from(tasks).where(eq(tasks.id, task.id));
    const remainingOtherTasks = await serverDB
      .select()
      .from(tasks)
      .where(eq(tasks.id, otherTask.id));
    const deletedWorkRows = await serverDB.select().from(works).where(eq(works.id, work!.id));
    const remainingOtherWorkRows = await serverDB
      .select()
      .from(works)
      .where(eq(works.id, otherWork!.id));

    expect(deletedTasks).toHaveLength(0);
    expect(remainingOtherTasks).toHaveLength(1);
    expect(deletedWorkRows).toHaveLength(0);
    expect(remainingOtherWorkRows).toHaveLength(1);
  });

  it('preserves work and versions when the topic context is deleted', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const task = await taskModel.create({ instruction: 'Topic scoped task' });

    const work = await workModel.registerTask({
      role: 'created',
      source: 'createTask',
      sourceToolCallId: 'tool-call-topic-delete',
      taskId: task.id,
      topicId,
    });

    await serverDB.delete(topics).where(eq(topics.id, topicId));

    const workRows = await serverDB.select().from(works).where(eq(works.id, work!.id));
    const versionRows = await serverDB
      .select()
      .from(workVersions)
      .where(eq(workVersions.workId, work!.id));
    const contextRows = await serverDB
      .select()
      .from(workContexts)
      .where(eq(workContexts.workId, work!.id));

    expect(workRows).toHaveLength(1);
    expect(versionRows).toHaveLength(1);
    expect(contextRows).toHaveLength(1);
    expect(contextRows[0].topicId).toBeNull();
  });
});
