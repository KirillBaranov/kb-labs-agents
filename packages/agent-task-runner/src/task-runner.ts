/**
 * Phase 3: Universal Task Runner - Main Entry Point
 *
 * Orchestrates planning, execution, verification, and recovery
 */

import type { ToolRegistry } from '@kb-labs/agent-tools';
import { Planner, type PlannerConfig } from './planner.js';
import { Executor, type ExecutorConfig } from './executor.js';
import { Verifier, type VerifierConfig } from './verifier.js';
import { CheckpointManager } from './checkpoint.js';
import { EscalationManager, type EscalationConfig } from './escalation.js';
import type { TaskInput, TaskResult, TaskCheckpoint, VerificationDecision, ExecutionPlan } from './types.js';

export interface TaskRunnerConfig {
  /**
   * Working directory for agent execution
   */
  workingDir: string;

  /**
   * Tool registry for agent execution
   */
  toolRegistry: ToolRegistry;

  /**
   * Checkpoint directory
   */
  checkpointDir: string;

  /**
   * Planner config
   */
  planner?: PlannerConfig;

  /**
   * Executor config
   */
  executor?: Partial<ExecutorConfig>;

  /**
   * Verifier config
   */
  verifier?: VerifierConfig;

  /**
   * Escalation config
   */
  escalation?: EscalationConfig;

  /**
   * Verbose logging
   */
  verbose?: boolean;
}

export class TaskRunner {
  private planner: Planner;
  private executor: Executor;
  private verifier: Verifier;
  private checkpointManager: CheckpointManager;
  private escalationManager: EscalationManager;
  private verbose: boolean;

  constructor(config: TaskRunnerConfig) {
    this.verbose = config.verbose ?? false;

    this.planner = new Planner({
      ...config.planner,
      verbose: this.verbose,
    });

    this.executor = new Executor({
      workingDir: config.workingDir,
      toolRegistry: config.toolRegistry,
      maxIterations: config.executor?.maxIterations ?? 10,
      verbose: this.verbose,
    });

    this.verifier = new Verifier({
      ...config.verifier,
      verbose: this.verbose,
    });

    this.checkpointManager = new CheckpointManager({
      checkpointDir: config.checkpointDir,
      verbose: this.verbose,
    });

    this.escalationManager = new EscalationManager({
      ...config.escalation,
      verbose: this.verbose,
    });
  }

  /**
   * Execute a task from start to finish
   */
  async run(input: TaskInput): Promise<TaskResult> {
    this.log(`\n${'='.repeat(80)}`);
    this.log(`🚀 TaskRunner: Starting task ${input.id}`);
    this.log(`${'='.repeat(80)}\n`);

    const startTime = Date.now();

    try {
      // Check for existing checkpoint (resume support)
      let checkpoint = await this.checkpointManager.load(input.id);

      if (checkpoint && checkpoint.canResume) {
        this.log(`📂 Resuming from checkpoint (${checkpoint.completedSteps.length} steps completed)`);
      } else {
        // Create new execution plan
        this.log(`📋 Creating execution plan...`);
        const plan = await this.planner.createPlan(input);

        this.log(`✅ Plan created: ${plan.steps.length} steps`);
        this.log(`   Summary: ${plan.summary}`);
        this.log(`   Estimated duration: ${Math.round((plan.estimatedDuration ?? 0) / 1000)}s`);
        this.log(`   Estimated cost: $${(plan.estimatedCost ?? 0).toFixed(2)}\n`);

        // Create initial checkpoint
        checkpoint = this.checkpointManager.createInitialCheckpoint(input.id, plan);
        await this.checkpointManager.save(checkpoint);
      }

      // Execute steps
      const result = await this.executeSteps(checkpoint);

      // Clean up checkpoint on success
      if (result.status === 'success') {
        await this.checkpointManager.delete(input.id);
      }

      const totalDuration = Date.now() - startTime;

      this.log(`\n${'='.repeat(80)}`);
      this.log(`✅ TaskRunner: Task ${input.id} completed (${result.status})`);
      this.log(`   Duration: ${Math.round(totalDuration / 1000)}s`);
      this.log(`   Cost: $${result.totalCostUsd.toFixed(2)}`);
      this.log(`${'='.repeat(80)}\n`);

      return result;
    } catch (error) {
      this.log(`\n❌ TaskRunner: Task ${input.id} failed with error`);
      this.log(`   ${error instanceof Error ? error.message : String(error)}\n`);

      throw error;
    }
  }

