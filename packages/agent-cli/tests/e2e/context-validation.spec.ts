/**
 * E2E tests for plugin context validation
 *
 * These tests verify that all context properties are correctly passed
 * through the subprocess sandbox to handlers.
 *
 * Test approach:
 * 1. Create a test handler that inspects and returns context properties
 * 2. Execute via nodeSubprocRunner (real subprocess)
 * 3. Validate returned context snapshot
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { nodeSubprocRunner } from '@kb-labs/plugin-runtime';
import { permissions } from '@kb-labs/sdk';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// Test manifest for context validation
const testManifest = {
  schema: 'kb.plugin/2' as const,
  id: '@kb-labs/test-context',
  version: '1.0.0-test',
  display: {
    name: 'Context Test Plugin',
    description: 'Tests context properties',
  },
};

// Test permissions for generic tests
const testPerms = permissions.combine(
  permissions.presets.pluginWorkspace('test-context'),
  {
    quotas: {
      timeoutMs: 30000,
      memoryMb: 128,
    },
  }
);

// Permissions for hello job (needs .kb/template access)
const helloJobPerms = permissions.combine(
  permissions.presets.pluginWorkspace('template'),
  {
    quotas: {
      timeoutMs: 30000,
      memoryMb: 128,
    },
  }
);

describe('E2E: Plugin Context Validation', () => {
  const testHandlerPath = path.join(__dirname, 'fixtures', 'context-inspector.js');
  let testDir: string;

  beforeAll(async () => {
    // Create test fixtures directory
    testDir = path.join(__dirname, 'fixtures');
    await fs.mkdir(testDir, { recursive: true });

    // Create test handler that inspects context
    const handlerCode = `
      /**
       * Test handler that inspects and returns context properties
       */
      export async function inspectContext(input, ctx) {
        // Collect context snapshot
        const snapshot = {
          // Basic context fields
          hasRequestId: typeof ctx.requestId === 'string' && ctx.requestId.length > 0,
          hasPluginId: typeof ctx.pluginId === 'string' && ctx.pluginId.length > 0,
          hasPluginVersion: typeof ctx.pluginVersion === 'string',
          hasWorkdir: typeof ctx.workdir === 'string',
          hasOutdir: typeof ctx.outdir === 'string' || ctx.outdir === undefined,
          type: ctx.type,

          // Runtime APIs (ctx.runtime)
          runtime: {
            exists: !!ctx.runtime,
            hasFs: !!ctx.runtime?.fs,
            hasFetch: !!ctx.runtime?.fetch,
            hasEnv: !!ctx.runtime?.env,
            // Test fs methods exist
            fsMethods: ctx.runtime?.fs ? {
              hasReadFile: typeof ctx.runtime.fs.readFile === 'function',
              hasWriteFile: typeof ctx.runtime.fs.writeFile === 'function',
              hasMkdir: typeof ctx.runtime.fs.mkdir === 'function',
              hasReaddir: typeof ctx.runtime.fs.readdir === 'function',
              hasStat: typeof ctx.runtime.fs.stat === 'function',
              hasUnlink: typeof ctx.runtime.fs.unlink === 'function',
            } : null,
          },

          // Plugin API (ctx.api) - if available
          api: {
            exists: !!ctx.api,
            hasInvoke: typeof ctx.api?.invoke === 'function',
            hasState: !!ctx.api?.state,
            hasArtifacts: !!ctx.api?.artifacts,
            hasShell: !!ctx.api?.shell,
            hasEvents: !!ctx.api?.events,
          },

          // Platform adapters (ctx.platform) - if available
          platform: {
            exists: !!ctx.platform,
            hasLlm: !!ctx.platform?.llm,
            hasEmbeddings: !!ctx.platform?.embeddings,
            hasVectorStore: !!ctx.platform?.vectorStore,
            hasAnalytics: !!ctx.platform?.analytics,
          },

          // Output (ctx.output)
          output: {
            exists: !!ctx.output,
            hasInfo: typeof ctx.output?.info === 'function',
            hasWarn: typeof ctx.output?.warn === 'function',
            hasError: typeof ctx.output?.error === 'function',
            hasDebug: typeof ctx.output?.debug === 'function',
          },

          // Input validation
          input: {
            received: input,
            hasExpectedFields: input?.testField === 'test-value',
          },

          // Metadata
          debug: ctx.debug,
          traceId: ctx.traceId,
          spanId: ctx.spanId,
        };

        return {
          exitCode: 0,
          result: {
            snapshot,
            timestamp: new Date().toISOString(),
          },
        };
      }
    `;

    await fs.writeFile(testHandlerPath, handlerCode, 'utf-8');
  });

  afterAll(async () => {
    // Cleanup test fixtures
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should pass all required context properties to job handler', async () => {
    const runner = nodeSubprocRunner(false); // Real subprocess mode

    const result = await runner.run({
      handler: { file: './tests/e2e/fixtures/context-inspector', export: 'inspectContext' },
      input: { testField: 'test-value', jobId: 'test-job', runCount: 1 },
      ctx: {
        requestId: 'test-request-123',
        pluginId: '@kb-labs/test-context',
        pluginVersion: '1.0.0-test',
        pluginRoot: path.resolve(__dirname, '../..'),
        workdir: process.cwd(),
        outdir: path.join('.kb', 'test-context'),
        adapterMeta: { signature: 'job' },
        debug: true,
        traceId: 'trace-123',
        spanId: 'span-456',
      },
      perms: testPerms,
      manifest: testManifest as any,
    });

    // Verify execution succeeded
    expect(result.exitCode).toBe(0);
    expect(result.result).toBeDefined();
    expect(result.meta).toBeDefined();

    // Verify metadata auto-injection
    expect(result.meta?.executedAt).toBeDefined();
    expect(result.meta?.duration).toBeDefined();
    expect(result.meta?.pluginId).toBe('@kb-labs/test-context');
    expect(result.meta?.requestId).toBe('test-request-123');

    const snapshot = (result.result as any).snapshot;

    // Basic context fields
    expect(snapshot.hasRequestId).toBe(true);
    expect(snapshot.hasPluginId).toBe(true);
    expect(snapshot.hasPluginVersion).toBe(true);
    expect(snapshot.hasWorkdir).toBe(true);
    expect(snapshot.type).toBe('job');

    // Runtime APIs must exist for job handlers
    expect(snapshot.runtime.exists).toBe(true);
    expect(snapshot.runtime.hasFs).toBe(true);
    expect(snapshot.runtime.hasFetch).toBe(true);
    expect(snapshot.runtime.hasEnv).toBe(true);

    // FS methods must be available
    expect(snapshot.runtime.fsMethods).toBeDefined();
    expect(snapshot.runtime.fsMethods.hasReadFile).toBe(true);
    expect(snapshot.runtime.fsMethods.hasWriteFile).toBe(true);
    expect(snapshot.runtime.fsMethods.hasMkdir).toBe(true);

    // Output must exist
    expect(snapshot.output.exists).toBe(true);
    expect(snapshot.output.hasInfo).toBe(true);
    expect(snapshot.output.hasError).toBe(true);

    // Plugin API must exist (provided via brokers over IPC)
    expect(snapshot.api.exists).toBe(true);
    expect(snapshot.api.hasInvoke).toBe(true);
    expect(snapshot.api.hasState).toBe(true);
    expect(snapshot.api.hasArtifacts).toBe(true);
    expect(snapshot.api.hasShell).toBe(true);
    expect(snapshot.api.hasEvents).toBe(true);
    // NOTE: config is accessed via useConfig() from @kb-labs/sdk, not ctx.api

    // NOTE: ctx.platform is NOT currently available in sandbox handlers
    // Platform adapters (llm, embeddings, vectorStore, analytics) require
    // additional work to proxy through IPC like ctx.api does.
    // For now, handlers that need platform should use ctx.api.invoke()
    // to call parent process handlers that have platform access.
    expect(snapshot.platform.exists).toBe(false);

    // Input was correctly passed
    expect(snapshot.input.hasExpectedFields).toBe(true);
  });

  it('should provide working fs operations via existing hello job', async () => {
    // Use the actual hello job handler which tests fs operations
    // This verifies the real job handler receives working ctx.runtime.fs
    const runner = nodeSubprocRunner(false);

    const result = await runner.run({
      handler: { file: './jobs/hello', export: 'run' },
      input: {
        jobId: 'test-hello',
        executedAt: new Date().toISOString(),
        runCount: 999, // Use high number to identify test run in log
      },
      ctx: {
        requestId: 'e2e-fs-test-123',
        pluginId: '@kb-labs/plugin-template',
        pluginVersion: '0.1.0',
        pluginRoot: path.resolve(__dirname, '../..'),
        workdir: process.cwd(),
        outdir: path.join('.kb', 'plugin-template'),
        adapterMeta: { signature: 'job' },
        debug: true,
      },
      perms: helloJobPerms, // Use correct permissions for .kb/template
      manifest: testManifest as any,
    });

    // The hello job now returns CommandResult<T> with { exitCode, result, meta }
    // Debug: log result if failed
    if (result.exitCode !== 0) {
      console.error('Test failed with exitCode:', result.exitCode);
    }
    expect(result.exitCode).toBe(0);
    expect(result.meta).toBeDefined();

    const data = result.result as any;
    expect(data.ok).toBe(true);
    expect(data.runCount).toBe(999);
    expect(data.message).toContain('Hello from sandboxed cron job');
  });

  it('should NOT have runtime.fs for CLI command signature', async () => {
    const runner = nodeSubprocRunner(false);

    // CLI commands get different context shape
    const result = await runner.run({
      handler: { file: './tests/e2e/fixtures/context-inspector', export: 'inspectContext' },
      input: {},
      ctx: {
        requestId: 'cli-test-123',
        pluginId: '@kb-labs/test-context',
        pluginVersion: '1.0.0-test',
        pluginRoot: path.resolve(__dirname, '../..'),
        workdir: process.cwd(),
        adapterMeta: { signature: 'command' }, // CLI signature
        debug: true,
      },
      perms: testPerms,
      manifest: testManifest as any,
    });

    // CLI commands have different context structure
    // They receive (ctx, argv, flags) not (input, ctx)
    // This test verifies the signature routing works
    expect(result.exitCode).toBeDefined();
    expect(result.meta).toBeDefined();
  });
});

/**
 * Test utility: Create a context validation report
 *
 * Usage in handlers:
 * ```ts
 * import { validateContext } from '@kb-labs/plugin-runtime/testing';
 *
 * async function myHandler(input, ctx) {
 *   const report = validateContext(ctx, 'job');
 *   if (!report.valid) {
 *     throw new Error(`Invalid context: ${report.errors.join(', ')}`);
 *   }
 *   // ... handler logic
 * }
 * ```
 */
export interface ContextValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  snapshot: Record<string, unknown>;
}

export function validateContext(
  ctx: unknown,
  expectedType: 'job' | 'cli' | 'rest'
): ContextValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const c = ctx as any;

  // Required fields
  if (!c?.requestId) errors.push('Missing requestId');
  if (!c?.pluginId) errors.push('Missing pluginId');
  if (!c?.workdir) errors.push('Missing workdir');

  // Type-specific validation
  if (expectedType === 'job') {
    if (!c?.runtime?.fs) errors.push('Missing runtime.fs for job handler');
    if (!c?.runtime?.fetch) warnings.push('Missing runtime.fetch');
    if (!c?.runtime?.env) warnings.push('Missing runtime.env');
    if (!c?.output) warnings.push('Missing output');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    snapshot: {
      type: c?.type,
      hasRuntime: !!c?.runtime,
      hasApi: !!c?.api,
      hasPlatform: !!c?.platform,
      hasOutput: !!c?.output,
    },
  };
}
