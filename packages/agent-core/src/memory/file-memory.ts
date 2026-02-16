/**
 * File-based memory implementation using platform cache + file persistence
 *
 * ARCHITECTURE:
 * - Session memory (.kb/memory/session-xxx/) - corrections, findings, blockers
 * - Shared memory (.kb/memory/shared/) - preferences, constraints (read-only here)
 *
 * This class manages session memory and reads shared memory for context.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { useCache, useLLM } from '@kb-labs/sdk';
import type {
  AgentMemory,
  MemoryEntry,
  MemorySummary,
  MemoryConfig,
} from '@kb-labs/agent-contracts';

/**
 * Shared memory structure (read from .kb/memory/shared/)
 */
interface SharedMemory {
  preferences: MemoryEntry[];
  constraints: MemoryEntry[];
}

/**
 * File-based memory implementation
 *
 * Architecture:
 * - Short-term: Stored in cache (fast access)
 * - Long-term: Persisted to .kb/memory/ directory
 * - Summaries: Generated via LLM when context overflows
 */
export class FileMemory implements AgentMemory {
  private sessionId: string;
  private maxShortTermMemories: number;
  private maxContextTokens: number;
  private keyPrefix: string;
  private ttl?: number;
  private workingDir: string;
  private maxSessionDirs: number;

  constructor(config: MemoryConfig & { workingDir: string; maxSessionDirs?: number }) {
    this.sessionId = config.sessionId || `session-${Date.now()}`;
    this.maxShortTermMemories = config.maxShortTermMemories || 50;
    this.maxContextTokens = config.maxContextTokens || 8000;
    this.keyPrefix = config.keyPrefix || 'agent:memory';
    this.ttl = config.ttl;
    this.workingDir = config.workingDir;
    this.maxSessionDirs = config.maxSessionDirs || 20; // Keep last 20 sessions by default

    // Cleanup old sessions in background (don't await)
    this.cleanupOldSessions().catch((error) => {
      console.error('[FileMemory] Cleanup failed:', error);
    });
  }

  /**
   * Add a new memory entry
   */
  async add(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<MemoryEntry> {
    try {
      const cache = useCache();

      const memoryId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const memoryEntry: MemoryEntry = {
        id: memoryId,
        timestamp: new Date().toISOString(),
        ...entry,
        metadata: {
          ...entry.metadata,
          sessionId: entry.metadata?.sessionId || this.sessionId,
        },
      };

      // Store in cache for fast access
      if (cache) {
        const key = this.getMemoryKey(memoryId);
        await cache.set(key, memoryEntry, this.ttl);

        // Add to sorted set (for time-ordered retrieval)
        const indexKey = this.getIndexKey();
        const score = new Date(memoryEntry.timestamp).getTime();
        await cache.zadd(indexKey, score, memoryId);
      }

      // Persist to file
      await this.persistToFile(memoryEntry);

      // Check if we need to summarize
      const stats = await this.getStats();
      if (stats.totalMemories > this.maxShortTermMemories) {
        await this.summarize();
      }

      return memoryEntry;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get recent memories (short-term memory)
   */
  async getRecent(limit = 20): Promise<MemoryEntry[]> {
    const cache = useCache();
    if (!cache) {
      return this.loadFromFile(limit);
    }

    const indexKey = this.getIndexKey();
    const now = Date.now();
    const oneHourAgo = now - 3600000; // 1 hour

    // Get recent memory IDs from sorted set
    const memoryIds = await cache.zrangebyscore(indexKey, oneHourAgo, now);

    // Get actual memories
    const memories: MemoryEntry[] = [];
    for (const id of memoryIds.slice(-limit)) {
      const key = this.getMemoryKey(id);
       
      const memory = await cache.get<MemoryEntry>(key);
      if (memory) {
        memories.push(memory);
      }
    }

    return memories.reverse(); // Most recent first
  }

  /**
   * Search memories by query (simple text search for now)
   */
  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    const allMemories = await this.getRecent(100);
    const lowerQuery = query.toLowerCase();

    return allMemories
      .filter(
        (m) =>
          m.content.toLowerCase().includes(lowerQuery) ||
          m.metadata?.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery))
      )
      .slice(0, limit);
  }

