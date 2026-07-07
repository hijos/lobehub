// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { finalizeAbandoned } from '../finalizeAbandoned';

const { mockFinalizeAbandoned, mockGetServerDB } = vi.hoisted(() => ({
  mockFinalizeAbandoned: vi.fn(),
  mockGetServerDB: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: mockGetServerDB,
}));

vi.mock('@/server/services/agentRuntime', () => ({
  AbandonOperationService: vi.fn().mockImplementation(() => ({
    finalizeAbandoned: mockFinalizeAbandoned,
  })),
}));

vi.mock('@/server/services/agentRuntime/hooks/HookDispatcher', () => ({
  deliverWebhook: vi.fn(),
}));

vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: vi.fn(),
}));

function buildContext(body: unknown) {
  let captured: { body: any; status: number } | undefined;
  const ctx = {
    json: (b: any, status = 200) => {
      captured = { body: b, status };
      return Response.json(b, { status });
    },
    req: {
      json: async () => body,
    },
  } as any;

  return { ctx, getCaptured: () => captured };
}

describe('finalizeAbandoned handler', () => {
  beforeEach(() => {
    mockGetServerDB.mockResolvedValue({ db: true });
    mockFinalizeAbandoned.mockResolvedValue({
      assistantMessageUpdated: false,
      completionReason: 'done',
      finalized: false,
      found: true,
      reconciledStatus: 'completed',
      terminal: true,
      terminalStatus: 'completed',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns gateway-readable terminal reconciliation fields from the service result', async () => {
    const { ctx, getCaptured } = buildContext({
      operationId: 'op_done',
      reason: 'inactivity_watchdog',
    });

    const res = await finalizeAbandoned(ctx);

    expect(res.status).toBe(200);
    expect(mockFinalizeAbandoned).toHaveBeenCalledWith('op_done', 'inactivity_watchdog');
    expect(getCaptured()?.body).toMatchObject({
      completionReason: 'done',
      operationId: 'op_done',
      reason: 'inactivity_watchdog',
      reconciledStatus: 'completed',
      terminal: true,
      terminalStatus: 'completed',
    });
    expect(getCaptured()?.body.executionTime).toEqual(expect.any(Number));
  });

  it('returns 400 when operationId is missing', async () => {
    const { ctx } = buildContext({ reason: 'inactivity_watchdog' });

    const res = await finalizeAbandoned(ctx);

    expect(res.status).toBe(400);
    expect(mockFinalizeAbandoned).not.toHaveBeenCalled();
  });
});