  /**
   * Execute all steps in plan with verification and recovery
   */
  private async executeSteps(checkpoint: TaskCheckpoint): Promise<TaskResult> {
    const plan = checkpoint.plan;
    const retryCountByStep = new Map<number, number>();

    let currentStepIndex = checkpoint.completedSteps.length;

    while (currentStepIndex < plan.steps.length) {
      const step = plan.steps[currentStepIndex];

      if (!step) {
        throw new Error(`Step at index ${currentStepIndex} not found`);
      }

      const stepNumber = step.stepNumber;

      this.log(`\n${'─'.repeat(80)}`);
      this.log(`📍 Step ${stepNumber}/${plan.steps.length}: ${step.description}`);
      this.log(`${'─'.repeat(80)}`);

      // Update checkpoint current step
      checkpoint = { ...checkpoint, currentStep: stepNumber };
      // Sequential checkpoint save required before step execution
      // eslint-disable-next-line no-await-in-loop
      await this.checkpointManager.save(checkpoint);

      // Execute step
      // Sequential execution required - each step depends on previous step completion
      // eslint-disable-next-line no-await-in-loop
      const stepResult = await this.executor.executeStep(step, checkpoint);

      // Check for critical errors before verification
      if (this.escalationManager.shouldEscalateBeforeVerification(stepResult)) {
        return this.createAbortResult(checkpoint, 'Critical error in step execution');
      }

      // Verify step result
      // Sequential verification required - decision affects next step execution
      // eslint-disable-next-line no-await-in-loop
      const decision = await this.verifier.verify(step, stepResult, checkpoint);

      // Check escalation rules
      const retryCount = retryCountByStep.get(stepNumber) ?? 0;
      if (this.escalationManager.shouldEscalate(checkpoint, decision, retryCount)) {
        // Build escalation message
        const message = this.escalationManager.buildEscalationMessage(checkpoint, decision, retryCount);

        this.log(`\n${message}\n`);

        // For now, abort on escalation (TODO: add human-in-the-loop)
        return this.createAbortResult(checkpoint, 'Task requires human decision');
      }

      // Handle verification decision
      if (decision.verdict === 'retry') {
        this.log(`\n🔄 Retrying step ${stepNumber} (attempt ${retryCount + 1})...`);
        this.log(`   Modifications: ${decision.retryStrategy?.modifications.join(', ')}\n`);

        retryCountByStep.set(stepNumber, retryCount + 1);

        // Don't increment currentStepIndex - retry same step
        continue;
      }

      if (decision.verdict === 'abort') {
        this.log(`\n❌ Aborting task: ${decision.reasoning}\n`);
        return this.createAbortResult(checkpoint, decision.reasoning);
      }

      if (decision.verdict === 'escalate') {
        // This should have been caught by escalationManager.shouldEscalate
        return this.createAbortResult(checkpoint, decision.escalationReason ?? 'Verifier requested escalation');
      }

      // Proceed: update checkpoint with completed step
      const nextStepNumber = currentStepIndex + 1 < plan.steps.length ? plan.steps[currentStepIndex + 1]?.stepNumber ?? null : null;

      checkpoint = this.checkpointManager.updateCheckpoint(checkpoint, stepResult, nextStepNumber);

      // Sequential checkpoint save required after step completion
      // eslint-disable-next-line no-await-in-loop
      await this.checkpointManager.save(checkpoint);

      // Apply plan adjustments if any
      if (decision.planAdjustments) {
        const adjustedPlan = this.applyPlanAdjustments(checkpoint.plan, decision.planAdjustments);
        checkpoint = { ...checkpoint, plan: adjustedPlan };
        // Sequential checkpoint save required for plan adjustments
        // eslint-disable-next-line no-await-in-loop
        await this.checkpointManager.save(checkpoint);
      }

      // Move to next step
      currentStepIndex++;

      // Reset retry count for next step
      retryCountByStep.delete(stepNumber);
    }

    // All steps completed successfully
    return this.createSuccessResult(checkpoint);
  }

