import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SmartSummarizer } from '../smart-summarizer';
import type { FactExtractionResult, OnFactsExtracted } from '../smart-summarizer';
import type { LLMMessage } from '@kb-labs/sdk';
import { mockLLM } from '@kb-labs/sdk/testing';

// Mock LLM response: valid JSON array of facts
const MOCK_FACTS_JSON = JSON.stringify([
  { category: 'finding', fact: 'Found 3 TODO items in source files', confidence: 0.8, source: 'grep_search' },
  { category: 'file_content', fact: 'Read src/index.ts with 50 lines', confidence: 0.9, source: 'fs_read' },
]);

describe('SmartSummarizer', () => {
  let summarizer: SmartSummarizer;
  let llm: ReturnType<typeof mockLLM>;
  let onFactsExtracted: OnFactsExtracted;
  let extractedResults: FactExtractionResult[];

  beforeEach(() => {
    extractedResults = [];
    onFactsExtracted = vi.fn((result: FactExtractionResult) => {
      extractedResults.push(result);
    });

    summarizer = new SmartSummarizer({
      summarizationInterval: 10,
      llmTier: 'small',
      maxSummaryTokens: 500,
      onFactsExtracted,
    });

    llm = mockLLM()
      .onAnyComplete()
      .respondWith(MOCK_FACTS_JSON);
    summarizer.setLLM(llm);
  });

  describe('Triggering Summarization', () => {
    it('should only trigger at interval boundaries', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 1 } as any,
      ];

      // Iteration 5 - should not trigger
      await summarizer.triggerSummarization(snapshot, 5);
      expect(llm.complete).not.toHaveBeenCalled();

      // Iteration 10 - should trigger
      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      expect(llm.complete).toHaveBeenCalled();
    });

    it('should extract correct iteration range', async () => {
      const snapshot: LLMMessage[] = [];

      for (let i = 1; i <= 15; i++) {
        snapshot.push({
          role: i % 2 === 0 ? 'assistant' : 'user',
          content: `msg${i}`,
          iteration: i,
        } as any);
      }

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      const summary = summarizer.getSummary(0);
      expect(summary).toBeTruthy();
      // Summary is now built from extracted fact categories
      expect(summary).toContain('[finding]');
    });

    it('should pass extracted facts to onFactsExtracted callback', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      expect(onFactsExtracted).toHaveBeenCalledTimes(1);
      const result = extractedResults[0]!;
      expect(result.facts).toHaveLength(2);
      expect(result.facts[0]!.category).toBe('finding');
      expect(result.iterationRange).toEqual([0, 10]);
      expect(result.messagesCount).toBeGreaterThan(0);
    });

    it('should not include future iterations in summary', async () => {
      const snapshot: LLMMessage[] = [];

      for (let i = 1; i <= 15; i++) {
        snapshot.push({
          role: 'user',
          content: `iteration ${i}`,
          iteration: i,
        } as any);
      }

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      const completeCalls = (llm.complete as any).mock.calls;
      expect(completeCalls.length).toBe(1);

      const prompt = completeCalls[0][0];
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

      await summarizer.triggerSummarization(snapshot1, 10);
      await summarizer.triggerSummarization(snapshot2, 20);

      await new Promise((resolve) => { setTimeout(resolve, 200); });

      expect(summarizer.getSummary(0)).toBeTruthy();
      expect(summarizer.getSummary(10)).toBeTruthy();
    });

    it('should not create duplicate summaries', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      await summarizer.triggerSummarization(snapshot, 10);

      await new Promise((resolve) => { setTimeout(resolve, 200); });

      expect((llm.complete as any).mock.calls.length).toBe(1);
    });

    it('should process queue without blocking', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      const startTime = Date.now();
      const promise = summarizer.triggerSummarization(snapshot, 10);
      await promise;
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(50);
    });
  });

  describe('Summary Retrieval', () => {
    it('should retrieve summary by start iteration', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      const summary = summarizer.getSummary(0);
      expect(summary).toBeTruthy();
      // Summary now contains fact categories from extracted facts
      expect(summary).toContain('[finding]');
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
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      expect(summarizer.hasSummary(5)).toBe(true);
      expect(summarizer.hasSummary(9)).toBe(true);
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
      await new Promise((resolve) => { setTimeout(resolve, 200); });

      const all = summarizer.getAllSummaries();
      expect(all.length).toBe(2);
      expect(all[0]!.startIteration).toBe(0);
      expect(all[1]!.startIteration).toBe(10);
    });
  });

  describe('Thread Safety', () => {
    it('should use immutable snapshots', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'original', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      snapshot[0]!.content = 'modified';
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      const summary = summarizer.getSummary(0);
      expect(summary).toBeTruthy();
    });
  });

  describe('Configuration', () => {
    it('should respect custom interval', async () => {
      const customSummarizer = new SmartSummarizer({
        summarizationInterval: 5,
        onFactsExtracted: vi.fn(),
      });
      customSummarizer.setLLM(llm);

      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 3 } as any,
      ];

      await customSummarizer.triggerSummarization(snapshot, 5);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      expect(llm.complete).toHaveBeenCalled();
    });

    it('should provide stats', async () => {
      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await summarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

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
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      summarizer.clearSummaries();

      expect(summarizer.getSummary(0)).toBeNull();
      expect(summarizer.getStats().totalSummaries).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing LLM gracefully', async () => {
      const noLLMSummarizer = new SmartSummarizer({
        onFactsExtracted: vi.fn(),
      });

      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await noLLMSummarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      expect(noLLMSummarizer.getSummary(0)).toBeNull();
    });

    it('should handle invalid JSON from LLM', async () => {
      const badLLM = mockLLM()
        .onAnyComplete()
        .respondWith('This is not JSON at all');

      const badSummarizer = new SmartSummarizer({
        summarizationInterval: 10,
        onFactsExtracted: vi.fn(),
      });
      badSummarizer.setLLM(badLLM);

      const snapshot: LLMMessage[] = [
        { role: 'user', content: 'test', iteration: 5 } as any,
      ];

      await badSummarizer.triggerSummarization(snapshot, 10);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      // Should have summary but with no facts
      const summary = badSummarizer.getSummary(0);
      expect(summary).toContain('No facts extracted');
    });
  });
});
