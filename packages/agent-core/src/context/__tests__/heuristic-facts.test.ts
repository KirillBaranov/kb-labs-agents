import { describe, it, expect } from 'vitest';
import { extractHeuristicFacts } from '../smart-summarizer';

describe('extractHeuristicFacts', () => {
  it('should extract fact from fs_read', () => {
    const output = 'import { foo } from "./bar";\nexport function init() {}\nexport function run() {}';
    const facts = extractHeuristicFacts('fs_read', { path: '/src/index.ts' }, output, true);

    expect(facts).toHaveLength(1);
    expect(facts[0]!.category).toBe('file_content');
    expect(facts[0]!.fact).toContain('/src/index.ts');
    expect(facts[0]!.fact).toContain('3 lines');
    expect(facts[0]!.confidence).toBe(0.9);
    expect(facts[0]!.source).toBe('fs_read');
  });

  it('should extract fact from grep_search', () => {
    const output = 'src/a.ts:5:TODO fix\nsrc/b.ts:10:TODO review\nsrc/c.ts:3:TODO refactor';
    const facts = extractHeuristicFacts('grep_search', { pattern: 'TODO' }, output, true);

    expect(facts).toHaveLength(1);
    expect(facts[0]!.category).toBe('tool_result');
    expect(facts[0]!.fact).toContain("grep 'TODO'");
    expect(facts[0]!.fact).toContain('~2 matches'); // 3 lines = 2 newlines
  });

  it('should extract fact from glob_search', () => {
    const output = 'src/a.ts\nsrc/b.ts\nsrc/c.test.ts\nsrc/d.ts';
    const facts = extractHeuristicFacts('glob_search', { pattern: '**/*.ts' }, output, true);

    expect(facts).toHaveLength(1);
    expect(facts[0]!.category).toBe('tool_result');
    expect(facts[0]!.fact).toContain("glob '**/*.ts'");
    expect(facts[0]!.fact).toContain('~3 files'); // 4 lines = 3 newlines
  });

  it('should extract fact from find_definition', () => {
    const output = 'class AgentCore implements IAgent { ... }';
    const facts = extractHeuristicFacts('find_definition', { name: 'AgentCore' }, output, true);

    expect(facts).toHaveLength(1);
    expect(facts[0]!.category).toBe('finding');
    expect(facts[0]!.fact).toContain("Definition of 'AgentCore'");
  });

  it('should extract fact from shell_exec', () => {
    const output = 'Tests: 42 passed, 0 failed';
    const facts = extractHeuristicFacts('shell_exec', { command: 'pnpm test' }, output, true);

    expect(facts).toHaveLength(1);
    expect(facts[0]!.category).toBe('tool_result');
    expect(facts[0]!.fact).toContain("shell 'pnpm test': succeeded");
  });

  it('should return empty for failed tool calls', () => {
    const facts = extractHeuristicFacts('fs_read', { path: '/missing.ts' }, 'File not found', false);
    expect(facts).toHaveLength(0);
  });

  it('should return empty for unknown tool names', () => {
    const facts = extractHeuristicFacts('unknown_tool', {}, 'some output', true);
    expect(facts).toHaveLength(0);
  });
});
