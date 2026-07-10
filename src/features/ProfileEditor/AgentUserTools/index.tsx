'use client';

import { getActivePluginIds } from '@lobechat/types';
import { Flexbox, Icon, Text, Tooltip } from '@lobehub/ui';
import { Segmented } from '@lobehub/ui/base-ui';
import isEqual from 'fast-deep-equal';
import { InfoIcon } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SharedAgentTool, { type AgentToolProps } from '@/features/ProfileEditor/AgentTool';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import { useToolStore } from '@/store/tool';
import { connectorSelectors } from '@/store/tool/slices/connector';

import AgentToolsTab from './AgentToolsTab';

/**
 * The "Model & Tools" tools area on the Agent Profile page, split into two tabs:
 * - **Agent Tools** — connectors bound to this agent (Agent-only / Copy / Linked),
 *   resolved with priority over user tools of the same name at runtime.
 * - **User Tools** — the user's pinned tools (the pre-existing behavior).
 */
const AgentUserTools = memo<AgentToolProps>((props) => {
  const { agentId } = props;
  const { t } = useTranslation('setting');

  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const effectiveAgentId = agentId || activeAgentId || '';

  const [tab, setTab] = useState<'agent' | 'user'>('user');

  const config = useAgentStore(agentSelectors.getAgentConfigById(effectiveAgentId), isEqual);
  const pinnedIds = getActivePluginIds(config?.plugins);
  const userToolCount = pinnedIds.length;

  // User tools shadowed by an agent-owned tool of the same identifier — they
  // won't run (the agent tool wins). Surfaced as a note above the list.
  const overriddenIds = useToolStore(
    connectorSelectors.agentOverriddenIdentifiers(effectiveAgentId),
    isEqual,
  );
  const overriddenCount = pinnedIds.filter((id) => overriddenIds.has(id)).length;

  const agentConnectors = useToolStore(
    connectorSelectors.agentConnectors(effectiveAgentId),
    isEqual,
  );
  const isInit = useToolStore(connectorSelectors.isAgentConnectorsInit(effectiveAgentId));
  const fetchAgentConnectors = useToolStore((s) => s.fetchAgentConnectors);

  useEffect(() => {
    if (effectiveAgentId && !isInit) fetchAgentConnectors(effectiveAgentId);
  }, [effectiveAgentId, isInit, fetchAgentConnectors]);

  return (
    <Flexbox gap={12} width={'100%'}>
      <Flexbox horizontal align={'center'} gap={8} justify={'space-between'}>
        <Segmented
          size={'small'}
          value={tab}
          options={[
            {
              label: `${t('settingAgent.agentTools.tabAgent')}  ${agentConnectors.length}`,
              value: 'agent',
            },
            {
              label: `${t('settingAgent.agentTools.tabUser')}  ${userToolCount}`,
              value: 'user',
            },
          ]}
          onChange={(v) => setTab(v as 'agent' | 'user')}
        />
        <Tooltip title={t('settingAgent.agentTools.priorityTooltip')}>
          <Flexbox
            horizontal
            align={'center'}
            gap={4}
            style={{ cursor: 'help', fontSize: 12, opacity: 0.55 }}
          >
            <Icon icon={InfoIcon} size={14} />
            {t('settingAgent.agentTools.priorityHint')}
          </Flexbox>
        </Tooltip>
      </Flexbox>

      {tab === 'agent' ? (
        <AgentToolsTab agentId={effectiveAgentId} />
      ) : (
        <Flexbox gap={8}>
          {overriddenCount > 0 && (
            <Text style={{ fontSize: 12 }} type={'secondary'}>
              {t('settingAgent.agentTools.overriddenNote', { count: overriddenCount })}
            </Text>
          )}
          <SharedAgentTool {...props} />
        </Flexbox>
      )}
    </Flexbox>
  );
});

AgentUserTools.displayName = 'AgentUserTools';

export default AgentUserTools;
