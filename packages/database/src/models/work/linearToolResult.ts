import type {
  DeleteLinearWorkParams,
  LinearWorkEntityType,
  LinearWorkResourceType,
  RegisterLinearToolResultWorkParams,
  RegisterLinearWorkParams,
} from '@lobechat/types';

const LINEAR_CREATE_TOOLS = new Set([
  'create_document',
  'save_comment',
  'save_document',
  'save_issue',
]);
const LINEAR_ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/u;
const MAX_LINEAR_SNAPSHOT_TEXT_LENGTH = 4000;

interface LinearToolRegisterOperation {
  params: RegisterLinearWorkParams;
  type: 'register';
}

interface LinearToolDeleteOperation {
  params: DeleteLinearWorkParams;
  type: 'delete';
}

export type LinearToolWorkOperation = LinearToolDeleteOperation | LinearToolRegisterOperation;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseMaybeJSON = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const stringValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed || null;
};

const snapshotText = (value: unknown): string | null => {
  const text = stringValue(value);
  if (!text) return null;

  return text.length > MAX_LINEAR_SNAPSHOT_TEXT_LENGTH
    ? `${text.slice(0, MAX_LINEAR_SNAPSHOT_TEXT_LENGTH)}...`
    : text;
};

const numberValue = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const nestedRecord = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const nested = toRecord(record[key]);
    if (nested) return nested;
  }

  return record;
};

const unwrapData = (data: unknown, keys: string[]) => {
  const parsed = parseMaybeJSON(data);
  if (Array.isArray(parsed)) return toRecord(parsed[0]) ?? null;

  const record = toRecord(parsed);
  if (!record) return null;

  return nestedRecord(record, keys);
};

const isApplicationError = (data: unknown) => {
  const record = toRecord(parseMaybeJSON(data));
  return record?.isError === true;
};

const fromRecord = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }

  return null;
};

const textFromRecord = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = snapshotText(record[key]);
    if (value) return value;
  }

  return null;
};

const fromNestedRecord = (record: Record<string, unknown>, key: string, keys: string[]) =>
  fromRecord(toRecord(record[key]) ?? {}, keys);

const numberFromRecord = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) return value;
  }

  return null;
};

const extractLabels = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const record = toRecord(item);
      return record ? fromRecord(record, ['name', 'id']) : stringValue(item);
    })
    .filter((label): label is string => !!label);
};

const isIssueIdentifier = (value: string | null) =>
  value ? LINEAR_ISSUE_IDENTIFIER_PATTERN.test(value) : false;

const urlSegmentAfter = (url: string | null, segmentName: string) => {
  if (!url) return null;

  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const index = segments.indexOf(segmentName);
    return index >= 0 ? decodeURIComponent(segments[index + 1] ?? '') || null : null;
  } catch {
    return null;
  }
};

const firstValue = (...values: Array<string | null | undefined>) =>
  values.find((value): value is string => !!value) ?? null;

