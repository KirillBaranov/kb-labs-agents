import type { ToolResult } from '@kb-labs/agent-contracts';

export function toolError(input: {
  code: string;
  message: string;
  retryable?: boolean;
  hint?: string;
  details?: Record<string, unknown>;
}): ToolResult {
  const header = `${input.code}: ${input.message}`;
  const hintBlock = input.hint ? `\n\nHint: ${input.hint}` : '';
  return {
    success: false,
    error: `${header}${hintBlock}`,
    errorDetails: {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      hint: input.hint,
      details: input.details,
    },
    metadata: {
      errorCode: input.code,
      retryable: input.retryable ?? false,
      ...(input.details || {}),
    },
  };
}

