import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agents, userConnectors, users, workspaces } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { ConnectorModel } from '../connector';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'agentscope-user';
const otherUserId = 'agentscope-other-user';
const workspaceId = 'agentscope-workspace';
const agentA = 'agentscope-agent-a';
const agentB = 'agentscope-agent-b';

/** Insert a connector row directly so we can control (agentId, workspaceId) exactly. */
const insertConnector = async (row: {
  agentId?: string | null;
  identifier: string;
  name: string;
  userId?: string;
  workspaceId?: string | null;
}) => {
  const [created] = await serverDB
    .insert(userConnectors)
    .values({
      agentId: row.agentId ?? null,
      identifier: row.identifier,
      name: row.name,
      sourceType: 'custom',
      status: 'connected',
      userId: row.userId ?? userId,
      workspaceId: row.workspaceId ?? null,
    })
    .returning();
  return created;
};

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
  await serverDB
    .insert(workspaces)
    .values({ id: workspaceId, name: 'WS', primaryOwnerId: userId, slug: 'agentscope-ws' });
  await serverDB.insert(agents).values([
    { id: agentA, userId },
    { id: agentB, userId },
  ]);
});

afterEach(async () => {
  await serverDB.delete(users);
});

describe('ConnectorModel agent-scoped resolution', () => {
  describe('resolveByIdentifiers (personal run)', () => {
    it('prefers the agent-owned row over the base personal row (Agent > Personal)', async () => {
      await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      const agentRow = await insertConnector({
        agentId: agentA,
        identifier: 'gmail',
        name: 'Agent Gmail',
      });

      const model = new ConnectorModel(serverDB, userId);
      const resolved = await model.resolveByIdentifiers(['gmail'], agentA);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe(agentRow.id);
      expect(resolved[0].name).toBe('Agent Gmail');
    });

    it('downgrades to the base personal row when the agent has no binding', async () => {
      const baseRow = await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });

      const model = new ConnectorModel(serverDB, userId);
      const resolved = await model.resolveByIdentifiers(['gmail'], agentA);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe(baseRow.id);
    });

    it('resolves the agent row even when no base row exists', async () => {
      const agentRow = await insertConnector({
        agentId: agentA,
        identifier: 'gmail',
        name: 'Agent Gmail',
      });

      const model = new ConnectorModel(serverDB, userId);
      const resolved = await model.resolveByIdentifiers(['gmail'], agentA);

      expect(resolved.map((r) => r.id)).toEqual([agentRow.id]);
    });

    it("never resolves another agent's connector", async () => {
      const baseRow = await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      await insertConnector({ agentId: agentB, identifier: 'gmail', name: 'Agent B Gmail' });

      const model = new ConnectorModel(serverDB, userId);
      // Running as agent A: agent B's row must be invisible → falls back to base.
      const resolved = await model.resolveByIdentifiers(['gmail'], agentA);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe(baseRow.id);
    });

    it('with no agentId resolves base rows only (agent rows excluded)', async () => {
      const baseRow = await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      await insertConnector({ agentId: agentA, identifier: 'gmail', name: 'Agent Gmail' });

      const model = new ConnectorModel(serverDB, userId);
      const resolved = await model.resolveByIdentifiers(['gmail']);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe(baseRow.id);
    });

    it('returns at most one row per identifier across a mixed batch', async () => {
      await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      await insertConnector({ agentId: agentA, identifier: 'gmail', name: 'Agent Gmail' });
      await insertConnector({ identifier: 'notion', name: 'Personal Notion' });

      const model = new ConnectorModel(serverDB, userId);
      const resolved = await model.resolveByIdentifiers(['gmail', 'notion'], agentA);

      const byId = Object.fromEntries(resolved.map((r) => [r.identifier, r.name]));
      expect(resolved).toHaveLength(2);
      expect(byId.gmail).toBe('Agent Gmail');
      expect(byId.notion).toBe('Personal Notion');
    });
  });

  describe('resolveByIdentifiers (workspace run)', () => {
    it('prefers the agent-workspace row over the base workspace row and never falls back to personal', async () => {
      // personal row (must NOT leak into a workspace run)
      await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      // workspace base row
      const wsRow = await insertConnector({
        identifier: 'gmail',
        name: 'Workspace Gmail',
        workspaceId,
      });
      // agent-workspace row
      const agentWsRow = await insertConnector({
        agentId: agentA,
        identifier: 'gmail',
        name: 'Agent WS Gmail',
        workspaceId,
      });

      const model = new ConnectorModel(serverDB, userId, workspaceId);

      expect((await model.resolveByIdentifiers(['gmail'], agentA))[0].id).toBe(agentWsRow.id);
      // no agent binding → workspace base, still not personal
      expect((await model.resolveByIdentifiers(['gmail']))[0].id).toBe(wsRow.id);
    });
  });

  describe('findScopedByIdentifier', () => {
    it('matches the exact scope and does not cross between agent and base', async () => {
      const baseRow = await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      const agentRow = await insertConnector({
        agentId: agentA,
        identifier: 'gmail',
        name: 'Agent Gmail',
      });

      const model = new ConnectorModel(serverDB, userId);

      expect((await model.findScopedByIdentifier('gmail'))?.id).toBe(baseRow.id);
      expect((await model.findScopedByIdentifier('gmail', agentA))?.id).toBe(agentRow.id);
      // agent B has no row for this identifier
      expect(await model.findScopedByIdentifier('gmail', agentB)).toBeNull();
    });
  });

  describe('resolveAll', () => {
    it('dedupes by identifier with the agent row winning', async () => {
      await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      await insertConnector({ agentId: agentA, identifier: 'gmail', name: 'Agent Gmail' });
      await insertConnector({ identifier: 'notion', name: 'Personal Notion' });

      const model = new ConnectorModel(serverDB, userId);
      const all = await model.resolveAll(agentA);

      const byIdentifier = Object.fromEntries(all.map((r) => [r.identifier, r.name]));
      expect(all).toHaveLength(2);
      expect(byIdentifier.gmail).toBe('Agent Gmail');
      expect(byIdentifier.notion).toBe('Personal Notion');
    });
  });

  describe('queryByAgent', () => {
    it('returns only the given agent rows and excludes base + other-agent rows', async () => {
      await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      const aRow = await insertConnector({ agentId: agentA, identifier: 'gmail', name: 'A Gmail' });
      await insertConnector({ agentId: agentB, identifier: 'gmail', name: 'B Gmail' });

      const model = new ConnectorModel(serverDB, userId);
      const rows = await model.queryByAgent(agentA);

      expect(rows.map((r) => r.id)).toEqual([aRow.id]);
    });
  });

  describe('base query excludes agent rows', () => {
    it('query() and queryByIdentifiers() return base rows only', async () => {
      await insertConnector({ identifier: 'gmail', name: 'Personal Gmail' });
      await insertConnector({ agentId: agentA, identifier: 'gmail', name: 'Agent Gmail' });

      const model = new ConnectorModel(serverDB, userId);

      const listed = await model.query();
      expect(listed.every((r) => r.agentId === null)).toBe(true);
      expect(listed).toHaveLength(1);

      const byId = await model.queryByIdentifiers(['gmail']);
      expect(byId).toHaveLength(1);
      expect(byId[0].agentId).toBeNull();
    });
  });
});
