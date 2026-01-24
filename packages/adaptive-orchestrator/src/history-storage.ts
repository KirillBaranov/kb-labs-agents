/**
 * @module @kb-labs/adaptive-orchestrator/history-storage
 * File-based history storage implementation.
 *
 * Stores execution history in .kb/agents/history/{session_id}/
 */

import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IHistoryStorage, OrchestrationHistory } from "./history-types.js";

/**
 * File-based history storage.
 *
 * Storage structure:
 * ```
 * .kb/agents/history/
 * ├── {session_id_1}/
 * │   ├── session.json       # Full history
 * │   ├── plan.json          # Just the plan (for quick inspection)
 * │   └── result.json        # Just the result
 * ├── {session_id_2}/
 * │   └── ...
 * └── index.json             # List of all sessions (metadata)
 * ```
 */
export class FileHistoryStorage implements IHistoryStorage {
  private historyDir: string;

  constructor(cwd: string, baseDir: string = ".kb/agents") {
    this.historyDir = resolve(cwd, baseDir, "history");
  }

  /**
   * Save orchestration history.
   */
  async save(history: OrchestrationHistory): Promise<void> {
    const sessionDir = join(this.historyDir, history.sessionId);

    // Create directory
    await mkdir(sessionDir, { recursive: true });

    // Save full session
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify(history, null, 2),
      "utf-8",
    );

    // Save plan separately for quick inspection
    await writeFile(
      join(sessionDir, "plan.json"),
      JSON.stringify(history.plan, null, 2),
      "utf-8",
    );

    // Save result separately
    await writeFile(
      join(sessionDir, "result.json"),
      JSON.stringify(history.result, null, 2),
      "utf-8",
    );

    // Update index
    await this.updateIndex(history);
  }

  /**
   * Load orchestration history.
   */
  async load(sessionId: string): Promise<OrchestrationHistory | null> {
    const sessionPath = join(this.historyDir, sessionId, "session.json");

    try {
      const content = await readFile(sessionPath, "utf-8");
      return JSON.parse(content) as OrchestrationHistory;
    } catch {
      // Session not found
      return null;
    }
  }

  /**
   * List all session IDs.
   */
  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.historyDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse(); // Most recent first
    } catch {
      // History directory doesn't exist yet
      return [];
    }
  }

  /**
   * Delete session history.
   */
  async delete(sessionId: string): Promise<void> {
    const sessionDir = join(this.historyDir, sessionId);

    try {
      await rm(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore errors - directory might not exist
    }

    // Update index
    await this.removeFromIndex(sessionId);
  }

  /**
   * Update index.json with session metadata.
   */
  private async updateIndex(history: OrchestrationHistory): Promise<void> {
    const indexPath = join(this.historyDir, "index.json");

    let index: SessionMetadata[] = [];

    try {
      const content = await readFile(indexPath, "utf-8");
      index = JSON.parse(content);
    } catch {
      // Index doesn't exist yet
    }

    // Remove old entry for this session if exists
    index = index.filter((entry) => entry.sessionId !== history.sessionId);

    // Add new entry
    index.push({
      sessionId: history.sessionId,
      task: history.task,
      classifiedTier: history.classifiedTier,
      success: history.success,
      durationMs: history.durationMs,
      timestamp: history.startTime,
      agentsUsed: history.subtaskTraces
        .filter((t) => t.agentId)
        .map((t) => t.agentId!),
    });

    // Sort by timestamp (most recent first)
    index.sort((a, b) => b.timestamp - a.timestamp);

    // Write updated index
    await mkdir(this.historyDir, { recursive: true });
    await writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
  }

  /**
   * Remove session from index.
   */
  private async removeFromIndex(sessionId: string): Promise<void> {
    const indexPath = join(this.historyDir, "index.json");

    try {
      const content = await readFile(indexPath, "utf-8");
      let index: SessionMetadata[] = JSON.parse(content);

      index = index.filter((entry) => entry.sessionId !== sessionId);

      await writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
    } catch {
      // Index doesn't exist or read failed - ignore
    }
  }

  /**
   * Get index (list of all sessions with metadata).
   */
  async getIndex(): Promise<SessionMetadata[]> {
    const indexPath = join(this.historyDir, "index.json");

    try {
      const content = await readFile(indexPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return [];
    }
  }
}

/**
 * Session metadata for index.
 */
interface SessionMetadata {
  sessionId: string;
  task: string;
  classifiedTier: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  agentsUsed: string[];
}
