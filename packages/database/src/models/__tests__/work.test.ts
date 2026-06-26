// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { threads, topics, users, workContexts, works, workVersions } from '../../schemas';
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

    const work = await workModel.registerTask({
      role: 'created',
      source: 'createTask',
      taskId: task.id,
      threadId,
      toolCallId: 'tool-call-create',
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
  });

  it('keeps one work row and appends versions for task edits', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const task = await taskModel.create({ instruction: 'Original', name: 'Original title' });

    const first = await workModel.registerTask({
      role: 'created',
      source: 'createTask',
      taskId: task.id,
      toolCallId: 'tool-call-create',
      topicId,
    });

    await taskModel.update(task.id, {
      instruction: 'Updated instruction',
      name: 'Updated title',
    });

    const second = await workModel.registerTask({
      role: 'updated',
      source: 'editTask',
      taskIdentifier: task.identifier,
      toolCallId: 'tool-call-edit',
      topicId,
    });

    expect(second?.id).toBe(first?.id);
    expect(second?.title).toBe('Updated title');

    const workRows = await serverDB.select().from(works).where(eq(works.resourceId, task.id));
    expect(workRows).toHaveLength(1);

    const versions = await workModel.listVersions(first!.id);
    expect(versions.map((item) => item.version)).toEqual([2, 1]);
    expect(versions[0].context?.role).toBe('updated');
    expect(versions[0].snapshot.task.instruction).toBe('Updated instruction');
  });

  it('does not let another user register someone else task', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const otherWorkModel = new WorkModel(serverDB, userId2);
    const task = await taskModel.create({ instruction: 'Private task' });

    const work = await otherWorkModel.registerTask({
      role: 'created',
      source: 'createTask',
      taskIdentifier: task.identifier,
      toolCallId: 'tool-call-other-user',
      topicId,
    });

    expect(work).toBeNull();
    const workRows = await serverDB.select().from(works);
    expect(workRows).toHaveLength(0);
  });

  it('preserves work and versions when the topic context is deleted', async () => {
    const taskModel = new TaskModel(serverDB, userId);
    const workModel = new WorkModel(serverDB, userId);
    const task = await taskModel.create({ instruction: 'Topic scoped task' });

    const work = await workModel.registerTask({
      role: 'created',
      source: 'createTask',
      taskId: task.id,
      toolCallId: 'tool-call-topic-delete',
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
