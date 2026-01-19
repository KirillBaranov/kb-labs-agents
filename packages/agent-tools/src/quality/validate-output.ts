/**
 * @module @kb-labs/agent-tools/quality
 * Tool for validating specialist output quality.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Validation criterion result.
 */
export interface ValidationCriterion {
  /** Criterion name */
  criterion: string;
  /** Whether criterion was met */
  met: boolean;
  /** Evidence or explanation */
  evidence: string;
}

/**
 * Output validation result.
 */
export interface OutputValidation {
  /** Subtask ID being validated */
  subtaskId: string;
  /** Specialist who produced the output */
  specialistId: string;
  /** Overall validation status */
  isValid: boolean;
  /** Individual criteria results */
  criteria: ValidationCriterion[];
  /** Issues found (if any) */
  issues?: string[];
  /** Overall assessment */
  assessment: string;
}

/**
 * Create LLM tool for validating specialist output.
 *
 * Checks output against quality criteria and requirements.
 *
 * @returns LLM tool definition
 */
export function createValidateOutputTool(): LLMTool {
  return {
    name: 'validate_output',
    description: `Validate specialist output against quality criteria and requirements.

**Common validation criteria:**
- Completeness: All required deliverables present
- Correctness: Output matches requirements
- Quality: Code quality, test coverage, documentation
- Consistency: Follows project standards and patterns
- Functionality: Works as expected (tests pass)

**Use this tool to:**
- Verify specialist output meets requirements
- Identify quality issues before proceeding
- Document validation evidence`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'specialistId', 'isValid', 'criteria', 'assessment'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'ID of subtask being validated',
          pattern: '^subtask-\\d+$',
        },
        specialistId: {
          type: 'string',
          description: 'Specialist who produced the output',
        },
        isValid: {
          type: 'boolean',
          description: 'Whether output passes validation',
        },
        criteria: {
          type: 'array',
          description: 'Individual validation criteria results',
          minItems: 1,
          items: {
            type: 'object',
            required: ['criterion', 'met', 'evidence'],
            properties: {
              criterion: {
                type: 'string',
                description: 'Name of validation criterion',
                minLength: 5,
                maxLength: 100,
              },
              met: {
                type: 'boolean',
                description: 'Whether this criterion was met',
              },
              evidence: {
                type: 'string',
                description: 'Evidence or explanation for this result',
                minLength: 10,
                maxLength: 300,
              },
            },
          },
        },
        issues: {
          type: 'array',
          description: 'Issues found during validation (if any)',
          items: {
            type: 'string',
            minLength: 10,
            maxLength: 200,
          },
        },
        assessment: {
          type: 'string',
          description: 'Overall validation assessment',
          minLength: 20,
          maxLength: 500,
        },
      },
    },
  };
}