const resolveTarget = (
  params: RegisterLinearToolResultWorkParams,
  record: Record<string, unknown>,
) => {
  const args = params.args ?? {};
  const issue = toRecord(record.issue);
  const document = toRecord(record.document);
  const initiative = toRecord(record.initiative);
  const milestone = toRecord(record.milestone);
  const project = toRecord(record.project);

  const issueId =
    fromRecord(record, ['issueId']) ?? fromRecord(issue ?? {}, ['id']) ?? stringValue(args.issueId);
  const documentId =
    fromRecord(record, ['documentId']) ??
    fromRecord(document ?? {}, ['id', 'slugId', 'slug']) ??
    stringValue(args.documentId);
  const initiativeId =
    fromRecord(record, ['initiativeId']) ??
    fromRecord(initiative ?? {}, ['id']) ??
    stringValue(args.initiativeId);
  const milestoneId =
    fromRecord(record, ['milestoneId']) ??
    fromRecord(milestone ?? {}, ['id']) ??
    stringValue(args.milestoneId);
  const projectId =
    fromRecord(record, ['projectId']) ??
    fromRecord(project ?? {}, ['id', 'slug']) ??
    stringValue(args.projectId);

  const issueIdentifier = firstValue(
    fromRecord(record, ['issueIdentifier', 'issueKey']),
    fromRecord(issue ?? {}, ['identifier', 'key']),
    isIssueIdentifier(issueId) ? issueId : null,
  );
  const documentIdentifier =
    fromRecord(document ?? {}, ['slug', 'slugId', 'title', 'name']) ??
    (documentId ? stringValue(args.documentId) : null);
  const projectIdentifier =
    fromRecord(project ?? {}, ['slug', 'name', 'id']) ??
    (projectId ? stringValue(args.projectId) : null);

  if (issueId) {
    return {
      issueId,
      issueIdentifier,
      targetId: issueId,
      targetIdentifier: issueIdentifier,
      targetType: 'issue' as const,
    };
  }

  if (documentId) {
    return {
      issueId: null,
      issueIdentifier: null,
      targetId: documentId,
      targetIdentifier: documentIdentifier,
      targetType: 'document' as const,
    };
  }

  if (initiativeId) {
    return {
      issueId: null,
      issueIdentifier: null,
      targetId: initiativeId,
      targetIdentifier:
        fromRecord(initiative ?? {}, ['name', 'id']) ?? stringValue(args.initiativeId),
      targetType: 'initiative' as const,
    };
  }

  if (milestoneId) {
    return {
      issueId: null,
      issueIdentifier: null,
      targetId: milestoneId,
      targetIdentifier:
        fromRecord(milestone ?? {}, ['name', 'id']) ?? stringValue(args.milestoneId),
      targetType: 'milestone' as const,
    };
  }

  if (projectId) {
    return {
      issueId: null,
      issueIdentifier: null,
      targetId: projectId,
      targetIdentifier: projectIdentifier,
      targetType: 'project' as const,
    };
  }

  return {
    issueId: null,
    issueIdentifier: null,
    targetId: null,
    targetIdentifier: null,
    targetType: null,
  };
};

const resolveResourceIdentifier = (params: {
  entityType: LinearWorkEntityType;
  id: string;
  record: Record<string, unknown>;
  targetIdentifier: string | null;
  title: string | null;
  url: string | null;
}) => {
  switch (params.entityType) {
    case 'comment': {
      return (
        fromRecord(params.record, ['identifier', 'key']) ??
        (params.targetIdentifier ? `${params.targetIdentifier}#${params.id.slice(0, 8)}` : null)
      );
    }

    case 'document': {
      return (
        fromRecord(params.record, ['slug']) ??
        urlSegmentAfter(params.url, 'document') ??
        fromRecord(params.record, ['slugId']) ??
        params.title ??
        params.id
      );
    }

    case 'issue': {
      return (
        fromRecord(params.record, ['identifier', 'key']) ??
        (isIssueIdentifier(params.id) ? params.id : null) ??
        urlSegmentAfter(params.url, 'issue') ??
        params.title ??
        params.id
      );
    }
  }
};

const linearResourceType = (entityType: LinearWorkEntityType): LinearWorkResourceType => {
  switch (entityType) {
    case 'comment': {
      return 'linear_comment';
    }
    case 'document': {
      return 'linear_document';
    }
    case 'issue': {
      return 'linear_issue';
    }
  }
};

const contextParams = (
  params: RegisterLinearToolResultWorkParams,
): Pick<
  RegisterLinearWorkParams,
  | 'actorAgentId'
  | 'rootOperationId'
  | 'source'
  | 'sourceMessageId'
  | 'sourceToolCallId'
  | 'sourceType'
  | 'threadId'
  | 'topicId'
> => ({
  actorAgentId: params.actorAgentId ?? null,
  rootOperationId: params.rootOperationId ?? null,
  source: params.toolName,
  sourceMessageId: params.sourceMessageId ?? null,
  sourceToolCallId: params.sourceToolCallId ?? null,
  sourceType: 'tool',
  threadId: params.threadId ?? null,
  topicId: params.topicId ?? null,
});

