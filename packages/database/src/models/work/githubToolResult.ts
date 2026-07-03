import type {
  GithubWorkEntityType,
  GithubWorkPatchField,
  GithubWorkResourceType,
  RegisterGithubToolResultWorkParams,
  RegisterGithubWorkParams,
} from '@lobechat/types';

const MAX_GITHUB_SNAPSHOT_TEXT_LENGTH = 4000;

/**
 * Only successful create/edit results become Works (LOBE-10967): read-only
 * queries (get/list/search), comments, and branch/repo operations are
 * intentionally excluded, mirroring the Linear adaptation.
 */
const GITHUB_WORK_TOOLS: Record<
  string,
  { entityType: GithubWorkEntityType; role: 'created' | 'updated' }
> = {
  create_issue: { entityType: 'issue', role: 'created' },
  create_pull_request: { entityType: 'pull_request', role: 'created' },
  update_issue: { entityType: 'issue', role: 'updated' },
  update_pull_request: { entityType: 'pull_request', role: 'updated' },
};

interface GithubToolRegisterOperation {
  params: RegisterGithubWorkParams;
  type: 'register';
}

/**
 * Emitted when the tool result lacks a stable GitHub id (node_id / id) but the
 * target is still resolvable as `owner/repo#number`. The model layer appends a
 * version to an existing Work matched by resourceIdentifier and never creates
 * a new Work row from it.
 */
interface GithubToolAppendOperation {
  params: Omit<RegisterGithubWorkParams, 'resourceId'> & { resourceIdentifier: string };
  type: 'appendByIdentifier';
}

export type GithubToolWorkOperation = GithubToolAppendOperation | GithubToolRegisterOperation;

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

  return text.length > MAX_GITHUB_SNAPSHOT_TEXT_LENGTH
    ? `${text.slice(0, MAX_GITHUB_SNAPSHOT_TEXT_LENGTH)}...`
    : text;
};

const numberValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());

  return null;
};

const hasOwn = (record: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(record, key);

const fromRecord = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }

  return null;
};

const numberFromRecord = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) return value;
  }

  return null;
};

const hasAnyKey = (record: Record<string, unknown>, keys: string[]) =>
  keys.some((key) => hasOwn(record, key));

const extractNamedList = (value: unknown, nameKeys: string[]): string[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const record = toRecord(item);
      return record ? fromRecord(record, nameKeys) : stringValue(item);
    })
    .filter((name): name is string => !!name);
};

/** Join MCP-style content parts (`{ content: [{ text }] }`) back into one string. */
const textFromContentParts = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;

  const joined = value
    .map((item) => {
      if (typeof item === 'string') return item;
      const record = toRecord(item);
      return record ? (stringValue(record.text) ?? stringValue(record.content)) : null;
    })
    .filter(Boolean)
    .join('\n\n');

  return joined || null;
};

const RESOURCE_WRAPPER_KEYS = ['issue', 'pull_request', 'pullRequest', 'data', 'result'];

const unwrapData = (data: unknown): Record<string, unknown> | null => {
  let parsed = parseMaybeJSON(data);

  if (Array.isArray(parsed)) {
    parsed = parseMaybeJSON(textFromContentParts(parsed)) ?? toRecord(parsed[0]);
  }

  let record = toRecord(parsed);
  if (!record) return null;

  if (Array.isArray(record.content)) {
    const inner = parseMaybeJSON(textFromContentParts(record.content));
    record = toRecord(inner) ?? record;
  }

  for (const key of RESOURCE_WRAPPER_KEYS) {
    const nested = toRecord(record[key]);
    if (nested) return nested;
  }

  return record;
};

const isApplicationError = (data: unknown) => {
  const record = toRecord(parseMaybeJSON(data));
  return record?.isError === true;
};

const ownerRepoFromUrl = (url: string | null): string | null => {
  if (!url) return null;

  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    // https://api.github.com/repos/{owner}/{repo}/... vs https://github.com/{owner}/{repo}/...
    const start = segments[0] === 'repos' ? 1 : 0;
    const owner = segments[start];
    const repo = segments[start + 1];
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
};

