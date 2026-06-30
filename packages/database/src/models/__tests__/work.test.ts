// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
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
import { TaskModel } from '../task';
import { WorkModel } from '../work';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'work-test-user-id';
const userId2 = 'work-test-user-id-2';
const topicId = 'work-test-topic-id';
const threadId = 'work-test-thread-id';

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: userId2 }]);
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
    expect(versions[0].snapshot.task.identifier).toBe(task.identifier);

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
    expect(versions[0].snapshot.task.instruction).toBe('Updated instruction');

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
    expect(pendingByOperation['op-summary-edit']?.[0]).toMatchObject({
      context: expect.objectContaining({ role: 'updated', rootOperationId: 'op-summary-edit' }),
      id: first?.id,
      title: 'Updated title',
      totalCost: null,
      version: expect.objectContaining({ title: 'Updated title', version: 2 }),
    });
    expect(pendingByOperation['op-summary-edit']?.[0].task.description).toBe('Updated description');

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