const createRegisterOperation = (
  params: RegisterLinearToolResultWorkParams,
  entityType: LinearWorkEntityType,
  record: Record<string, unknown>,
): LinearToolRegisterOperation | null => {
  const id = fromRecord(record, ['id', 'uuid', 'identifier', 'slug', 'slugId']);
  if (!id) return null;

  const url = fromRecord(record, ['url', 'appUrl']);
  const title =
    fromRecord(record, ['title', 'name', 'subject']) ??
    (entityType === 'comment' ? textFromRecord(record, ['body']) : null);
  const target = resolveTarget(params, record);
  const identifier = resolveResourceIdentifier({
    entityType,
    id,
    record,
    targetIdentifier: target.targetIdentifier,
    title,
    url,
  });
  const parentId = fromRecord(record, ['parentId']);
  const priority = toRecord(record.priority);
  const state = toRecord(record.state);

  return {
    params: {
      ...contextParams(params),
      assignee:
        fromRecord(record, ['assignee']) ?? fromNestedRecord(record, 'assignee', ['name', 'id']),
      assigneeId:
        fromRecord(record, ['assigneeId']) ?? fromNestedRecord(record, 'assignee', ['id']),
      body: textFromRecord(record, ['body']),
      color: fromRecord(record, ['color']),
      content: textFromRecord(record, ['content']),
      createdAt: fromRecord(record, ['createdAt']),
      description: textFromRecord(record, ['description']),
      dueDate: fromRecord(record, ['dueDate']),
      icon: fromRecord(record, ['icon']),
      issueId: target.issueId,
      issueIdentifier: target.issueIdentifier,
      labels: extractLabels(record.labels),
      parentId,
      priority: fromRecord(record, ['priority']) ?? fromRecord(priority ?? {}, ['name']),
      priorityValue:
        numberFromRecord(record, ['priority']) ?? numberFromRecord(priority ?? {}, ['value']),
      project:
        fromRecord(record, ['project']) ??
        fromNestedRecord(record, 'project', ['name', 'slug', 'id']),
      projectId: fromRecord(record, ['projectId']) ?? fromNestedRecord(record, 'project', ['id']),
      resourceId: id,
      resourceIdentifier: identifier,
      resourceType: linearResourceType(entityType),
      role: LINEAR_CREATE_TOOLS.has(params.toolName) && !params.args?.id ? 'created' : 'updated',
      status:
        fromRecord(record, ['status', 'state', 'statusName', 'stateName']) ??
        fromRecord(state ?? {}, ['name', 'type']),
      statusType: fromRecord(record, ['statusType']) ?? fromRecord(state ?? {}, ['type']),
      slugId: fromRecord(record, ['slugId']),
      targetId: target.targetId,
      targetIdentifier: target.targetIdentifier,
      targetType: target.targetType,
      team: fromRecord(record, ['team']) ?? fromNestedRecord(record, 'team', ['name', 'key', 'id']),
      teamId: fromRecord(record, ['teamId']) ?? fromNestedRecord(record, 'team', ['id']),
      title: title ?? identifier ?? id,
      updatedAt: fromRecord(record, ['updatedAt']),
      url,
    },
    type: 'register',
  };
};

export const normalizeLinearToolResult = (
  params: RegisterLinearToolResultWorkParams,
): LinearToolWorkOperation | null => {
  if (isApplicationError(params.data)) return null;

  switch (params.toolName) {
    case 'delete_comment': {
      const id = stringValue(params.args?.id);
      if (!id) return null;

      return {
        params: {
          resourceId: id,
          resourceType: 'linear_comment',
        },
        type: 'delete',
      };
    }

    case 'save_issue': {
      const issue = unwrapData(params.data, ['issue', 'data', 'result']);
      return issue ? createRegisterOperation(params, 'issue', issue) : null;
    }

    case 'create_document':
    case 'save_document':
    case 'update_document': {
      const document = unwrapData(params.data, ['document', 'data', 'result']);
      return document ? createRegisterOperation(params, 'document', document) : null;
    }

    case 'save_comment': {
      const comment = unwrapData(params.data, ['comment', 'data', 'result']);
      return comment ? createRegisterOperation(params, 'comment', comment) : null;
    }

    default: {
      return null;
    }
  }
};
