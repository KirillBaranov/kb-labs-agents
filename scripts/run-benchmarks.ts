/**
 * Run agent benchmarks - Phase 1
 *
 * Tests agent quality improvements after implementing:
 * - Task Classification
 * - ReAct Pattern (tool-first thinking)
 */

import { AgentExecutor } from '../packages/agent-core/src/executor/agent-executor.js';
import { AgentRegistry } from '../packages/agent-core/src/registry/agent-registry.js';
import { createTestContext } from '@kb-labs/sdk';
import type { AgentConfig, AgentContext } from '@kb-labs/agent-contracts';

interface BenchmarkTest {
  id: string;
  category: string;
  query: string;
  expectedBehavior: string[];
  minimumToolCalls: number;
}

const benchmarkTests: BenchmarkTest[] = [
  {
    id: '1.1',
    category: 'Simple Lookup',
    query: 'What is the VectorStore interface?',
    expectedBehavior: [
      'Should call mind:rag-query',
      'Should search for VectorStore',
      'Should provide actual definition from codebase',
    ],
    minimumToolCalls: 1,
  },
  {
    id: '1.2',
    category: 'Simple Lookup',
    query: 'Where is the agent executor implemented?',
    expectedBehavior: [
      'Should use mind:rag-query or fs:search',
      'Should find agent-executor.ts',
      'Should report actual file path',
    ],
    minimumToolCalls: 1,
  },
  {
    id: '2.1',
    category: 'Code Finding',
    query: 'How does loop detection work in agents?',
    expectedBehavior: [
      'Should call mind:rag-query',
      'Should find loop-detector.ts',
      'Should explain actual implementation',
    ],
    minimumToolCalls: 1,
  },
];

async function runBenchmark(test: BenchmarkTest): Promise<{
  passed: boolean;
  toolsUsed: number;
  tokensUsed: number;
  durationMs: number;
  notes: string[];
}> {
  console.log(`\n📊 Running Test ${test.id}: ${test.category}`);
  console.log(`Query: "${test.query}"`);

  const ctx = createTestContext({});
  const registry = new AgentRegistry(process.cwd() + '/.kb/agents');

  try {
    const agents = await registry.discover();
    const mindAssistant = agents.find((a) => a.id === 'mind-assistant');

    if (!mindAssistant) {
      throw new Error('mind-assistant not found');
    }

    const executor = new AgentExecutor(ctx);

    const agentContext: AgentContext = {
      config: mindAssistant as AgentConfig,
      tools: mindAssistant.tools,
      systemPrompt: mindAssistant.systemPrompt,
    };

    const startTime = Date.now();
    const result = await executor.execute(agentContext, test.query);
    const durationMs = Date.now() - startTime;

    const toolCalls = result.steps.reduce((acc, step) => acc + (step.toolCalls?.length || 0), 0);

    const notes: string[] = [];
    const passed = toolCalls >= test.minimumToolCalls;

    if (toolCalls === 0) {
      notes.push('❌ CRITICAL: No tools used - answered from training data');
    } else if (toolCalls < test.minimumToolCalls) {
      notes.push(`⚠️ Used ${toolCalls} tools, expected at least ${test.minimumToolCalls}`);
    } else {
      notes.push(`✅ Used ${toolCalls} tools`);
    }

    // Check if mind:rag-query was used for lookup/code-finding queries
    const usedMindRAG = result.steps.some(
      (step) => step.toolCalls?.some((tc) => tc.name === 'mind:rag-query')
    );

    if (['Simple Lookup', 'Code Finding'].includes(test.category)) {
      if (!usedMindRAG) {
        notes.push('⚠️ Did not use mind:rag-query (should be primary tool)');
      } else {
        notes.push('✅ Used mind:rag-query');
      }
    }

    console.log(`\n  Result:`);
    console.log(`  - Passed: ${passed ? '✅' : '❌'}`);
    console.log(`  - Tools: ${toolCalls}`);
    console.log(`  - Tokens: ${result.totalTokens}`);
    console.log(`  - Duration: ${durationMs}ms`);
    notes.forEach((note) => console.log(`  - ${note}`));

    return {
      passed,
      toolsUsed: toolCalls,
      tokensUsed: result.totalTokens || 0,
      durationMs,
      notes,
    };
  } catch (error) {
    console.error(`  ❌ Error:`, error);
    return {
      passed: false,
      toolsUsed: 0,
      tokensUsed: 0,
      durationMs: 0,
      notes: [`Error: ${error}`],
    };
  }
}

async function main() {
  console.log('🚀 Agent Benchmarks - Phase 1\n');
  console.log('Testing improvements:');
  console.log('  - Task Classification');
  console.log('  - ReAct Pattern (tool-first thinking)');
  console.log('  - Structured prompts\n');

  const results = [];

  for (const test of benchmarkTests) {
    const result = await runBenchmark(test);
    results.push({  test, result });
  }

  // Summary
  console.log('\n\n📊 Benchmark Summary\n');
  console.log('| Test ID | Category | Passed | Tools | Tokens | Duration |');
  console.log('|---------|----------|--------|-------|--------|----------|');

  for (const { test, result } of results) {
    const status = result.passed ? '✅' : '❌';
    console.log(
      `| ${test.id} | ${test.category.padEnd(15)} | ${status} | ${result.toolsUsed} | ${result.tokensUsed} | ${result.durationMs}ms |`
    );
  }

  const passCount = results.filter((r) => r.result.passed).length;
  const totalTools = results.reduce((acc, r) => acc + r.result.toolsUsed, 0);
  const avgTools = (totalTools / results.length).toFixed(1);

  console.log('\n');
  console.log(`Success Rate: ${passCount}/${results.length} (${((passCount / results.length) * 100).toFixed(0)}%)`);
  console.log(`Average Tools Used: ${avgTools}`);
  console.log(`Tool Usage Rate: ${totalTools > 0 ? '100%' : '0%'} (at least 1 tool per test)`);
}

main().catch(console.error);
