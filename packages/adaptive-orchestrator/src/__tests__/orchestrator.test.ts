/**
 * Tests for AdaptiveOrchestrator
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveOrchestrator } from '../orchestrator.js';
import type { ILogger, ILLM } from '@kb-labs/sdk';

// Mock logger
const createMockLogger = (): ILogger => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

// Mock LLM
const createMockLLM = (responses: string[]): ILLM => {
  let callCount = 0;
  return {
    complete: vi.fn(async () => {
      const response = responses[callCount] || responses[responses.length - 1];
      callCount++;
      return { content: response };
    }),
    stream: vi.fn(),
  };
};

// Mock useLLM globally
vi.mock('@kb-labs/sdk', async () => {
  const actual = await vi.importActual('@kb-labs/sdk');
  return {
    ...actual,
    useLLM: vi.fn(() => createMockLLM([
      // Classification response
      'MEDIUM | Standard development task',
      // Planning response
      JSON.stringify([
        { id: 1, description: 'Subtask 1', complexity: 'small' },
        { id: 2, description: 'Subtask 2', complexity: 'medium' },
      ]),
      // Subtask 1 execution
      'Subtask 1 completed successfully',
      // Subtask 2 execution
      'Subtask 2 completed successfully',
      // Synthesis
      'Final result synthesized',
    ])),
  };
});

describe('AdaptiveOrchestrator', () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = createMockLogger();
    vi.clearAllMocks();
  });

  describe('Basic execution', () => {
    it('should execute task successfully', async () => {
      const orchestrator = new AdaptiveOrchestrator(logger);

      const result = await orchestrator.execute('Test task');

      expect(result.status).toBe('success');
      expect(result.result).toBeDefined();
      expect(result.costBreakdown).toBeDefined();
      expect(result.costBreakdown.total).toMatch(/^\$\d+\.\d{4}$/);
    });

    it('should track subtask results', async () => {
      const orchestrator = new AdaptiveOrchestrator(logger);

      const result = await orchestrator.execute('Test task');

      expect(result.subtaskResults).toBeDefined();
      expect(result.subtaskResults!.length).toBeGreaterThan(0);
      expect(result.subtaskResults![0]).toHaveProperty('id');
      expect(result.subtaskResults![0]).toHaveProperty('status');
      expect(result.subtaskResults![0]).toHaveProperty('tier');
    });
  });

  describe('Progress tracking', () => {
    it('should emit progress events via callback', async () => {
      const events: any[] = [];
      const orchestrator = new AdaptiveOrchestrator(
        logger,
        (event) => events.push(event)
      );

      await orchestrator.execute('Test task');

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('task_started');
      expect(events[events.length - 1].type).toBe('task_completed');
    });

    it('should log progress to logger', async () => {
      const orchestrator = new AdaptiveOrchestrator(logger);

      await orchestrator.execute('Test task');

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Task started')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('success')
      );
    });
  });

  describe('Cost tracking', () => {
    it('should calculate cost breakdown', async () => {
      const orchestrator = new AdaptiveOrchestrator(logger);

      const result = await orchestrator.execute('Test task');

      expect(result.costBreakdown).toBeDefined();
      expect(result.costBreakdown.total).toBeDefined();
      expect(result.costBreakdown.small).toBeDefined();
      expect(result.costBreakdown.medium).toBeDefined();
      expect(result.costBreakdown.large).toBeDefined();
    });

    it('should respect trackCost config', async () => {
      const orchestrator = new AdaptiveOrchestrator(
        logger,
        undefined,
        { trackCost: false }
      );

      const result = await orchestrator.execute('Test task');

      expect(result.costBreakdown.total).toBe('N/A');
    });
  });

  describe('Configuration', () => {
    it('should use custom pricing', async () => {
      const orchestrator = new AdaptiveOrchestrator(
        logger,
        undefined,
        {
          pricing: {
            small: 2_000_000,
            medium: 1_000_000,
            large: 200_000,
          },
        }
      );

      const result = await orchestrator.execute('Test task');

      expect(result.status).toBe('success');
      expect(result.costBreakdown.total).toBeDefined();
    });

    it('should respect maxEscalations', async () => {
      const orchestrator = new AdaptiveOrchestrator(
        logger,
        undefined,
        { maxEscalations: 1 }
      );

      const result = await orchestrator.execute('Test task');

      expect(result.status).toBe('success');
    });
  });

  describe('Error handling', () => {
    it('should handle classification errors gracefully', async () => {
      // Override useLLM to return null (LLM not available)
      const { useLLM } = await import('@kb-labs/sdk');
      vi.mocked(useLLM).mockImplementationOnce(() => null as any);

      // Creating orchestrator will throw since classifier needs LLM
      expect(() => new AdaptiveOrchestrator(logger)).toThrow('LLM not available');
    });

    it('should handle planning JSON parse errors', async () => {
      // Override useLLM to return invalid JSON
      const { useLLM } = await import('@kb-labs/sdk');
      vi.mocked(useLLM).mockImplementationOnce(() =>
        createMockLLM([
          'MEDIUM | Test',
          'Invalid JSON {{{',
          'Fallback result',
          'Final synthesis',
        ])
      );

      const orchestrator = new AdaptiveOrchestrator(logger);

      const result = await orchestrator.execute('Test task');

      expect(result.status).toBe('success');
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
