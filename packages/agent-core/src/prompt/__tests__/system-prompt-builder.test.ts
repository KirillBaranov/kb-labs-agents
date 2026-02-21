import { describe, it, expect, vi } from 'vitest';
import { SystemPromptBuilder, loadProjectInstructions } from '../system-prompt-builder';
import type { SystemPromptInput } from '../system-prompt-builder';
import * as fs from 'node:fs';

vi.mock('node:fs');

function makeInput(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    workingDir: '/tmp/test',
    responseMode: 'auto',
    isSubAgent: false,
    ...overrides,
  };
}

describe('SystemPromptBuilder', () => {
  const builder = new SystemPromptBuilder();

  it('builds a prompt containing core rules', async () => {
    const prompt = await builder.build(makeInput());
    expect(prompt).toContain('Core rules');
    expect(prompt).toContain('NEVER answer from memory');
  });

  it('includes delegation section for main agents', async () => {
    const prompt = await builder.build(makeInput({ isSubAgent: false }));
    expect(prompt).toContain('spawn_agent');
    expect(prompt).toContain('Delegation');
  });

  it('excludes delegation section for sub-agents', async () => {
    const prompt = await builder.build(makeInput({ isSubAgent: true }));
    expect(prompt).not.toContain('spawn_agent');
  });

  it('includes response mode in prompt', async () => {
    const prompt = await builder.build(makeInput({ responseMode: 'brief' }));
    expect(prompt).toContain('Response mode: brief');
  });

  it('includes session continuity note when session present', async () => {
    const prompt = await builder.build(makeInput({
      sessionId: 'sess-1',
      sessionRootDir: '/tmp',
    }));
    expect(prompt).toContain('Session continuity');
  });

  it('includes workspace topology when discovery is present', async () => {
    const prompt = await builder.build(makeInput({
      workspaceDiscovery: {
        rootDir: '/project',
        repos: [
          { path: '/project/packages/core', reasons: ['tsconfig'] },
          { path: '/project/packages/cli', reasons: ['package.json'] },
        ],
      },
    }));
    expect(prompt).toContain('Workspace topology');
    expect(prompt).toContain('packages/core');
  });

  it('does not include workspace section when no repos', async () => {
    const prompt = await builder.build(makeInput({
      workspaceDiscovery: { rootDir: '/project', repos: [] },
    }));
    expect(prompt).not.toContain('Workspace topology');
  });

  it('includes memory context when memory provided', async () => {
    const memory = {
      getContext: vi.fn().mockResolvedValue('some memory context'),
      getRecent: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
    } as any;

    const prompt = await builder.build(makeInput({ memory }));
    expect(prompt).toContain('Previous Context from Memory');
    expect(prompt).toContain('some memory context');
  });
});

describe('loadProjectInstructions', () => {
  it('returns null when no instruction files exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadProjectInstructions('/tmp')).toBeNull();
  });

  it('returns content of first found instruction file', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).endsWith('AGENT.md')
    );
    vi.mocked(fs.readFileSync).mockReturnValue('# Agent instructions');

    expect(loadProjectInstructions('/tmp')).toBe('# Agent instructions');
  });

  it('skips empty files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValueOnce('   ').mockReturnValueOnce('real content');

    expect(loadProjectInstructions('/tmp')).toBe('real content');
  });
});