  /**
   * Get memories by session ID
   */
  async getBySession(sessionId: string): Promise<MemoryEntry[]> {
    const allMemories = await this.getRecent(1000);
    return allMemories.filter((m) => m.metadata?.sessionId === sessionId);
  }

  /**
   * Get memories by task ID
   */
  async getByTask(taskId: string): Promise<MemoryEntry[]> {
    const allMemories = await this.getRecent(1000);
    return allMemories.filter((m) => m.metadata?.taskId === taskId);
  }

  /**
   * Get current context for LLM prompt
   */
  async getContext(maxTokens = this.maxContextTokens): Promise<string> {
    const memories = await this.getRecent(50);
    const summaries = await this.loadSummaries();

    let context = '';
    let estimatedTokens = 0;

    // Add summaries first (more condensed information)
    if (summaries.length > 0) {
      context += '# Previous Context (Summarized)\n\n';
      for (const summary of summaries) {
        const summaryText = `[${summary.timeRange.start} - ${summary.timeRange.end}]\n${summary.content}\n\n`;
        const tokens = this.estimateTokens(summaryText);
        if (estimatedTokens + tokens > maxTokens) {
          break;
        }
        context += summaryText;
        estimatedTokens += tokens;
      }
    }

    // Add recent memories
    context += '# Recent Context\n\n';
    for (const memory of memories) {
      const memoryText = this.formatMemory(memory);
      const tokens = this.estimateTokens(memoryText);
      if (estimatedTokens + tokens > maxTokens) {
        break;
      }
      context += memoryText;
      estimatedTokens += tokens;
    }

    return context;
  }

  /**
   * Summarize old memories using LLM
   */
  async summarize(): Promise<MemorySummary> {
    const memories = await this.getRecent(this.maxShortTermMemories);

    // Get oldest memories to summarize (first half)
    const toSummarize = memories.slice(0, Math.floor(memories.length / 2));
    if (toSummarize.length === 0) {
      throw new Error('No memories to summarize');
    }

    const llm = useLLM({ tier: 'small' });
    if (!llm) {
      throw new Error('LLM not available for summarization');
    }

    // Format memories for summarization
    const memoriesText = toSummarize.map((m) => this.formatMemory(m)).join('\n');

    const prompt = `Summarize the following agent memories into a concise overview:

${memoriesText}

Provide a summary that captures:
1. Key tasks that were executed
2. Important observations or findings
3. Significant actions taken
4. Overall progress or outcomes

Keep the summary under 500 words.`;

    const response = await llm.complete(prompt, { temperature: 0 });

    const summary: MemorySummary = {
      id: `summary-${Date.now()}`,
      timestamp: new Date().toISOString(),
      memoryCount: toSummarize.length,
      timeRange: {
        start: toSummarize[0]!.timestamp,
        end: toSummarize[toSummarize.length - 1]!.timestamp,
      },
      content: response.content || 'Summary generation failed',
      originalMemoryIds: toSummarize.map((m) => m.id!).filter(Boolean),
    };

    // Persist summary
    await this.persistSummary(summary);

    // Remove summarized memories from cache (but keep in files)
    const cache = useCache();
    if (cache) {
      for (const memory of toSummarize) {
        if (memory.id) {
           
          await cache.delete(this.getMemoryKey(memory.id));
        }
      }
    }

    return summary;
  }

