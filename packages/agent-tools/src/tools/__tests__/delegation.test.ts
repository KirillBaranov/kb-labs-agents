import { describe, it, expect, vi } from 'vitest';
import { createSpawnAgentTool } from '../delegation.js';
import type { ToolContext } from '../../types.js';
import { DELEGATION_CONFIG } from '../../config.js';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workingDir: '/project', ...overrides };
}

describe('spawn_agent — no spawnAgent in context', () => {
  it('returns error when spawnAgent is not available', async () => {
    const tool = createSpawnAgentTool(ctx());

    const result = await tool.executor({ task: 'do something' });

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('not available');
  });
});

describe('spawn_agent — with spawnAgent in context', () => {
  function makeCtx(spawnResult: Awaited<ReturnType<NonNullable<ToolContext['spawnAgent']>>>) {
    const spawnAgent = vi.fn().mockResolvedValue(spawnResult);
    return { tool: createSpawnAgentTool(ctx({ spawnAgent })), spawnAgent };
  }

  it('calls spawnAgent with task, maxIterations, and workingDir', async () => {
    const { tool, spawnAgent } = makeCtx({ success: true, iterations: 3, tokensUsed: 500, result: 'done' });

    await tool.executor({ task: 'analyze X', maxIterations: 5, directory: 'src' });

    expect(spawnAgent).toHaveBeenCalledWith({
      task: 'analyze X',
      maxIterations: 5,
      workingDir: 'src',
    });
  });

  it('uses DELEGATION_CONFIG.defaultMaxIterations when maxIterations not provided', async () => {
    const { tool, spawnAgent } = makeCtx({ success: true, iterations: 2, tokensUsed: 100, result: 'ok' });

    await tool.executor({ task: 'quick task' });

    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxIterations: DELEGATION_CONFIG.defaultMaxIterations }),
    );
  });

  it('returns success with formatted output on sub-agent success', async () => {
    const { tool } = makeCtx({ success: true, iterations: 4, tokensUsed: 800, result: 'found the bug' });

    const result = await tool.executor({ task: 'find bug' });

    expect(result.success).toBe(true);
    const output = (result as any).output as string;
    expect(output).toContain('Sub-agent completed successfully');
    expect(output).toContain('4 iterations');
    expect(output).toContain('800 tokens');
    expect(output).toContain('found the bug');
  });

  it('returns success with failure header when sub-agent reports failure', async () => {
    const { tool } = makeCtx({ success: false, iterations: 10, tokensUsed: 2000, result: 'gave up' });

    const result = await tool.executor({ task: 'impossible' });

    expect(result.success).toBe(true); // parent always returns success=true; failure is in output
    expect((result as any).output).toContain('Sub-agent failed');
    expect((result as any).output).toContain('gave up');
  });

  it('passes undefined workingDir when directory not specified', async () => {
    const { tool, spawnAgent } = makeCtx({ success: true, iterations: 1, tokensUsed: 50, result: 'x' });

    await tool.executor({ task: 'task' });

    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: undefined }),
    );
  });

  it('returns error when spawnAgent throws', async () => {
    const spawnAgent = vi.fn().mockRejectedValue(new Error('timeout'));
    const tool = createSpawnAgentTool(ctx({ spawnAgent }));

    const result = await tool.executor({ task: 'fail task' });

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('timeout');
  });
});

describe('spawn_agent — tool definition', () => {
  it('has correct name and required fields', () => {
    const tool = createSpawnAgentTool(ctx());
    const fn = tool.definition.function;

    expect(fn.name).toBe('spawn_agent');
    expect(fn.parameters.required).toContain('task');
  });
});
