import type { AssistantContentBlock, UIChatMessage } from '@lobechat/types';

/**
 * Reads the operation-final work root id stamped on message/block metadata by
 * the server work registry (`metadata.work.rootOperationId`).
 */
export const getOperationFinalRootId = (
  metadata?: { work?: { rootOperationId?: unknown } } | null,
) =>
  typeof metadata?.work?.rootOperationId === 'string' ? metadata.work.rootOperationId : undefined;

const addRootId = (rootOperationIds: Set<string>, rootOperationId?: string) => {
  if (rootOperationId) rootOperationIds.add(rootOperationId);
};

const collectBlockWorkRootIds = (block: AssistantContentBlock, rootOperationIds: Set<string>) => {
  addRootId(rootOperationIds, getOperationFinalRootId(block.metadata));

  for (const message of block.council ?? []) {
    collectMessageWorkRootIds(message, rootOperationIds);
  }
};

const collectMessageWorkRootIds = (message: UIChatMessage, rootOperationIds: Set<string>) => {
  addRootId(rootOperationIds, getOperationFinalRootId(message.metadata));

  for (const block of message.children ?? []) {
    collectBlockWorkRootIds(block, rootOperationIds);
  }

  for (const block of message.taskCompletions ?? []) {
    collectBlockWorkRootIds(block, rootOperationIds);
  }

  for (const child of message.compressedMessages ?? []) {
    collectMessageWorkRootIds(child, rootOperationIds);
  }

  for (const member of message.members ?? []) {
    collectMessageWorkRootIds(member, rootOperationIds);
  }

  for (const task of message.tasks ?? []) {
    collectMessageWorkRootIds(task, rootOperationIds);
  }
};

const collectWorkRootOperationIds = (messages: UIChatMessage[]) => {
  const rootOperationIds = new Set<string>();
  for (const message of messages) {
    collectMessageWorkRootIds(message, rootOperationIds);
  }
  return Array.from(rootOperationIds).sort();
};

/**
 * MessageWorks mounts once per assistant message, and each instance needs the
 * SAME conversation-wide id list (it keys the shared work-summary SWR fetch).
 * `displayMessages` is reference-stable store state, so memoizing per array
 * identity makes the full-tree traversal run once per messages snapshot
 * instead of once per mounted message. Consumed via
 * `dataSelectors.workRootOperationIds`.
 */
const workRootOperationIdsCache = new WeakMap<UIChatMessage[], string[]>();

export const getWorkRootOperationIds = (messages: UIChatMessage[]): string[] => {
  let ids = workRootOperationIdsCache.get(messages);
  if (!ids) {
    ids = collectWorkRootOperationIds(messages);
    workRootOperationIdsCache.set(messages, ids);
  }
  return ids;
};