  /**
   * Clear all memories
   */
  async clear(): Promise<void> {
    const cache = useCache();
    if (cache) {
      await cache.clear(`${this.keyPrefix}:${this.sessionId}:*`);
      await cache.clear(`${this.keyPrefix}:index:${this.sessionId}`);
    }
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    totalMemories: number;
    totalSummaries: number;
    oldestMemory: string | null;
    newestMemory: string | null;
    estimatedTokens: number;
  }> {
    const memories = await this.getRecent(1000);
    const summaries = await this.loadSummaries();

    const context = await this.getContext();
    const estimatedTokens = this.estimateTokens(context);

    return {
      totalMemories: memories.length,
      totalSummaries: summaries.length,
      oldestMemory: memories.length > 0 ? memories[memories.length - 1]!.timestamp : null,
      newestMemory: memories.length > 0 ? memories[0]!.timestamp : null,
      estimatedTokens,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Shared Memory (read-only) - preferences & constraints from .kb/memory/shared/
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Load shared memory (preferences, constraints) from .kb/memory/shared/
   * This is read-only - use tools to write to shared memory
   */
  private async loadSharedMemory(): Promise<SharedMemory> {
    const sharedPath = path.join(this.workingDir, '.kb', 'memory', 'shared', 'memory.json');

    try {
      const content = await fs.readFile(sharedPath, 'utf-8');
      const parsed = JSON.parse(content);

      return {
        preferences: parsed.preferences || [],
        constraints: parsed.constraints || [],
      };
    } catch {
      return { preferences: [], constraints: [] };
    }
  }

  /**
   * Get shared preferences (from .kb/memory/shared/)
   */
  async getSharedPreferences(): Promise<MemoryEntry[]> {
    const shared = await this.loadSharedMemory();
    return shared.preferences;
  }

  /**
   * Get shared constraints (from .kb/memory/shared/)
   */
  async getSharedConstraints(): Promise<MemoryEntry[]> {
    const shared = await this.loadSharedMemory();
    return shared.constraints;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Session Memory - corrections, findings, blockers (session-scoped)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add a user correction to session memory
   * Use when user corrects agent's understanding (e.g., "No, AuthService is in packages/auth/")
   */
  async addUserCorrection(content: string, supersedes?: string): Promise<MemoryEntry> {
    return this.add({
      content,
      type: 'user_correction',
      category: 'user_input',
      metadata: {
        source: 'user',
        importance: 1.0, // User corrections are always high priority
        supersedes,
        scope: 'session',
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Agent Section - Structured memory for agent findings & state
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add a finding to memory
   * Use when agent discovers something important with confidence level
   */
  async addFinding(content: string, confidence: number, sources: string[]): Promise<MemoryEntry> {
    return this.add({
      content,
      type: 'finding',
      category: 'learning',
      metadata: {
        source: 'agent',
        confidence,
        tags: sources,
        importance: confidence,
      },
    });
  }

  /**
   * Add a blocker to memory
   * Use when agent cannot proceed without additional information
   */
  async addBlocker(content: string, taskId?: string): Promise<MemoryEntry> {
    return this.add({
      content,
      type: 'blocker',
      category: 'agent_state',
      metadata: {
        source: 'agent',
        taskId,
        importance: 1.0,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Query Section - Retrieve structured memory entries
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get all user corrections from memory
   */
  async getUserCorrections(): Promise<MemoryEntry[]> {
    const all = await this.getRecent(100);
    return all.filter((m) => m.type === 'user_correction');
  }

  /**
   * Get all current blockers from session memory
   */
  async getBlockers(): Promise<MemoryEntry[]> {
    const all = await this.getRecent(50);
    return all.filter((m) => m.type === 'blocker');
  }

  /**
   * Resolve a blocker (mark as resolved by removing from active blockers)
   */
  async resolveBlocker(content: string): Promise<MemoryEntry> {
    return this.add({
      content: `[RESOLVED] ${content}`,
      type: 'result',
      category: 'agent_state',
      metadata: {
        source: 'agent',
        importance: 0.5,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Enhanced Context - Merges shared + session memory for LLM prompts
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get structured context combining shared and session memory
   *
   * Priority order:
   * 1. User corrections (session) - highest priority
   * 2. Last answer (session) - FULL previous answer, never summarized
   * 3. Constraints (shared) - project rules
   * 4. Preferences (shared) - user preferences
   * 5. Blockers (session) - current blockers
   * 6. Recent activity (session) - recent observations/findings
   */
  async getStructuredContext(maxTokens?: number): Promise<string> {
    // Session memory
    const corrections = await this.getUserCorrections();
    const blockers = await this.getBlockers();
    const recent = await this.getRecent(20);
    const lastAnswer = await this.getLastAnswer();

    // Shared memory (preferences, constraints)
    const sharedPreferences = await this.getSharedPreferences();
    const sharedConstraints = await this.getSharedConstraints();

    let context = '';
    let estimatedTokens = 0;
    const tokenLimit = maxTokens || this.maxContextTokens;

    // User corrections first (session - highest priority)
    if (corrections.length > 0) {
      const section = this.formatSection(
        '⚠️ User Corrections (SESSION - IMPORTANT!)',
        corrections.map((c) => `- ${c.content}`)
      );
      const tokens = this.estimateTokens(section);
      if (estimatedTokens + tokens <= tokenLimit) {
        context += section;
        estimatedTokens += tokens;
      }
    }

    // Last answer - ALWAYS include in FULL (never summarized)
    if (lastAnswer) {
      const timeAgo = this.formatTimeAgo(lastAnswer.timestamp);
      const metaInfo: string[] = [];
      if (lastAnswer.metadata?.confidence) {
        metaInfo.push(`confidence: ${(lastAnswer.metadata.confidence * 100).toFixed(0)}%`);
      }
      if (lastAnswer.metadata?.filesCreated?.length) {
        metaInfo.push(`files created: ${lastAnswer.metadata.filesCreated.join(', ')}`);
      }
      if (lastAnswer.metadata?.filesModified?.length) {
        metaInfo.push(`files modified: ${lastAnswer.metadata.filesModified.join(', ')}`);
      }

      const section = `# 📝 Previous Answer (${timeAgo})

**Original question:** ${lastAnswer.task}
${metaInfo.length > 0 ? `**Metadata:** ${metaInfo.join(' | ')}\n` : ''}
**Full answer:**
${lastAnswer.answer}

`;
      // Note: We always include the last answer even if it exceeds token limit
      // because it's critical for follow-up questions
      context += section;
      estimatedTokens += this.estimateTokens(section);
    }

    // Constraints (shared - persistent)
    if (sharedConstraints.length > 0) {
      const section = this.formatSection(
        '🚫 Constraints (SHARED)',
        sharedConstraints.map((c) => `- ${c.content}`)
      );
      const tokens = this.estimateTokens(section);
      if (estimatedTokens + tokens <= tokenLimit) {
        context += section;
        estimatedTokens += tokens;
      }
    }

    // User preferences (shared - persistent)
    if (sharedPreferences.length > 0) {
      const section = this.formatSection(
        '👤 User Preferences (SHARED)',
        sharedPreferences.map((p) => `- ${p.content}`)
      );
      const tokens = this.estimateTokens(section);
      if (estimatedTokens + tokens <= tokenLimit) {
        context += section;
        estimatedTokens += tokens;
      }
    }

    // Current blockers (session)
    if (blockers.length > 0) {
      const section = this.formatSection(
        '🛑 Current Blockers (SESSION)',
        blockers.map((b) => `- ${b.content}`)
      );
      const tokens = this.estimateTokens(section);
      if (estimatedTokens + tokens <= tokenLimit) {
        context += section;
        estimatedTokens += tokens;
      }
    }

    // Recent activity (session - filter out already shown items)
    const shownTypes = new Set(['user_correction', 'blocker']);
    const recentFiltered = recent.filter((m) => !shownTypes.has(m.type || ''));

    if (recentFiltered.length > 0) {
      const recentLines = recentFiltered.slice(0, 10).map((m) => {
        const type = m.type?.toUpperCase() || 'MEMORY';
        return `[${type}] ${m.content}`;
      });
      const section = this.formatSection('Recent Activity (SESSION)', recentLines);
      const tokens = this.estimateTokens(section);
      if (estimatedTokens + tokens <= tokenLimit) {
        context += section;
      }
    }

    return context || '# No context available\n';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Last Answer Memory (NEVER summarized - always full)
  // ═══════════════════════════════════════════════════════════════════════

  /** In-memory cache of last answer for fast access */
  private lastAnswerCache: {
    answer: string;
    task: string;
    timestamp: string;
    metadata?: {
      confidence?: number;
      completeness?: number;
      sources?: string[];
      filesCreated?: string[];
      filesModified?: string[];
    };
  } | null = null;

  /**
   * Save the orchestrator's last answer (NEVER summarized)
   * Stored separately in last-answer.json - always available in full
   */
  async saveLastAnswer(
    answer: string,
    task: string,
    metadata?: {
      confidence?: number;
      completeness?: number;
      sources?: string[];
      filesCreated?: string[];
      filesModified?: string[];
    }
  ): Promise<void> {
    const lastAnswer = {
      answer,
      task,
      timestamp: new Date().toISOString(),
      metadata,
    };

    // Save to memory cache
    this.lastAnswerCache = lastAnswer;

    // Persist to dedicated file (NOT in regular memory files)
    try {
      const memoryDir = path.join(this.workingDir, '.kb', 'memory', this.sessionId);
      await fs.mkdir(memoryDir, { recursive: true });

      const filePath = path.join(memoryDir, 'last-answer.json');
      await fs.writeFile(filePath, JSON.stringify(lastAnswer, null, 2), 'utf-8');
    } catch (error) {
      // Don't throw - allow agent to continue
      console.error('[FileMemory] Failed to persist last answer:', error);
    }
  }

  /**
   * Get the last orchestrator answer (full, unsummarized)
   */
  async getLastAnswer(): Promise<{
    answer: string;
    task: string;
    timestamp: string;
    metadata?: {
      confidence?: number;
      completeness?: number;
      sources?: string[];
      filesCreated?: string[];
      filesModified?: string[];
    };
  } | null> {
    // Check memory cache first
    if (this.lastAnswerCache) {
      return this.lastAnswerCache;
    }

    // Load from file
    try {
      const filePath = path.join(this.workingDir, '.kb', 'memory', this.sessionId, 'last-answer.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const lastAnswer = JSON.parse(content);
      this.lastAnswerCache = lastAnswer;
      return lastAnswer;
    } catch {
      return null;
    }
  }

  /**
   * Clear the last answer
   */
  async clearLastAnswer(): Promise<void> {
    this.lastAnswerCache = null;

    try {
      const filePath = path.join(this.workingDir, '.kb', 'memory', this.sessionId, 'last-answer.json');
      await fs.unlink(filePath);
    } catch {
      // File might not exist, that's OK
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Format a section with header and items
   */
  private formatSection(header: string, items: string[]): string {
    return `# ${header}\n\n${items.join('\n')}\n\n`;
  }

  private getMemoryKey(memoryId: string): string {
    return `${this.keyPrefix}:${this.sessionId}:memory:${memoryId}`;
  }

  private getIndexKey(): string {
    return `${this.keyPrefix}:index:${this.sessionId}`;
  }

  private formatMemory(memory: MemoryEntry): string {
    const time = new Date(memory.timestamp).toLocaleTimeString();
    const type = memory.type || 'MEMORY';
    return `[${time}] ${type.toUpperCase()}: ${memory.content}\n`;
  }

  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Format timestamp as human-readable "time ago" string
   */
  private formatTimeAgo(timestamp: string): string {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {return `${days} day${days > 1 ? 's' : ''} ago`;}
    if (hours > 0) {return `${hours} hour${hours > 1 ? 's' : ''} ago`;}
    if (minutes > 0) {return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;}
    return 'just now';
  }

  private async persistToFile(memory: MemoryEntry): Promise<void> {
    try {
      const memoryDir = path.join(this.workingDir, '.kb', 'memory', this.sessionId);
      await fs.mkdir(memoryDir, { recursive: true });

      const fileName = `${memory.id}.json`;
      const filePath = path.join(memoryDir, fileName);

      await fs.writeFile(filePath, JSON.stringify(memory, null, 2), 'utf-8');
    } catch {
      // Don't throw - allow agent to continue even if memory persistence fails
    }
  }

  private async persistSummary(summary: MemorySummary): Promise<void> {
    const memoryDir = path.join(this.workingDir, '.kb', 'memory', this.sessionId);
    await fs.mkdir(memoryDir, { recursive: true });

    const fileName = `summary-${summary.id}.json`;
    const filePath = path.join(memoryDir, fileName);

    await fs.writeFile(filePath, JSON.stringify(summary, null, 2), 'utf-8');
  }

  private async loadFromFile(limit: number): Promise<MemoryEntry[]> {
    const memoryDir = path.join(this.workingDir, '.kb', 'memory', this.sessionId);

    try {
      const files = await fs.readdir(memoryDir);
      const memoryFiles = files
        .filter((f) => f.startsWith('mem-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit);

      const memories: MemoryEntry[] = [];
      for (const file of memoryFiles) {
         
        const content = await fs.readFile(path.join(memoryDir, file), 'utf-8');
        memories.push(JSON.parse(content));
      }

      return memories;
    } catch {
      return [];
    }
  }

  private async loadSummaries(): Promise<MemorySummary[]> {
    const memoryDir = path.join(this.workingDir, '.kb', 'memory', this.sessionId);

    try {
      const files = await fs.readdir(memoryDir);
      const summaryFiles = files
        .filter((f) => f.startsWith('summary-') && f.endsWith('.json'))
        .sort()
        .reverse();

      const summaries: MemorySummary[] = [];
      for (const file of summaryFiles) {
         
        const content = await fs.readFile(path.join(memoryDir, file), 'utf-8');
        summaries.push(JSON.parse(content));
      }

      return summaries;
    } catch {
      return [];
    }
  }

  /**
   * Cleanup old session directories, keeping only the most recent N
   */
  private async cleanupOldSessions(): Promise<void> {
    try {
      const memoryRoot = path.join(this.workingDir, '.kb', 'memory');

      // Check if memory directory exists
      try {
        await fs.access(memoryRoot);
      } catch {
        // Directory doesn't exist yet, nothing to cleanup
        return;
      }

      // Read all session directories
      const entries = await fs.readdir(memoryRoot, { withFileTypes: true });
      const sessionDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(memoryRoot, e.name));

      // If we're under the limit, nothing to do
      if (sessionDirs.length <= this.maxSessionDirs) {
        return;
      }

      // Get directory stats and sort by modification time (newest first)
      const dirsWithStats = await Promise.all(
        sessionDirs.map(async (dir) => ({
          path: dir,
          mtime: (await fs.stat(dir)).mtime,
        }))
      );

      dirsWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Delete old directories (keep only maxSessionDirs newest)
      const dirsToDelete = dirsWithStats.slice(this.maxSessionDirs);

      // Delete directories in parallel for better performance
      await Promise.allSettled(
        dirsToDelete.map((dir) => fs.rm(dir.path, { recursive: true, force: true }))
      );

      if (dirsToDelete.length > 0) {
        console.log(
          `[FileMemory] Cleaned up ${dirsToDelete.length} old session(s), kept ${this.maxSessionDirs} most recent`
        );
      }
    } catch (error) {
      // Don't throw - cleanup is best-effort
      console.error('[FileMemory] Session cleanup failed:', error);
    }
  }
}
