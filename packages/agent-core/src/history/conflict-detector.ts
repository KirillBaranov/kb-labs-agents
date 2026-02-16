/**
 * Conflict Detector - detects file conflicts BEFORE write operations
 */

import type { FileChangeTracker } from './file-change-tracker.js';

/**
 * Conflict type classification
 */
export type ConflictType = 'none' | 'disjoint' | 'overlapping' | 'conflicting-intent' | 'semantic';

/**
 * Detected conflict information
 */
export interface DetectedConflict {
  /** Type of conflict */
  type: ConflictType;
  /** File path */
  filePath: string;
  /** Agent attempting the write */
  currentAgentId: string;
  /** Other agents who modified this file */
  conflictingAgents: string[];
  /** Description of the conflict */
  description: string;
  /** Confidence in conflict resolution (0-1, higher = easier to auto-resolve) */
  resolutionConfidence: number;
  /** Metadata specific to conflict type */
  metadata?: {
    // For overlapping conflicts
    overlapLines?: number[];

    // For conflicting-intent conflicts
    intentA?: string;
    intentB?: string;

    // For semantic conflicts
    semanticIssue?: string;
  };
}

/**
 * Conflict Detector
 *
 * Detects conflicts BEFORE file write operations by analyzing:
 * - Pending changes from other agents
 * - Line-level overlaps for patches
 * - Intent conflicts (e.g., one agent deletes, another modifies)
 */
export class ConflictDetector {
  constructor(private tracker: FileChangeTracker) {}

  /**
   * Detect conflicts before a write operation
   *
   * @param filePath - File being written
   * @param agentId - Agent attempting the write
   * @param operation - Operation type ('write' | 'patch' | 'delete')
   * @param metadata - Operation metadata (e.g., startLine, endLine for patches)
   * @returns Detected conflict or null if no conflict
   */
  async detectConflict(
    filePath: string,
    agentId: string,
    operation: 'write' | 'patch' | 'delete',
    metadata?: {
      startLine?: number;
      endLine?: number;
      content?: string;
    }
  ): Promise<DetectedConflict | null> {
    // Get file history
    const fileHistory = this.tracker.getFileHistory(filePath);

    // No history = no conflict
    if (fileHistory.length === 0) {
      return null;
    }

    // Filter changes from other agents
    const otherAgentChanges = fileHistory.filter((c) => c.agentId !== agentId);

    // No other agents modified = no conflict
    if (otherAgentChanges.length === 0) {
      return null;
    }

    const conflictingAgents = [...new Set(otherAgentChanges.map((c) => c.agentId))];
    const latestChange = fileHistory[fileHistory.length - 1]!;

    // ========================================================================
    // Case 1: Disjoint changes (no conflict, confidence = 1.0)
    // ========================================================================
    if (operation === 'patch' && latestChange.operation === 'patch') {
      const hasLineOverlap = this.checkLineOverlap(
        metadata?.startLine,
        metadata?.endLine,
        latestChange.metadata?.startLine,
        latestChange.metadata?.endLine
      );

      if (!hasLineOverlap) {
        // Disjoint patches - safe to auto-resolve
        return {
          type: 'disjoint',
          filePath,
          currentAgentId: agentId,
          conflictingAgents,
          description: 'Patches on different lines - safe to merge',
          resolutionConfidence: 1.0,
        };
      }

      // Overlapping patches
      const overlapLines = this.getOverlappingLines(
        metadata?.startLine,
        metadata?.endLine,
        latestChange.metadata?.startLine,
        latestChange.metadata?.endLine
      );

      return {
        type: 'overlapping',
        filePath,
        currentAgentId: agentId,
        conflictingAgents,
        description: `Patches overlap on lines ${overlapLines.join(', ')}`,
        resolutionConfidence: 0.7, // LLM can merge
        metadata: { overlapLines },
      };
    }

    // ========================================================================
    // Case 2: Conflicting intent (one deletes, another modifies)
    // ========================================================================
    if (
      (operation === 'delete' && latestChange.operation !== 'delete') ||
      (operation !== 'delete' && latestChange.operation === 'delete')
    ) {
      return {
        type: 'conflicting-intent',
        filePath,
        currentAgentId: agentId,
        conflictingAgents,
        description: 'One agent deletes while another modifies',
        resolutionConfidence: 0.5, // Needs agent coordination
        metadata: {
          intentA: operation,
          intentB: latestChange.operation,
        },
      };
    }

    // ========================================================================
    // Case 3: Full file overwrites
    // ========================================================================
    if (operation === 'write' && latestChange.operation === 'write') {
      // Check if content is semantically different
      const semanticConflict = await this.detectSemanticConflict(
        latestChange.after.content,
        metadata?.content || ''
      );

      if (semanticConflict) {
        return {
          type: 'semantic',
          filePath,
          currentAgentId: agentId,
          conflictingAgents,
          description: 'Semantic conflict in file rewrites',
          resolutionConfidence: 0.3, // Hard to auto-resolve
          metadata: { semanticIssue: semanticConflict },
        };
      }

      return {
        type: 'overlapping',
        filePath,
        currentAgentId: agentId,
        conflictingAgents,
        description: 'Full file overwrite by multiple agents',
        resolutionConfidence: 0.6,
      };
    }

    // ========================================================================
    // Default: Generic conflict
    // ========================================================================
    return {
      type: 'overlapping',
      filePath,
      currentAgentId: agentId,
      conflictingAgents,
      description: 'Generic file modification conflict',
      resolutionConfidence: 0.5,
    };
  }

  /**
   * Check if two line ranges overlap
   */
  private checkLineOverlap(
    startA?: number,
    endA?: number,
    startB?: number,
    endB?: number
  ): boolean {
    if (startA === undefined || endA === undefined || startB === undefined || endB === undefined) {
      return true; // Conservative: assume overlap if metadata missing
    }

    // No overlap if ranges are disjoint
    return !(endA < startB || endB < startA);
  }

  /**
   * Get overlapping line numbers
   */
  private getOverlappingLines(
    startA?: number,
    endA?: number,
    startB?: number,
    endB?: number
  ): number[] {
    if (startA === undefined || endA === undefined || startB === undefined || endB === undefined) {
      return [];
    }

    const overlapStart = Math.max(startA, startB);
    const overlapEnd = Math.min(endA, endB);

    if (overlapStart > overlapEnd) {
      return [];
    }

    const lines: number[] = [];
    for (let i = overlapStart; i <= overlapEnd; i++) {
      lines.push(i);
    }

    return lines;
  }

  /**
   * Detect semantic conflicts between two versions
   *
   * Simple heuristic: check if both versions changed significantly
   * from their common ancestor (would need LLM for better detection)
   */
  private async detectSemanticConflict(
    contentA: string,
    contentB: string
  ): Promise<string | null> {
    // Simple heuristic: if both versions are very different, likely semantic conflict
    const linesA = contentA.split('\n');
    const linesB = contentB.split('\n');

    const lineDiff = Math.abs(linesA.length - linesB.length);
    const significantDiff = lineDiff > linesA.length * 0.3; // >30% change

    if (significantDiff) {
      return `Significant structural change (${lineDiff} line difference)`;
    }

    return null;
  }
}
