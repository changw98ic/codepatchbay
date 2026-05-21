#!/usr/bin/env node

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSkillsSection, buildPlannerPrompt, buildExecutorPrompt } from '../server/services/prompt-builder.js';

async function setupTmpExecutorRoot(structure = {}) {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-pb-'));
  const profilesDir = path.join(tmpRoot, 'profiles');
  const wikiDir = path.join(tmpRoot, 'wiki', 'projects', 'test');
  const templatesDir = path.join(tmpRoot, 'templates', 'handoff');
  const systemDir = path.join(tmpRoot, 'wiki', 'system');

  await mkdir(profilesDir, { recursive: true });
  await mkdir(wikiDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(systemDir, { recursive: true });

  // Default soul.md for planner and executor
  for (const role of ['planner', 'executor']) {
    const roleDir = path.join(profilesDir, role);
    await mkdir(roleDir, { recursive: true });
    await writeFile(path.join(roleDir, 'soul.md'), `# ${role.charAt(0).toUpperCase() + role.slice(1)}\nRole def.`);
    const skillsDir = path.join(roleDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
  }

  // Minimal wiki files
  await writeFile(path.join(wikiDir, 'context.md'), '# Context');
  await writeFile(path.join(wikiDir, 'decisions.md'), '# Decisions');

  // Templates
  await writeFile(path.join(templatesDir, 'plan-to-execute.md'), '## Plan template');
  await writeFile(path.join(templatesDir, 'execute-to-review.md'), '## Execute template');

  // Handshake protocol
  await writeFile(path.join(systemDir, 'handshake-protocol.md'), '# Handshake');

  // Apply extra structure
  if (structure.plannerSkills) {
    const skillsDir = path.join(profilesDir, 'planner', 'skills');
    for (const skill of structure.plannerSkills) {
      await writeFile(path.join(skillsDir, skill.file), skill.content);
    }
  }
  if (structure.executorSkills) {
    const skillsDir = path.join(profilesDir, 'executor', 'skills');
    for (const skill of structure.executorSkills) {
      await writeFile(path.join(skillsDir, skill.file), skill.content);
    }
  }
  if (structure.planFile) {
    const inboxDir = path.join(wikiDir, 'inbox');
    await mkdir(inboxDir, { recursive: true });
    await writeFile(path.join(inboxDir, structure.planFile.name), structure.planFile.content);
  }

  return { tmpRoot, wikiDir };
}

describe('buildSkillsSection', () => {
  it('includes selected skill body and diagnostic reason', async () => {
    const { tmpRoot } = await setupTmpExecutorRoot({
      plannerSkills: [
        { file: 'plan.md', content: '---\nname: plan\ndescription: Plan skill\n---\nPlan body text here' },
      ],
    });
    try {
      const section = await buildSkillsSection(tmpRoot, 'planner', { phase: 'plan', task: 'Write the plan' });
      assert.ok(section.includes('## Loaded Role Skills'), `should include header, got: ${section}`);
      assert.ok(section.includes('Plan body text here'), `should include skill body, got: ${section}`);
      assert.ok(section.includes('phase:plan'), `should include reason, got: ${section}`);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('excludes unselected skill bodies', async () => {
    const { tmpRoot } = await setupTmpExecutorRoot({
      plannerSkills: [
        { file: 'plan.md', content: '---\nname: plan\ndescription: Plan\n---\nPlan body' },
        { file: 'other.md', content: '---\nname: other\ndescription: Other\n---\nOther body' },
      ],
    });
    try {
      const section = await buildSkillsSection(tmpRoot, 'planner', { phase: 'plan' });
      assert.ok(section.includes('Plan body'));
      assert.ok(!section.includes('Other body'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('returns empty string for missing skills directory', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-pb-empty-'));
    try {
      await mkdir(path.join(tmpRoot, 'profiles', 'myrole'), { recursive: true });
      const section = await buildSkillsSection(tmpRoot, 'myrole', { phase: 'execute' });
      assert.equal(section, '');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('selects by explicit /name in task text', async () => {
    const { tmpRoot } = await setupTmpExecutorRoot({
      executorSkills: [
        { file: 'tdd.md', content: '---\nname: tdd\ndescription: TDD\n---\nTDD body content' },
        { file: 'debug.md', content: '---\nname: debug\ndescription: Debug\n---\nDebug body content' },
      ],
    });
    try {
      const section = await buildSkillsSection(tmpRoot, 'executor', { phase: 'execute', artifactText: 'Use /tdd for this fix.' });
      assert.ok(section.includes('TDD body content'), `should include tdd body`);
      assert.ok(!section.includes('Debug body content'), `should not include debug body`);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('includes diagnostics for loaded and skipped skills', async () => {
    const { tmpRoot } = await setupTmpExecutorRoot({
      plannerSkills: [
        { file: 'plan.md', content: '---\nname: plan\ndescription: Plan\n---\nPlan body' },
      ],
    });
    try {
      const section = await buildSkillsSection(tmpRoot, 'planner', { phase: 'plan' });
      assert.ok(section.includes('## Role Skill Diagnostics'), `should include diagnostics header`);
      assert.ok(section.includes('loaded /plan'), `should show loaded skill`);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('renders diagnostics even when no skill is selected', async () => {
    const { tmpRoot } = await setupTmpExecutorRoot({
      plannerSkills: [
        { file: 'bad.md', content: '---\ndescription: no name field\n---\nNo name content' },
      ],
    });
    try {
      const section = await buildSkillsSection(tmpRoot, 'planner', { phase: 'plan' });
      assert.ok(section.includes('## Role Skill Diagnostics'), `should include diagnostics header even with no selected skills`);
      assert.ok(section.includes('malformed_skill'), `should show malformed_skill diagnostic`);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('rejects prefix false positive in buildSkillsSection', async () => {
    const { tmpRoot } = await setupTmpExecutorRoot({
      executorSkills: [
        { file: 'test.md', content: '---\nname: test\ndescription: Test\n---\nTest body content' },
        { file: 'debug.md', content: '---\nname: debug\ndescription: Debug\n---\nDebug body content' },
      ],
    });
    try {
      const section = await buildSkillsSection(tmpRoot, 'executor', { phase: 'execute', task: 'Run /testcase for coverage.' });
      assert.ok(!section.includes('Test body content'), `should NOT include /test body for /testcase`);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });
});

describe('buildPlannerPrompt skill integration', () => {
  it('includes planner-selected skills in prompt', async () => {
    const { tmpRoot, wikiDir } = await setupTmpExecutorRoot({
      plannerSkills: [
        { file: 'plan.md', content: '---\nname: plan\ndescription: Plan\n---\nPlan methodology here' },
      ],
    });
    try {
      const planFile = path.join(wikiDir, 'inbox', 'plan-001.md');
      await mkdir(path.join(wikiDir, 'inbox'), { recursive: true });
      const prompt = await buildPlannerPrompt(tmpRoot, tmpRoot, 'test', 'Add feature X', planFile);
      assert.ok(prompt.includes('Plan methodology here'), `prompt should include planner skill body`);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });
});

describe('buildExecutorPrompt skill integration', () => {
  it('reads plan content and selects matching executor skills', async () => {
    const { tmpRoot, wikiDir } = await setupTmpExecutorRoot({
      executorSkills: [
        { file: 'tdd.md', content: '---\nname: tdd\ndescription: TDD\n---\nTDD methodology here' },
        { file: 'debug.md', content: '---\nname: debug\ndescription: Debug\n---\nDebug methodology here' },
      ],
      planFile: {
        name: 'plan-001.md',
        content: '# Plan\nUse /tdd for this task.\n## Steps\n1. Write tests first',
      },
    });
    try {
      const deliverableFile = path.join(wikiDir, 'outputs', 'deliverable-001.md');
      const prompt = await buildExecutorPrompt(tmpRoot, tmpRoot, 'test', '001', deliverableFile);
      assert.ok(prompt.includes('TDD methodology here'), `prompt should include tdd skill`);
      assert.ok(!prompt.includes('Debug methodology here'), `prompt should not include debug skill`);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });
});