const isOwnerRepo = (value: string | null): value is string =>
  !!value && /^[^/\s]+\/[^/\s#]+$/.test(value);

const resolveRepo = (
  record: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null => {
  const direct =
    fromRecord(record, ['repository_full_name', 'full_name', 'repositoryFullName']) ??
    fromRecord(toRecord(record.repository) ?? {}, ['full_name', 'fullName']) ??
    fromRecord(toRecord(toRecord(record.base)?.repo) ?? {}, ['full_name', 'fullName']);
  if (isOwnerRepo(direct)) return direct;

  const fromUrls =
    ownerRepoFromUrl(fromRecord(record, ['repository_url', 'repositoryUrl'])) ??
    ownerRepoFromUrl(fromRecord(record, ['html_url', 'htmlUrl']));
  if (fromUrls) return fromUrls;

  const fromArgs = fromRecord(args, ['repository_full_name', 'full_name', 'repository', 'repo']);
  if (isOwnerRepo(fromArgs)) return fromArgs;

  const owner = fromRecord(args, ['owner']);
  const repo = fromRecord(args, ['repo', 'name']);
  return owner && repo ? `${owner}/${repo}` : null;
};

const resolveNumber = (
  record: Record<string, unknown>,
  args: Record<string, unknown>,
): number | null =>
  numberFromRecord(record, ['number']) ??
  numberFromRecord(args, ['issue_number', 'pull_number', 'issueNumber', 'pullNumber', 'number']);

const resolveUrl = (record: Record<string, unknown>): string | null => {
  const htmlUrl = fromRecord(record, ['html_url', 'htmlUrl']);
  if (htmlUrl) return htmlUrl;

  const url = fromRecord(record, ['url']);
  return url && /^https?:\/\/github\.com\//i.test(url) ? url : null;
};

const githubResourceType = (entityType: GithubWorkEntityType): GithubWorkResourceType =>
  entityType === 'issue' ? 'github_issue' : 'github_pull_request';

const buildParams = (
  params: RegisterGithubToolResultWorkParams,
  tool: { entityType: GithubWorkEntityType; role: 'created' | 'updated' },
  record: Record<string, unknown>,
): Omit<RegisterGithubWorkParams, 'resourceId'> => {
  const args = params.args ?? {};
  const repo = resolveRepo(record, args);
  const number = resolveNumber(record, args);
  const url = resolveUrl(record);

  const patchFields = new Set<GithubWorkPatchField>();
  const patch = <T>(field: GithubWorkPatchField, present: boolean, value: T) => {
    if (present) patchFields.add(field);
    return present ? value : undefined;
  };

  if (repo) patchFields.add('repo');
  if (number !== null) patchFields.add('number');
  if (url) patchFields.add('url');

  return {
    actorAgentId: params.actorAgentId ?? null,
    assignees: patch(
      'assignees',
      hasOwn(record, 'assignees'),
      extractNamedList(record.assignees, ['login', 'name']),
    ),
    author: patch(
      'author',
      hasAnyKey(record, ['user', 'author']),
      fromRecord(toRecord(record.user) ?? toRecord(record.author) ?? {}, ['login', 'name']),
    ),
    baseRef: patch(
      'baseRef',
      hasAnyKey(record, ['base', 'base_ref', 'baseRef']),
      fromRecord(toRecord(record.base) ?? {}, ['ref']) ??
        fromRecord(record, ['base_ref', 'baseRef']),
    ),
    body: patch('body', hasOwn(record, 'body'), snapshotText(record.body)),
    closedAt: patch(
      'closedAt',
      hasAnyKey(record, ['closed_at', 'closedAt']),
      fromRecord(record, ['closed_at', 'closedAt']),
    ),
    createdAt: patch(
      'createdAt',
      hasAnyKey(record, ['created_at', 'createdAt']),
      fromRecord(record, ['created_at', 'createdAt']),
    ),
    draft: patch('draft', typeof record.draft === 'boolean', record.draft as boolean),
    headRef: patch(
      'headRef',
      hasAnyKey(record, ['head', 'head_ref', 'headRef']),
      fromRecord(toRecord(record.head) ?? {}, ['ref']) ??
        fromRecord(record, ['head_ref', 'headRef']),
    ),
    labels: patch(
      'labels',
      hasOwn(record, 'labels'),
      extractNamedList(record.labels, ['name', 'id']),
    ),
    merged: patch('merged', typeof record.merged === 'boolean', record.merged as boolean),
    mergedAt: patch(
      'mergedAt',
      hasAnyKey(record, ['merged_at', 'mergedAt']),
      fromRecord(record, ['merged_at', 'mergedAt']),
    ),
    number,
    repo,
    resourceIdentifier: repo && number !== null ? `${repo}#${number}` : null,
    resourceType: githubResourceType(tool.entityType),
    role: tool.role,
    rootOperationId: params.rootOperationId ?? null,
    source: params.toolName,
    sourceMessageId: params.sourceMessageId ?? null,
    sourceToolCallId: params.sourceToolCallId ?? null,
    sourceType: 'tool',
    state: patch('state', hasOwn(record, 'state'), fromRecord(record, ['state'])),
    stateReason: patch(
      'stateReason',
      hasAnyKey(record, ['state_reason', 'stateReason']),
      fromRecord(record, ['state_reason', 'stateReason']),
    ),
    threadId: params.threadId ?? null,
    title: patch('title', hasOwn(record, 'title'), stringValue(record.title)),
    topicId: params.topicId ?? null,
    updatedAt: patch(
      'updatedAt',
      hasAnyKey(record, ['updated_at', 'updatedAt']),
      fromRecord(record, ['updated_at', 'updatedAt']),
    ),
    url,
    patchFields: Array.from(patchFields),
  };
};

export const normalizeGithubToolResult = (
  params: RegisterGithubToolResultWorkParams,
): GithubToolWorkOperation | null => {
  // Payload apiNames sometimes carry the provider prefix (e.g. `github_create_issue`).
  const toolName = params.toolName.replace(/^github_/, '');
  const tool = GITHUB_WORK_TOOLS[toolName];
  if (!tool) return null;

  if (isApplicationError(params.data)) return null;

  const record = unwrapData(params.data);
  if (!record) return null;

  const base = buildParams(params, tool, record);
  const numericId = numberFromRecord(record, ['id']);
  const resourceId =
    fromRecord(record, ['node_id', 'nodeId']) ??
    (numericId === null ? null : String(numericId)) ??
    fromRecord(record, ['id']);

  if (resourceId) {
    return { params: { ...base, resourceId }, type: 'register' };
  }

  // Partial responses (no stable id) may still resolve to an existing Work
  // via `owner/repo#number`; never create a new Work row without a stable id.
  if (base.resourceIdentifier) {
    return {
      params: { ...base, resourceIdentifier: base.resourceIdentifier },
      type: 'appendByIdentifier',
    };
  }

  return null;
};
