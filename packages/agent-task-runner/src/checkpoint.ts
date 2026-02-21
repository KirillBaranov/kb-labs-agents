/**
 * Phase 3: Universal Task Runner - Checkpoint Manager
 *
 * Saves execution state for recovery after failures
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskCheckpoint, ExecutionPlan, StepResult } from './types.js';

export interface CheckpointConfig {
  /**
   * Directory to store checkpoint files
   */
  checkpointDir: string;

  /**
   * Verbose logging
   */
  verbose?: boolean;
}

export class CheckpointManager {
  private config: CheckpointConfig;

  constructor(config: CheckpointConfig) {
    this.config = config;
  }

  /**
   * Save checkpoint to disk
   */
  async save(checkpoint: TaskCheckpoint): Promise<void> {
    this.log(`💾 Saving checkpoint for task ${checkpoint.taskId}...`);

    await this.ensureCheckpointDir();

    const filePath = this.getCheckpointPath(checkpoint.taskId);
    const data = JSON.stringify(checkpoint, null, 2);

    await fs.writeFile(filePath, data, 'utf-8');

    this.log(`✅ Checkpoint saved: ${filePath}`);
  }

  /**
   * Load checkpoint from disk
   */
  async load(taskId: string): Promise<TaskCheckpoint | null> {
    this.log(`📂 Loading checkpoint for task ${taskId}...`);

    const filePath = this.getCheckpointPath(taskId);

    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const checkpoint = JSON.parse(data) as TaskCheckpoint;

      this.log(`✅ Checkpoint loaded: ${filePath}`);

      return checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log(`ℹ️  No checkpoint found for task ${taskId}`);
        return null;
      }

      throw error;
    }
  }

  /**
   * Delete checkpoint from disk
   */
  async delete(taskId: string): Promise<void> {
    this.log(`🗑️  Deleting checkpoint for task ${taskId}...`);

    const filePath = this.getCheckpointPath(taskId);

    try {
      await fs.unlink(filePath);
      this.log(`✅ Checkpoint deleted: ${filePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log(`ℹ️  No checkpoint to delete for task ${taskId}`);
        return;
      }

      throw error;
    }
  }

  /**
   * List all checkpoints
   */
  async list(): Promise<string[]> {
    await this.ensureCheckpointDir();

    const files = await fs.readdir(this.config.checkpointDir);

    return files.filter((f) => f.endsWith('.checkpoint.json')).map((f) => f.replace('.checkpoint.json', ''));
  }

  /**
   * Create initial checkpoint
   */
  createInitialCheckpoint(taskId: string, plan: ExecutionPlan): TaskCheckpoint {
    return {
      taskId,
      timestamp: new Date().toISOString(),
      plan,
      completedSteps: [],
      currentStep: null,
      elapsedMs: 0,
      costUsd: 0,
      canResume: true,
    };
  }

  /**
   * Update checkpoint after step completion
   */
  updateCheckpoint(
    checkpoint: TaskCheckpoint,
    stepResult: StepResult,
    nextStepNumber: number | null
  ): TaskCheckpoint {
    return {
      ...checkpoint,
      timestamp: new Date().toISOString(),
      completedSteps: [...checkpoint.completedSteps, stepResult],
      currentStep: nextStepNumber,
      elapsedMs: checkpoint.elapsedMs + stepResult.durationMs,
      costUsd: checkpoint.costUsd + (stepResult.costUsd ?? 0),
    };
  }

  /**
   * Mark checkpoint as non-resumable (after abort)
   */
  markNonResumable(checkpoint: TaskCheckpoint, _reason: string): TaskCheckpoint {
    return {
      ...checkpoint,
      timestamp: new Date().toISOString(),
      canResume: false,
    };
  }

  /**
   * Get checkpoint file path
   */
  private getCheckpointPath(taskId: string): string {
    return path.join(this.config.checkpointDir, `${taskId}.checkpoint.json`);
  }

  /**
   * Ensure checkpoint directory exists
   */
  private async ensureCheckpointDir(): Promise<void> {
    await fs.mkdir(this.config.checkpointDir, { recursive: true });
  }

  /**
   * Log helper
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(message);
    }
  }
}
