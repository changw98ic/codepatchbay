import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Tabs } from '@/components/shared/Tabs';
import { Button } from '@/components/shared/Button';
import { Badge } from '@/components/shared/Badge';
import { usePolicyStore } from '@/app/store';
import type { PhasePolicy, KnowledgePolicySummary } from '@/types/api';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const headerStyle = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: space[2],
});

const titleStyle = style({
  fontSize: fontSize['3xl'],
  fontWeight: fontWeight.extrabold,
  color: theme.text,
});

const sectionTitle = style({
  fontSize: fontSize.lg,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  marginTop: space[4],
  marginBottom: space[2],
});

const pathList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '8px',
  background: theme.surfaceAlt,
  fontFamily: 'monospace',
  fontSize: fontSize.xs,
});

const pathAllowed = style({ color: theme.success });
const pathDenied = style({ color: theme.error });
const pathObservable = style({ color: theme.info });

const mutedStyle = style({
  fontSize: fontSize.sm,
  color: theme.textDim,
  lineHeight: 1.6,
});

const rolesRow = style({
  display: 'flex',
  gap: space[2],
  flexWrap: 'wrap' as const,
  marginBottom: space[4],
});

const knowledgeGrid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: space[3],
  marginTop: space[3],
});

const knowledgeCard = style({
  padding: space[3],
  borderRadius: '8px',
  background: theme.surfaceAlt,
});

const knowledgeLabel = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  marginBottom: space[1],
});

const knowledgeValue = style({
  fontSize: fontSize.xs,
  fontFamily: 'monospace',
});

const ROLES = ['planner', 'executor', 'verifier', 'repairer', 'reviewer'];

function PhasePolicyView({ policy }: { policy: PhasePolicy }) {
  return (
    <div>
      <div className={sectionTitle}>Role: {policy.role}</div>
      <div className={mutedStyle}>
        Read scope: <Badge variant="muted">{policy.readScope}</Badge>
        {policy.profileConfigured && <Badge variant="warning" style={{ marginLeft: 8 }}>profile overrides</Badge>}
      </div>

      {policy.writeAllowed.length > 0 && (
        <div className={sectionTitle}>Write Allowed</div>
        <div className={pathList}>
          {policy.writeAllowed.map((p, i) => <div key={i} className={pathAllowed}>{p}</div>)}
        </div>
      )}

      {policy.writeDenied.length > 0 && (
        <div className={sectionTitle}>Write Denied</div>
        <div className={pathList}>
          {policy.writeDenied.map((p, i) => <div key={i} className={pathDenied}>{p}</div>)}
        </div>
      )}

      {policy.observablePaths.length > 0 && (
        <div className={sectionTitle}>Observable Paths</div>
        <div className={pathList}>
          {policy.observablePaths.map((p, i) => <div key={i} className={pathObservable}>{p}</div>)}
        </div>
      )}

      {policy.denyTools && policy.denyTools.length > 0 && (
        <div className={mutedStyle}>Deny tools: {policy.denyTools.join(', ')}</div>
      )}

      {policy.denyCommands && policy.denyCommands.length > 0 && (
        <div className={mutedStyle}>Deny commands: {policy.denyCommands.join(', ')}</div>
      )}
    </div>
  );
}

function KnowledgePolicyView({ policy }: { policy: KnowledgePolicySummary }) {
  return (
    <div>
      <div className={sectionTitle}>Prompt Composition Order</div>
      <div className={mutedStyle}>{policy.promptCompositionOrder.join(' → ')}</div>

      <div className={knowledgeGrid}>
        <div className={knowledgeCard}>
          <div className={knowledgeLabel}>Automatic Writes</div>
          {policy.automaticWrites.map((w, i) => <div key={i} className={knowledgeValue}>{w}</div>)}
        </div>
        <div className={knowledgeCard}>
          <div className={knowledgeLabel}>Semi-Automatic Writes</div>
          {policy.semiAutomaticWrites.map((w, i) => <div key={i} className={knowledgeValue}>{w}</div>)}
        </div>
        <div className={knowledgeCard}>
          <div className={knowledgeLabel}>Explicit Confirmation Required</div>
          {policy.explicitConfirmationWrites.map((w, i) => <div key={i} className={knowledgeValue}>{w}</div>)}
        </div>
        <div className={knowledgeCard}>
          <div className={knowledgeLabel}>Forbidden in Markdown</div>
          {policy.forbiddenMarkdownState.map((w, i) => <div key={i} className={knowledgeValue}>{w}</div>)}
        </div>
      </div>
    </div>
  );
}

export default function PolicyPage() {
  const { t } = useTranslation();
  const {
    phasePolicy, knowledgePolicy, rolesPolicies,
    selectedRole, setSelectedRole,
    fetchPhasePolicy, fetchKnowledgePolicy, fetchRolesPolicies,
  } = usePolicyStore();
  const [activeTab, setActiveTab] = useState('phase');

  useEffect(() => {
    fetchPhasePolicy(selectedRole);
    fetchKnowledgePolicy();
    fetchRolesPolicies();
  }, []);

  const handleRoleChange = useCallback((role: string) => {
    setSelectedRole(role);
    fetchPhasePolicy(role);
  }, [setSelectedRole, fetchPhasePolicy]);

  const tabItems = [
    { key: 'phase', label: t('policy.phasePolicy', 'Phase Policy') },
    { key: 'roles', label: t('policy.allRoles', 'All Roles') },
    { key: 'knowledge', label: t('policy.knowledge', 'Knowledge Policy') },
  ];

  return (
    <div>
      <div className={headerStyle}>
        <h2 className={titleStyle}>{t('policy.title', 'Policy')}</h2>
      </div>

      <Tabs items={tabItems} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'phase' && (
        <GlassPanel depth="medium" padding="md" style={{ marginTop: 16 }}>
          <div className={sectionTitle}>Select Role</div>
          <div className={rolesRow}>
            {ROLES.map(role => (
              <Button
                key={role}
                variant={selectedRole === role ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => handleRoleChange(role)}
              >
                {role}
              </Button>
            ))}
          </div>
          {phasePolicy && <PhasePolicyView policy={phasePolicy} />}
        </GlassPanel>
      )}

      {activeTab === 'roles' && rolesPolicies && (
        <GlassPanel depth="medium" padding="md" style={{ marginTop: 16 }}>
          {ROLES.map(role => {
            const policy = rolesPolicies[role];
            return policy ? (
              <div key={role} style={{ marginBottom: 16 }}>
                <PhasePolicyView policy={policy} />
              </div>
            ) : null;
          })}
        </GlassPanel>
      )}

      {activeTab === 'knowledge' && knowledgePolicy && (
        <GlassPanel depth="medium" padding="md" style={{ marginTop: 16 }}>
          <KnowledgePolicyView policy={knowledgePolicy} />
        </GlassPanel>
      )}
    </div>
  );
}
