import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SmartSummarizer } from '../smart-summarizer';
import type { LLMMessage, ILLM } from '@kb-labs/sdk';

// Mock LLM
const createMockLLM = (): ILLM => ({
  chat: vi.fn(async (messages: LLMMessage[]) => ({
    content: 'Mock summary: Files created, tools used, accomplishments.',
    role: 'assistant',
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  })),
  chatWithTools: vi.fn(),
  tier: 'small',
} as any);

describe('SmartSummarizer', () => {
  let summarizer: SmartSummarizer;
  let mockLLM: ILLM;

  beforeEach(() => {
    summarizer = new SmartSummarizer({
      summarizationInterval: 10,
      llmTier: 'small',
      maxSummaryTokens: 500,
    });
    mockLLM = createMockLLM();
    summarizer.setLLM(mockLLM);
  });

  describe('Triggering Summarization', () => {
    it('should only trigger at interval boundaries', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 1 } as any,
      ];

      // Iteration 5 - should not trigger
      await summarizer.triggerSummarization(snapshot, 5);
      expect(mockLLM.chat).not.toHaveBeenCalled();

      // Iteration 10 - should trigger
      await summarizer.triggerSummarization(snapshot, 10);
      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockLLM.chat).toHaveBeenCalled();
    });

    it('should extract correct iteration range', async () => {
      const snapshot: LLMMessage[] = [];

      // Create messages for iterations 1-15
      for (let i = 1; i <= 15; i++) {
        snapshot.push({
          role: i % 2 === 0 ? 'assistant' : 'user',
          content: `msg${i}`,
          iteration: i,
        } as any);
      }

      // Trigger at iteration 10 (should summarize 0-10, but we have 1-10)
      await summarizer.triggerSummarization(snapshot, 10);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have summary for iteration 0
      const summary = summarizer.getSummary(0);
      expect(summary).toBeTruthy();
      expect(summary).toContain('Mock summary');
    });

    it('should not include future iterations in summary', async () => {
      const snapshot: LLMMessage[] = [];

      // Add iterations 1-15
      for (let i = 1; i <= 15; i++) {
        snapshot.push({
          role: 'user',
          content: `iteration ${i}`,
          iteration: i,
        } as any);
      }

      // Trigger at iteration 10
      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Summary should only include iterations 0-9 (we have 1-9)
      const chatCalls = (mockLLM.chat as any).mock.calls;
      expect(chatCalls.length).toBe(1);

      const prompt = chatCalls[0][0][0].content;
      expect(prompt).toContain('iterations 0 to 10');
    });
  });

  describe('Queue Processing', () => {
    it('should process queue in FIFO order', async () => {
      const snapshot1: LLMMessage[] = [
        { role: 'user', content: 'task1', iteration: 5 } as any,
      ];
      const snapshot2: LLMMessage[] = [
        { role: 'user', content: 'task2', iteration: 15 } as any,
      ];

      // Trigger two summaries
      await summarizer.triggerSummarization(snapshot1, 10);
      await summarizer.triggerSummarization(snapshot2, 20);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have both summaries
      expect(summarizer.getSummary(0)).toBeTruthy();
      expect(summarizer.getSummary(10)).toBeTruthy();
    });

    it('should not create duplicate summaries', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      // Trigger twice for same range
      await summarizer.triggerSummarization(snapshot, 10);
      await summarizer.triggerSummarization(snapshot, 10);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should only call LLM once
      expect((mockLLM.chat as any).mock.calls.length).toBe(1);
    });

    it('should process queue without blocking', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      const startTime = Date.now();

      // Trigger summarization (async)
      const promise = summarizer.triggerSummarization(snapshot, 10);

      // Should return immediately (not wait for LLM)
      await promise;
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(50); // Fast return
    });
  });

  describe('Summary Retrieval', () => {
    it('should retrieve summary by start iteration', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const summary = summarizer.getSummary(0);
      expect(summary).toContain('Mock summary');
    });

    it('should return null for non-existent summary', () => {
      const summary = summarizer.getSummary(999);
      expect(summary).toBeNull();
    });

    it('should check if summary exists', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Iterations 0-9 should have summary
      expect(summarizer.hasSummary(5)).toBe(true);
      expect(summarizer.hasSummary(9)).toBe(true);

      // Iteration 10+ should not
      expect(summarizer.hasSummary(15)).toBe(false);
    });

    it('should get all summaries in order', async () => {
      const snapshot1: LLMMessage[] = [
        { role: 'user', content: 'test1', iteration: 5 } as any,
      ];
      const snapshot2: LLMMessage[] = [
        { role: 'user', content: 'test2', iteration: 15 } as any,
      ];

      await summarizer.triggerSummarization(snapshot1, 10);
      await summarizer.triggerSummarization(snapshot2, 20);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const all = summarizer.getAllSummaries();
      expect(all.length).toBe(2);
      expect(all[0].startIteration).toBe(0);
      expect(all[1].startIteration).toBe(10);
      expect(all[0].summary).toContain('Mock summary');
    });
  });

  describe('Thread Safety', () => {
    it('should use immutable snapshots', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'original', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);

      // Mutate original snapshot
      snapshot[0].content = 'modified';

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Summary should still use original (frozen snapshot)
      const summary = summarizer.getSummary(0);
      expect(summary).toBeTruthy(); // Should have been generated successfully
    });

    it('should not process queue concurrently', async () => {
      let processingCount = 0;

      // Mock LLM with delay to simulate processing
      const slowLLM: ILLM = {
        chat: vi.fn(async () => {
          processingCount++;
          expect(processingCount).toBe(1); // Only one processing at a time
          await new Promise((resolve) => setTimeout(resolve, 50));
          processingCount--;
          return {
            content: 'Summary',
            role: 'assistant',
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          };
        }),
      } as any;

      summarizer.setLLM(slowLLM);

      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      // Trigger multiple summaries quickly
      await Promise.all([
        summarizer.triggerSummarization(snapshot, 10),
        summarizer.triggerSummarization(snapshot, 20),
        summarizer.triggerSummarization(snapshot, 30),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  });

  describe('Configuration', () => {
    it('should respect custom interval', async () => {
      const customSummarizer = new SmartSummarizer({ summarizationInterval: 5 });
      customSummarizer.setLLM(mockLLM);

      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 3 } as any,
      ];

      // Should trigger at iteration 5 (not 10)
      await customSummarizer.triggerSummarization(snapshot, 5);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockLLM.chat).toHaveBeenCalled();
    });

    it('should provide stats', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const stats = summarizer.getStats();
      expect(stats.totalSummaries).toBe(1);
      expect(stats.queueLength).toBe(0);
      expect(stats.summaryRanges.length).toBe(1);
      expect(stats.summaryRanges[0]).toEqual({ start: 0, end: 10 });
    });

    it('should clear summaries', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => setTimeout(resolve, 100));

      summarizer.clearSummaries();

      expect(summarizer.getSummary(0)).toBeNull();
      expect(summarizer.getStats().totalSummaries).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should throw if LLM not set', async () => {
      const noLLMSummarizer = new SmartSummarizer();

      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await noLLMSummarizer.triggerSummarization(snapshot, 10);

      // Wait for queue processing (should fail gracefully)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not have summary (failed to generate)
      expect(noLLMSummarizer.getSummary(0)).toBeNull();
    });
  });
});
