import { describe, it, expect, beforeEach } from 'vitest';
import { ContextFilter } from '../context-filter';
import type { LLMMessage } from '@kb-labs/sdk';

type Message = LLMMessage;

describe('ContextFilter', () => {
  let filter: ContextFilter;

  beforeEach(() => {
    filter = new ContextFilter({
      maxOutputLength: 500,
      slidingWindowSize: 5,
      enableDeduplication: true,
    });
  });

  describe('Output Truncation (Tier 1)', () => {
    it('should not truncate short tool outputs', () => {
      const msg: Message = {
        role: 'tool',
        content: 'Short output',
      };

      const result = filter.truncateMessage(msg);

      expect(result.content).toBe('Short output');
      expect(result.metadata?.truncated).toBeUndefined();
    });

    it('should truncate long tool outputs to 500 chars', () => {
      const longContent = 'x'.repeat(10000);
      const msg: Message = {
        role: 'tool',
        content: longContent,
      };

      const result = filter.truncateMessage(msg);

      expect(result.content?.length).toBeLessThan(600); // 500 + suffix
      expect(result.content).toContain('9500 more characters truncated');
      expect(result.content).toContain('use context_retrieve');
      expect(result.metadata?.truncated).toBe(true);
      expect(result.metadata?.originalLength).toBe(10000);
    });

    it('should not truncate non-tool messages', () => {
      const msg: Message = {
        role: 'assistant',
        content: 'x'.repeat(10000),
      };

      const result = filter.truncateMessage(msg);

      expect(result.content?.length).toBe(10000);
      expect(result.metadata?.truncated).toBeUndefined();
    });
  });

  describe('Tool Call Deduplication (Tier 1)', () => {
    it('should detect duplicate tool calls', () => {
      const args = { file: 'package.json' };

      filter.markToolCallSeen('fs:read', args, 1, 'file contents');

      expect(filter.isDuplicateToolCall('fs:read', args)).toBe(true);
    });

    it('should not detect different args as duplicate', () => {
      const args1 = { file: 'package.json' };
      const args2 = { file: 'tsconfig.json' };

      filter.markToolCallSeen('fs:read', args1, 1, 'contents1');

      expect(filter.isDuplicateToolCall('fs:read', args2)).toBe(false);
    });

    it('should retrieve cached result for duplicate', () => {
      const args = { file: 'package.json' };
      const cachedResult = { name: 'test', version: '1.0.0' };

      filter.markToolCallSeen('fs:read', args, 3, cachedResult);

      const result = filter.getDuplicateResult('fs:read', args);

      expect(result).toEqual({
        iteration: 3,
        result: cachedResult,
      });
    });

    it('should format duplicate response message', () => {
      const msg = filter.formatDuplicateResponse('fs:read', 3, 'file contents here');

      expect(msg).toContain('iteration 3');
      expect(msg).toContain('fs:read');
      expect(msg).toContain('file contents here');
      expect(msg).toContain('context_retrieve');
    });

    it('should track deduplication stats', () => {
      filter.markToolCallSeen('fs:read', { file: 'a.txt' }, 1, 'a');
      filter.markToolCallSeen('fs:read', { file: 'b.txt' }, 2, 'b');
      filter.markToolCallSeen('mind:rag-query', { text: 'test' }, 3, 'result');

      const stats = filter.getDedupStats();

      expect(stats.totalTools).toBe(2);
      expect(stats.totalCachedCalls).toBe(3);
      expect(stats.cacheByTool['fs:read']).toBe(2);
      expect(stats.cacheByTool['mind:rag-query']).toBe(1);
    });

    it('should clear deduplication cache', () => {
      filter.markToolCallSeen('fs:read', { file: 'test.txt' }, 1, 'data');

      filter.clearDedupCache();

      expect(filter.isDuplicateToolCall('fs:read', { file: 'test.txt' })).toBe(false);
      expect(filter.getDedupStats().totalCachedCalls).toBe(0);
    });
  });

  describe('Sliding Window', () => {
    it('should return last N iterations in context', async () => {
      // Add 10 messages to history
      for (let i = 1; i <= 10; i++) {
        await filter.appendToHistory([
          { role: 'user', content: `message ${i}` },
        ]);
      }

      const systemMsg: Message = { role: 'system', content: 'system' };
      const taskMsg: Message = { role: 'user', content: 'task' };

      const context = filter.buildDefaultContext(systemMsg, taskMsg, 10);

      // Should have: system + task + last 5 messages = 7 total
      expect(context.length).toBe(7);
      expect(context[0]).toEqual(systemMsg);
      expect(context[1]).toEqual(taskMsg);
      expect(context[2]!.content).toBe('message 6');
      expect(context[6]!.content).toBe('message 10');
    });

    it('should include summaries if provided', async () => {
      await filter.appendToHistory([
        { role: 'user', content: 'msg1' },
      ]);

      const systemMsg: Message = { role: 'system', content: 'system' };
      const taskMsg: Message = { role: 'user', content: 'task' };
      const summaries = ['Summary 1-10', 'Summary 11-20'];

      const context = filter.buildDefaultContext(systemMsg, taskMsg, 1, summaries);

      expect(context.length).toBe(4); // system + task + summary + msg1
      expect(context[2]!.role).toBe('system');
      expect(context[2]!.content).toContain('Summary 1-10');
      expect(context[2]!.content).toContain('Summary 11-20');
    });
  });

  describe('Thread Safety', () => {
    it('should return immutable snapshot', async () => {
      await filter.appendToHistory([
        { role: 'user', content: 'original' },
      ]);

      const snapshot = filter.getHistorySnapshot();
      const original = filter.getFullHistory();

      // Snapshot should be frozen (Object.freeze)
      expect(Object.isFrozen(snapshot[0])).toBe(true);

      // Try to mutate snapshot - should throw or silently fail
      expect(() => {
        (snapshot[0] as any).content = 'modified';
      }).toThrow();

      // Original should be unchanged
      expect(original[0]!.content).toBe('original');
    });

    it('should handle concurrent appends', async () => {
      const promises = [];

      // 50 concurrent appends
      for (let i = 0; i < 50; i++) {
        promises.push(
          filter.appendToHistory([{ role: 'user', content: `msg${i}` }])
        );
      }

      await Promise.all(promises);

      const history = filter.getFullHistory();
      expect(history.length).toBe(50);
    });

    it('should provide atomic append', async () => {
      // Append multiple messages atomically
      await filter.appendToHistory([
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'resp1' },
        { role: 'tool', content: 'tool1' },
      ]);

      const history = filter.getFullHistory();
      expect(history.length).toBe(3);
      expect(history[0]!.content).toBe('msg1');
      expect(history[1]!.content).toBe('resp1');
      expect(history[2]!.content).toBe('tool1');
    });
  });

  describe('Configuration', () => {
    it('should respect custom maxOutputLength', () => {
      const customFilter = new ContextFilter({ maxOutputLength: 100 });

      const msg: Message = {
        role: 'tool',
        content: 'x'.repeat(1000),
      };

      const result = customFilter.truncateMessage(msg);

      // 100 chars + suffix (approximately 80 chars) = ~180 total
      expect(result.content?.length).toBeLessThan(200);
      expect(result.content?.slice(0, 100)).toBe('x'.repeat(100));
      expect(result.content).toContain('900 more characters');
    });

    it('should respect custom slidingWindowSize', async () => {
      const customFilter = new ContextFilter({ slidingWindowSize: 3 });

      for (let i = 1; i <= 10; i++) {
        await customFilter.appendToHistory([
          { role: 'user', content: `msg${i}` },
        ]);
      }

      const systemMsg: Message = { role: 'system', content: 'system' };
      const taskMsg: Message = { role: 'user', content: 'task' };

      const context = customFilter.buildDefaultContext(systemMsg, taskMsg, 10);

      // Should have: system + task + last 3 messages = 5 total
      expect(context.length).toBe(5);
      expect(context[2]!.content).toBe('msg8');
      expect(context[4]!.content).toBe('msg10');
    });

    it('should respect enableDeduplication flag', () => {
      const noDedupFilter = new ContextFilter({ enableDeduplication: false });

      const args = { file: 'test.txt' };
      noDedupFilter.markToolCallSeen('fs:read', args, 1, 'data');

      expect(noDedupFilter.isDuplicateToolCall('fs:read', args)).toBe(false);
    });
  });
});
