import type { UIChatMessage, WorkSummaryItem } from '@lobechat/types';

import { getOperationFinalRootId } from './workRootOperationIds';

const toTime = (value: unknown): number => {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return Number.isNaN(time) ? 0 : time;
};

/**
 * Build a `rootOperationId -> works` index from the raw db messages. The server
 * attaches each round's Work summaries to its anchor message (keyed by
 * `metadata.work.rootOperationId`), so a single flat pass over the raw rows
 * reconstructs the lookup the in-message chips need — no dedicated fetch.
 */
const buildWorkSummaryIndex = (messages: UIChatMessage[]): Map<string, WorkSummaryItem[]> => {
  const index = new Map<string, WorkSummaryItem[]>();
  for (const message of messages) {
    const works = message.works;
    if (!works || works.length === 0) continue;
    // Prefer the anchor message's own stamp; fall back to the work event's
    // rootOperationId so the lookup key always matches what the chip resolves.
    const rootOperationId =
      getOperationFinalRootId(message.metadata) ?? works[0].event.rootOperationId;
    if (rootOperationId) index.set(rootOperationId, works);
  }
  return index;
};

// Memoize per dbMessages array identity so the pass runs once per snapshot,
// regardless of how many MessageWorks instances read from it.
const indexCache = new WeakMap<UIChatMessage[], Map<string, WorkSummaryItem[]>>();

const getWorkSummaryIndex = (messages: UIChatMessage[]): Map<string, WorkSummaryItem[]> => {
  let index = indexCache.get(messages);
  if (!index) {
    index = buildWorkSummaryIndex(messages);
    indexCache.set(messages, index);
  }
  return index;
};

/** Works for one round's chip, resolved by the display-resolved rootOperationId. */
export const getWorkSummariesByRootOperationId = (
  messages: UIChatMessage[],
  rootOperationId?: string | null,
): WorkSummaryItem[] =>
  rootOperationId ? (getWorkSummaryIndex(messages).get(rootOperationId) ?? []) : [];

/**
 * Flatten every message's Work summaries into the conversation-wide list the
 * Works sidebar (summary mode) renders: one row per Work, deduped to its latest
 * event and sorted newest-first. Mirrors the server `latestSummaryItemsByWork`
 * shaping the removed `listSummariesByConversation` used to return.
 */
const buildAllWorkSummaries = (messages: UIChatMessage[]): WorkSummaryItem[] => {
  const latestByWork = new Map<string, WorkSummaryItem>();
  for (const message of messages) {
    for (const work of message.works ?? []) {
      const existing = latestByWork.get(work.id);
      if (!existing || toTime(work.event.createdAt) > toTime(existing.event.createdAt)) {
        latestByWork.set(work.id, work);
      }
    }
  }
  return Array.from(latestByWork.values()).sort(
    (a, b) => toTime(b.event.createdAt) - toTime(a.event.createdAt),
  );
};

const allWorkSummariesCache = new WeakMap<UIChatMessage[], WorkSummaryItem[]>();

export const getAllWorkSummaries = (messages: UIChatMessage[]): WorkSummaryItem[] => {
  let list = allWorkSummariesCache.get(messages);
  if (!list) {
    list = buildAllWorkSummaries(messages);
    allWorkSummariesCache.set(messages, list);
  }
  return list;
};
