'use client';

import { Dropdown, Flexbox, Icon, Tag, Text } from '@lobehub/ui';
import { Button, confirmModal, Modal } from '@lobehub/ui/base-ui';
import { McpIcon } from '@lobehub/ui/icons';
import isEqual from 'fast-deep-equal';
import { CopyIcon, LinkIcon, PlugZapIcon, PlusIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createAgentSkillStoreModal } from '@/features/AgentSkillStore';
import { SKILL_ICON_SIZE } from '@/features/ChatInput/ActionBar/Tools/ComposioSkillIcon';
import { usePermission } from '@/hooks/usePermission';
import { useToolStore } from '@/store/tool';
import { connectorSelectors } from '@/store/tool/slices/connector';
import type { ConnectorWithTools } from '@/store/tool/slices/connector/types';

type PickerMode = 'copy' | 'mount';

const badgeColor: Record<'agentOnly' | 'copy' | 'linked', string> = {
  agentOnly: 'default',
  copy: 'blue',
  linked: 'green',
};

const AgentToolsTab = memo<{ agentId: string }>(({ agentId }) => {
  const { t } = useTranslation('setting');
  const { allowed: canEdit } = usePermission('edit_own_content');

  const agentConnectors = useToolStore(connectorSelectors.agentConnectors(agentId), isEqual);
  const userConnectors = useToolStore(connectorSelectors.connectorList, isEqual);

  // Badge derived locally (avoids a store selector that returns a fresh fn each render):
  // linked = mounted user row; copy = agent-owned w/ a same-named user tool; else agent-only.
  const badgeOf = (c: ConnectorWithTools): 'agentOnly' | 'copy' | 'linked' => {
    if (c.agentId !== agentId) return 'linked';
    const hasUserSame = userConnectors.some((u) => u.identifier === c.identifier && !u.agentId);
    return hasUserSame ? 'copy' : 'agentOnly';
  };

  const copyConnectorToAgent = useToolStore((s) => s.copyConnectorToAgent);
  const mountConnectorToAgent = useToolStore((s) => s.mountConnectorToAgent);
  const detachConnectorFromAgent = useToolStore((s) => s.detachConnectorFromAgent);

  const [picker, setPicker] = useState<PickerMode | null>(null);

  // User connectors eligible to copy/mount: base rows (not agent-owned) that
  // aren't already locked by another agent.
  const mountableUserConnectors = useMemo(
    () => userConnectors.filter((c) => !c.agentId && !c.metadata?.mountedByAgentId),
    [userConnectors],
  );

  const handleRemove = async (connector: ConnectorWithTools) => {
    const badge = badgeOf(connector);
    if (badge === 'linked') {
      // Mounted (referenced) — just unmount, the user keeps the connector.
      await detachConnectorFromAgent(connector.id, agentId, 'unmount');
      return;
    }
    // Agent-owned (Copy / Connect-new) — deleting removes its credentials.
    const ok = await confirmModal({
      content: t('settingAgent.agentTools.removeOwnedConfirm'),
    });
    if (ok) await detachConnectorFromAgent(connector.id, agentId, 'delete');
  };

  const addMenuItems = [
    {
      icon: <Icon icon={PlugZapIcon} />,
      key: 'connectNew',
      label: (
        <Flexbox>
          <Text>{t('settingAgent.agentTools.connectNew.title')}</Text>
          <Text style={{ fontSize: 12 }} type={'secondary'}>
            {t('settingAgent.agentTools.connectNew.desc')}
          </Text>
        </Flexbox>
      ),
      onClick: () => createAgentSkillStoreModal(agentId),
    },
    {
      icon: <Icon icon={CopyIcon} />,
      key: 'copy',
      label: (
        <Flexbox>
          <Text>{t('settingAgent.agentTools.copy.title')}</Text>
          <Text style={{ fontSize: 12 }} type={'secondary'}>
            {t('settingAgent.agentTools.copy.desc')}
          </Text>
        </Flexbox>
      ),
      onClick: () => setPicker('copy'),
    },
    {
      icon: <Icon icon={LinkIcon} />,
      key: 'mount',
      label: (
        <Flexbox>
          <Text>{t('settingAgent.agentTools.mount.title')}</Text>
          <Text style={{ fontSize: 12 }} type={'secondary'}>
            {t('settingAgent.agentTools.mount.desc')}
          </Text>
        </Flexbox>
      ),
      onClick: () => setPicker('mount'),
    },
  ];

  return (
    <Flexbox horizontal align={'center'} gap={8} wrap={'wrap'}>
      <Dropdown
        disabled={!canEdit}
        menu={{ items: addMenuItems }}
        placement={'bottomLeft'}
        trigger={['click']}
      >
        <Button icon={<Icon icon={PlusIcon} />} size={'small'} type={'text'}>
          {t('settingAgent.agentTools.add')}
        </Button>
      </Dropdown>

      {agentConnectors.length === 0 && (
        <Text style={{ fontSize: 12 }} type={'secondary'}>
          {t('settingAgent.agentTools.agentEmpty')}
        </Text>
      )}

      {agentConnectors.map((connector) => {
        const badge = badgeOf(connector);
        return (
          <Tag
            closable={canEdit}
            icon={<Icon icon={McpIcon} size={SKILL_ICON_SIZE} />}
            key={connector.id}
            onClose={(e) => {
              e?.preventDefault?.();
              handleRemove(connector);
            }}
          >
            <Flexbox horizontal align={'center'} gap={6}>
              {connector.name || connector.identifier}
              <Tag color={badgeColor[badge]} size={'small'}>
                {t(`settingAgent.agentTools.badge.${badge}` as any)}
              </Tag>
            </Flexbox>
          </Tag>
        );
      })}

      {/* Copy / Mount picker — a list of the user's connectors */}
      <Modal
        footer={null}
        open={picker === 'copy' || picker === 'mount'}
        title={t(
          picker === 'copy'
            ? 'settingAgent.agentTools.copy.title'
            : 'settingAgent.agentTools.mount.title',
        )}
        onCancel={() => setPicker(null)}
      >
        <Flexbox gap={4}>
          {mountableUserConnectors.length === 0 && (
            <Text type={'secondary'}>{t('settingAgent.agentTools.pickerEmpty')}</Text>
          )}
          {mountableUserConnectors.map((c) => (
            <Button
              block
              key={c.id}
              style={{ justifyContent: 'flex-start' }}
              type={'text'}
              onClick={async () => {
                if (picker === 'copy') await copyConnectorToAgent(c.id, agentId);
                else await mountConnectorToAgent(c.id, agentId);
                setPicker(null);
              }}
            >
              <Flexbox horizontal align={'center'} gap={8}>
                <Icon icon={McpIcon} size={SKILL_ICON_SIZE} />
                {c.name || c.identifier}
              </Flexbox>
            </Button>
          ))}
        </Flexbox>
      </Modal>
    </Flexbox>
  );
});

AgentToolsTab.displayName = 'AgentToolsTab';

export default AgentToolsTab;
