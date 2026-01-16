/**
 * Context Compressor
 *
 * Prevents context window explosion by summarizing message history.
 *
 * Problem: Each step adds messages to context (LLM response + tool results).
 * After reading large files, context grows exponentially:
 * - Step 1: 1.5K tokens
 * - Step 2: 1.7K tokens
 * - Step 3: 27K tokens (after fs:read)
 * - Step 4: 28K tokens
 * - Step 7: 148K tokens total
 *
 * Solution: Periodically compress message history into a summary.
 */

import { useLLM } from '@kb-labs/sdk';
import type { PluginContextV3 } from '@kb-labs/sdk';

/**
 * Message format for LLM conversation
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

/**
 * Compression result
 */
export interface CompressionResult {
  compressedMessages: Message[];
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
}

/**
 * Context Compressor
 *
 * Summarizes conversation history to keep context window manageable.
 */
export class ContextCompressor {
  private readonly COMPRESSION_THRESHOLD = 5; // Compress after 5 messages
  private readonly MAX_SUMMARY_TOKENS = 1500; // Target summary length

  constructor(private ctx: PluginContextV3) {}

  /**
   * Check if messages should be compressed
   */
  shouldCompress(messages: Message[]): boolean {
    // Don't compress if we have few messages
    if (messages.length < this.COMPRESSION_THRESHOLD) {
      return false;
    }

    // Always keep system message if present
    const hasSystemMessage = messages[0]?.role === 'system';
    const conversationMessages = hasSystemMessage ? messages.slice(1) : messages;

    return conversationMessages.length >= this.COMPRESSION_THRESHOLD;
  }

  /**
   * Compress message history by summarizing it
   *
   * @param messages - Full message history
   * @param systemPrompt - System prompt to preserve
   * @param originalTask - Original user task to preserve
   * @returns Compressed messages
   */
  async compress(
    messages: Message[],
    systemPrompt: string,
    originalTask: string
  ): Promise<CompressionResult> {
    const llm = useLLM();
    if (!llm) {
      // Can't compress without LLM - return as-is
      return {
        compressedMessages: messages,
        originalTokens: this.estimateTokens(messages),
        compressedTokens: this.estimateTokens(messages),
        compressionRatio: 1.0,
      };
    }

    this.ctx.platform.logger.info('Compressing context', {
      messageCount: messages.length,
      estimatedTokens: this.estimateTokens(messages),
    });

    // Build compression prompt
    const historyText = this.messagesToText(messages);

    const compressionPrompt = `You are a context compression assistant. Your job is to summarize conversation history while preserving critical information.

ORIGINAL TASK:
${originalTask}

CONVERSATION HISTORY:
${historyText}

Create a concise summary (max ${this.MAX_SUMMARY_TOKENS} tokens) that includes:
1. **What was learned** - Key facts discovered through tool calls
2. **Tools used** - Which tools were called and why
3. **Current progress** - What's been accomplished
4. **Next steps** - What needs to be done next

Format as a brief numbered list. Be specific but concise.

SUMMARY:`;

    try {
      // Call LLM to generate summary
      const response = await llm.complete(compressionPrompt, {
        temperature: 0.1,
        maxTokens: this.MAX_SUMMARY_TOKENS,
      });

      const summary = response.content;

      // Build compressed message history
      const compressedMessages: Message[] = [
        { role: 'user', content: `CONTEXT SUMMARY:\n${summary}\n\nORIGINAL TASK: ${originalTask}` },
      ];

      const originalTokens = this.estimateTokens(messages);
      const compressedTokens = this.estimateTokens(compressedMessages);
      const compressionRatio = compressedTokens / originalTokens;

      this.ctx.platform.logger.info('Context compressed', {
        originalMessages: messages.length,
        compressedMessages: compressedMessages.length,
        originalTokens,
        compressedTokens,
        compressionRatio: `${(compressionRatio * 100).toFixed(1)}%`,
        tokensSaved: originalTokens - compressedTokens,
      });

      return {
        compressedMessages,
        originalTokens,
        compressedTokens,
        compressionRatio,
      };
    } catch (error) {
      this.ctx.platform.logger.error(
        'Context compression failed',
        error instanceof Error ? error : undefined
      );

      // Fallback: return original messages
      return {
        compressedMessages: messages,
        originalTokens: this.estimateTokens(messages),
        compressedTokens: this.estimateTokens(messages),
        compressionRatio: 1.0,
      };
    }
  }

  /**
   * Convert messages to readable text format
   */
  private messagesToText(messages: Message[]): string {
    return messages
      .map((msg, index) => {
        const role = msg.role.toUpperCase();

        // Truncate very long messages (e.g., file contents)
        let content = msg.content;
        if (content.length > 1000) {
          content = content.slice(0, 1000) + '\n...[truncated]...';
        }

        return `[${index + 1}] ${role}:\n${content}`;
      })
      .join('\n\n');
  }

  /**
   * Estimate token count for messages
   *
   * Uses simple heuristic: ~4 characters per token
   */
  private estimateTokens(messages: Message[]): number {
    const totalChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    return Math.ceil(totalChars / 4);
  }

  /**
   * Truncate tool results in messages to prevent explosion
   *
   * Use this as an alternative/complement to full compression
   */
  truncateToolResults(messages: Message[], maxLength: number = 500): Message[] {
    return messages.map((msg) => {
      if (msg.role === 'tool' && msg.content.length > maxLength) {
        return {
          ...msg,
          content: msg.content.slice(0, maxLength) + '\n...[truncated to save tokens]...',
        };
      }
      return msg;
    });
  }
}
