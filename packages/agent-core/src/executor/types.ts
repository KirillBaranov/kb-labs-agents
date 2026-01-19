/**
 * Types for Orchestrator and Specialist execution
 *
 * Phase 2: Adaptive Feedback Loop
 */

/**
 * Universal finding from any specialist
 *
 * Can represent:
 * - Code review issue (reviewer)
 * - Error pattern in logs (log-viewer)
 * - Security vulnerability (security-scanner)
 * - Performance bottleneck (performance-analyzer)
 * - Architectural smell (architect)
 * - etc.
 *
 * Note: Renamed from Finding to avoid conflict with execution-memory.ts
 */
export interface SpecialistFinding {
  // What was found
  category: string; // e.g., "type-error", "exception-pattern", "security-risk", "n+1-query"
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string; // Short summary (max 100 chars)
  description: string; // Detailed explanation

  // Where it was found (context-specific)
  context?: {
    file?: string; // For code-related findings
    line?: number;
    logFile?: string; // For log analysis
    timestamp?: string; // For time-based findings
    endpoint?: string; // For API-related findings
    [key: string]: unknown; // Extensible for any context
  };

  // How critical is this
  impact?: string; // What happens if not fixed
  frequency?: number; // How often this occurs (for logs, metrics)

  // What to do about it
  actionable: boolean; // Can orchestrator act on this?
  suggestedAction?: {
    type: 'fix' | 'investigate' | 'optimize' | 'document' | 'monitor' | 'alert';
    description: string;
    estimatedEffort?: 'trivial' | 'small' | 'medium' | 'large';
    targetSpecialist?: string; // Which specialist should handle this
  };
}

/**
 * Compact findings summary for orchestrator context
 *
 * CRITICAL: Keeps orchestrator context small!
 * Full findings are stored separately in FindingsStore
 */
export interface FindingsSummary {
  total: number;
  bySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  actionable: number; // How many findings have suggestedAction
  topFindings: SpecialistFinding[]; // Max 3 most important findings (for context efficiency)
}

/**
 * Subtask definition
 */
export interface SubTask {
  id: string; // Unique subtask ID (e.g., "subtask-1")
  description: string; // What needs to be done
  specialistId: string; // Which specialist should handle this
  dependencies?: string[]; // IDs of subtasks that must complete first
  priority?: number; // Higher = more important (1-10)
  estimatedComplexity?: 'low' | 'medium' | 'high'; // Complexity estimate
}

/**
 * Result from a specialist execution
 *
 * Phase 2: Enhanced with findings support
 */
export interface DelegatedResult {
  subtaskId: string;
  specialistId: string;
  success: boolean;
  output: unknown; // Full specialist output (stored in artifacts)
  error?: string;
  tokensUsed: number;
  durationMs: number;
  traceRef?: string; // Tool trace reference for verification

  // Phase 2: Feedback for orchestrator
  findingsSummary?: FindingsSummary; // Compact summary in context
  findingsRef?: string; // Reference to full findings (format: "findings:session-id:subtask-id")
}

/**
 * Orchestrator execution result
 */
export interface OrchestratorResult {
  success: boolean;
  answer: string; // Final synthesized answer
  plan: SubTask[]; // Original execution plan (may be modified during execution)
  delegatedResults: DelegatedResult[]; // Results from specialists
  tokensUsed: number; // Total tokens (planning + specialists + synthesis)
  durationMs: number;
  error?: string;
}

/**
 * Adaptation decision from orchestrator
 */
export interface AdaptationDecision {
  shouldAdapt: boolean;
  reason: string;
  newSubtasks: SubTask[];
  confidence: number; // 0.0-1.0
}

/**
 * Stored findings data (in state broker)
 */
export interface StoredFindings {
  sessionId: string;
  subtaskId: string;
  findings: SpecialistFinding[];
  timestamp: string;
  ttl: number; // TTL in milliseconds
}

/**
 * Findings registry for session cleanup
 */
export interface FindingsRegistry {
  sessionId: string;
  findingsIds: string[]; // List of all findings IDs for this session
  createdAt: string;
}