  /**
   * Apply plan adjustments from verification decision
   */
  private applyPlanAdjustments(
    plan: ExecutionPlan,
    adjustments: NonNullable<VerificationDecision['planAdjustments']>
  ): ExecutionPlan {
    let steps = [...plan.steps];

    // Skip steps
    if (adjustments.skipSteps && adjustments.skipSteps.length > 0) {
      this.log(`\n📝 Plan adjustment: Skipping steps ${adjustments.skipSteps.join(', ')}`);
      steps = steps.filter((s) => !adjustments.skipSteps!.includes(s.stepNumber));

      // Renumber remaining steps
      steps = steps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    }

    // Modify steps
    if (adjustments.modifySteps && adjustments.modifySteps.length > 0) {
      for (const mod of adjustments.modifySteps) {
        const index = steps.findIndex((s) => s.stepNumber === mod.stepNumber);
        if (index !== -1 && steps[index]) {
          this.log(`\n📝 Plan adjustment: Modifying step ${mod.stepNumber}`);
          steps[index] = { ...steps[index]!, ...mod.changes };
        }
      }
    }

    // Add steps
    if (adjustments.addSteps && adjustments.addSteps.length > 0) {
      this.log(`\n📝 Plan adjustment: Adding ${adjustments.addSteps.length} step(s)`);
      steps.push(...adjustments.addSteps);

      // Renumber all steps
      steps = steps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    }

    return { ...plan, steps };
  }

  /**
   * Create success result
   */
  private createSuccessResult(checkpoint: TaskCheckpoint): TaskResult {
    const plan = checkpoint.plan;

    // Check which success criteria were met
    const criteriaMet: string[] = [];
    const criteriaNotMet: string[] = [];

    for (const criterion of plan.successCriteria) {
      // Simple heuristic: check if criterion keywords appear in step outputs
      const found = checkpoint.completedSteps.some((step) => {
        const keywords = criterion.toLowerCase().split(/\s+/);
        return keywords.some((kw) => step.output.toLowerCase().includes(kw));
      });

      if (found) {
        criteriaMet.push(criterion);
      } else {
        criteriaNotMet.push(criterion);
      }
    }

    const status = criteriaNotMet.length === 0 ? 'success' : 'partial';

    return {
      taskId: checkpoint.taskId,
      status,
      summary: this.buildSummary(checkpoint, status),
      steps: checkpoint.completedSteps,
      checkpoint,
      totalDurationMs: checkpoint.elapsedMs,
      totalCostUsd: checkpoint.costUsd,
      criteriaMet,
      criteriaNotMet,
    };
  }

  /**
   * Create abort result
   */
  private createAbortResult(checkpoint: TaskCheckpoint, reason: string): TaskResult {
    // Mark checkpoint as non-resumable
    const updatedCheckpoint = this.checkpointManager.markNonResumable(checkpoint, reason);

    return {
      taskId: checkpoint.taskId,
      status: 'aborted',
      summary: `Task aborted: ${reason}`,
      steps: checkpoint.completedSteps,
      checkpoint: updatedCheckpoint,
      totalDurationMs: checkpoint.elapsedMs,
      totalCostUsd: checkpoint.costUsd,
      criteriaMet: [],
      criteriaNotMet: checkpoint.plan.successCriteria,
    };
  }

  /**
   * Build result summary
   */
  private buildSummary(checkpoint: TaskCheckpoint, status: string): string {
    const parts: string[] = [];

    parts.push(`Task ${status}: ${checkpoint.plan.summary}`);
    parts.push(`Completed ${checkpoint.completedSteps.length}/${checkpoint.plan.steps.length} steps`);

    const successfulSteps = checkpoint.completedSteps.filter((s) => s.status === 'success').length;
    const partialSteps = checkpoint.completedSteps.filter((s) => s.status === 'partial').length;
    const failedSteps = checkpoint.completedSteps.filter((s) => s.status === 'failed').length;

    parts.push(`Success: ${successfulSteps}, Partial: ${partialSteps}, Failed: ${failedSteps}`);

    return parts.join('. ');
  }

  /**
   * Log helper
   */
  private log(message: string): void {
    if (this.verbose) {
      console.log(message);
    }
  }
}
