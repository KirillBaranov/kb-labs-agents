import type { AgentSession } from '@kb-labs/agent-contracts';

export interface MemoryEntry {
  id: string;
  sessionId: string;
  content: string;
  embedding?: number[];
  createdAt: Date;
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
}

export class MemoryStore {
  private entries: Map<string, MemoryEntry> = new Map();

  constructor() {
    // Initialize empty store
  }

  async store(session: AgentSession, content: string): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      content: content,
      createdAt: new Date(),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  async search(query: string, options: SearchOptions = {}): Promise<MemoryEntry[]> {
    return Array.from(this.entries.values()).slice(0, options.limit ?? 10);
  }
}
