/**
 * E2E tests for hello command with V3 metadata injection
 *
 * These tests verify:
 * 1. Hello command executes successfully
 * 2. Returns structured result
 * 3. Auto-injects standard metadata (executedAt, duration, etc.)
 * 4. Preserves custom metadata
 */

import { describe, expect, it } from 'vitest';
import { runInProcess } from '@kb-labs/plugin-runtime';
import type { PluginContextDescriptor, UIFacade, PlatformServices } from '@kb-labs/plugin-contracts';
import { resolve } from 'node:path';

// Mock UI
const mockUI: UIFacade = {
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  spinner: () => ({ update: () => {}, stop: () => {} }),
  table: () => {},
  json: () => {},
  newline: () => {},
  divider: () => {},
  box: () => {},
  sideBox: () => {},
  confirm: async () => true,
  prompt: async () => 'test',
};

// Mock logger
const mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: function(this: any) { return this; },
};

// Mock platform
const mockPlatform: PlatformServices = {
  logger: mockLogger as any,
  llm: {} as any,
  embeddings: {} as any,
  vectorStore: {} as any,
  cache: {} as any,
  storage: {} as any,
  analytics: {} as any,
};

describe('E2E: Hello Command', () => {
  const helloCommandPath = resolve(__dirname, '../../dist/cli/commands/hello.js');

  it('should execute hello command and return structured result with metadata', async () => {
    const descriptor: PluginContextDescriptor = {
      host: 'cli',
      pluginId: '@kb-labs/plugin-template',
      pluginVersion: '0.1.0',
      requestId: 'req-hello-e2e-123',
      commandId: 'plugin-template:hello',
      tenantId: 'test-tenant',
      cwd: process.cwd(),
      outdir: resolve('.kb/plugin-template'),
      permissions: {},
      hostContext: {
        host: 'cli',
        argv: [],
        flags: { name: 'E2E Test' },
      },
      parentRequestId: undefined,
    };

    const result = await runInProcess({
      descriptor,
      platform: mockPlatform,
      ui: mockUI,
      handlerPath: helloCommandPath,
      input: {
        argv: [],
        flags: { name: 'E2E Test' },
      },
    });

    // Verify exitCode
    expect(result.exitCode).toBe(0);

    // Verify structured result
    expect(result.result).toBeDefined();
    expect(result.result).toHaveProperty('message');
    expect(result.result).toHaveProperty('target');
    expect(result.result.message).toBe('Hello, E2E Test!');
    expect(result.result.target).toBe('E2E Test');

    // Verify auto-injected standard metadata
    expect(result.meta).toBeDefined();
    expect(result.meta?.executedAt).toBeDefined();
    expect(typeof result.meta?.executedAt).toBe('string');
    expect(new Date(result.meta?.executedAt!).getTime()).toBeGreaterThan(0);

    expect(result.meta?.duration).toBeDefined();
    expect(typeof result.meta?.duration).toBe('number');
    expect(result.meta?.duration).toBeGreaterThanOrEqual(0);

    expect(result.meta?.pluginId).toBe('@kb-labs/plugin-template');
    expect(result.meta?.pluginVersion).toBe('0.1.0');
    expect(result.meta?.commandId).toBe('plugin-template:hello');
    expect(result.meta?.host).toBe('cli');
    expect(result.meta?.tenantId).toBe('test-tenant');
    expect(result.meta?.requestId).toBe('req-hello-e2e-123');

    // Verify custom metadata is preserved
    expect(result.meta?.version).toBe('v3');
    expect(result.meta?.timing).toBeDefined();
  });

  it('should execute hello command without name (default "World")', async () => {
    const descriptor: PluginContextDescriptor = {
      host: 'cli',
      pluginId: '@kb-labs/plugin-template',
      pluginVersion: '0.1.0',
      requestId: 'req-hello-world',
      commandId: 'plugin-template:hello',
      cwd: process.cwd(),
      permissions: {},
      hostContext: {
        host: 'cli',
        argv: [],
        flags: {},
      },
      parentRequestId: undefined,
    };

    const result = await runInProcess({
      descriptor,
      platform: mockPlatform,
      ui: mockUI,
      handlerPath: helloCommandPath,
      input: {
        argv: [],
        flags: {},
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.message).toBe('Hello, World!');
    expect(result.result.target).toBe('World');

    // Metadata still injected even for default case
    expect(result.meta).toBeDefined();
    expect(result.meta?.executedAt).toBeDefined();
    expect(result.meta?.pluginId).toBe('@kb-labs/plugin-template');
  });

  it('should measure duration accurately', async () => {
    const descriptor: PluginContextDescriptor = {
      host: 'cli',
      pluginId: '@kb-labs/plugin-template',
      pluginVersion: '0.1.0',
      requestId: 'req-timing-test',
      commandId: 'plugin-template:hello',
      cwd: process.cwd(),
      permissions: {},
      hostContext: {
        host: 'cli',
        argv: [],
        flags: { name: 'Timing' },
      },
      parentRequestId: undefined,
    };

    const startTime = Date.now();

    const result = await runInProcess({
      descriptor,
      platform: mockPlatform,
      ui: mockUI,
      handlerPath: helloCommandPath,
      input: {
        argv: [],
        flags: { name: 'Timing' },
      },
    });

    const endTime = Date.now();
    const measuredDuration = endTime - startTime;

    expect(result.exitCode).toBe(0);
    expect(result.meta?.duration).toBeDefined();

    // Duration should be close to measured duration (within 100ms tolerance)
    expect(result.meta?.duration!).toBeGreaterThanOrEqual(0);
    expect(result.meta?.duration!).toBeLessThanOrEqual(measuredDuration + 100);
  });

  it('should include timing breakdown in custom metadata', async () => {
    const descriptor: PluginContextDescriptor = {
      host: 'cli',
      pluginId: '@kb-labs/plugin-template',
      pluginVersion: '0.1.0',
      requestId: 'req-breakdown',
      commandId: 'plugin-template:hello',
      cwd: process.cwd(),
      permissions: {},
      hostContext: {
        host: 'cli',
        argv: [],
        flags: { name: 'Breakdown' },
      },
      parentRequestId: undefined,
    };

    const result = await runInProcess({
      descriptor,
      platform: mockPlatform,
      ui: mockUI,
      handlerPath: helloCommandPath,
      input: {
        argv: [],
        flags: { name: 'Breakdown' },
      },
    });

    expect(result.exitCode).toBe(0);

    // Verify custom timing breakdown exists
    expect(result.meta?.timing).toBeDefined();
    expect(Array.isArray(result.meta?.timing)).toBe(true);
    expect((result.meta?.timing as any[]).length).toBeGreaterThan(0);

    // Verify timing breakdown has expected structure
    const timing = result.meta?.timing as any[];
    expect(timing[0]).toHaveProperty('checkpoint');
    expect(timing[0]).toHaveProperty('elapsed');
  });

  it('should handle JSON output flag', async () => {
    const descriptor: PluginContextDescriptor = {
      host: 'cli',
      pluginId: '@kb-labs/plugin-template',
      pluginVersion: '0.1.0',
      requestId: 'req-json',
      commandId: 'plugin-template:hello',
      cwd: process.cwd(),
      permissions: {},
      hostContext: {
        host: 'cli',
        argv: [],
        flags: { name: 'JSON', json: true },
      },
      parentRequestId: undefined,
    };

    const result = await runInProcess({
      descriptor,
      platform: mockPlatform,
      ui: mockUI,
      handlerPath: helloCommandPath,
      input: {
        argv: [],
        flags: { name: 'JSON', json: true },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.message).toBe('Hello, JSON!');
    expect(result.result.target).toBe('JSON');

    // Metadata still injected even in JSON mode
    expect(result.meta).toBeDefined();
  });
});
