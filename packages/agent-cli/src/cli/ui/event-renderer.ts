/**
 * Agent Event Renderer for CLI
 *
 * Renders agent events as beautiful CLI output with visual hierarchy.
 * Shows orchestrator → subtasks → agents → tools as nested blocks.
 */

import type { AgentEvent, AgentEventCallback } from '@kb-labs/agent-contracts';

// ═══════════════════════════════════════════════════════════════════════════
// ANSI Colors & Symbols
// ═══════════════════════════════════════════════════════════════════════════

const CSI = '\x1b[';
const RESET = '\x1b[0m';

const color = {
  // Status colors
  success: (t: string) => `${CSI}32m${t}${RESET}`,
  error: (t: string) => `${CSI}31m${t}${RESET}`,
  warning: (t: string) => `${CSI}33m${t}${RESET}`,
  info: (t: string) => `${CSI}36m${t}${RESET}`,

  // UI colors
  dim: (t: string) => `${CSI}90m${t}${RESET}`,
  bold: (t: string) => `${CSI}1m${t}${RESET}`,
  accent: (t: string) => `${CSI}38;5;99m${t}${RESET}`,      // Purple - orchestrator
  primary: (t: string) => `${CSI}38;5;39m${t}${RESET}`,     // Blue - agent
  highlight: (t: string) => `${CSI}38;5;51m${t}${RESET}`,   // Cyan - tools
  secondary: (t: string) => `${CSI}38;5;208m${t}${RESET}`,  // Orange - subtask
};

// Box-drawing characters for visual hierarchy
const box = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  leftT: '├',
  rightT: '┤',
  cross: '┼',
};

const symbols = {
  success: color.success('✓'),
  error: color.error('✗'),
  warning: color.warning('⚠'),
  spinner: ['◐', '◓', '◑', '◒'],
  thinking: '◆',
  executing: '▶',
  tool: '⚙',
  file: '📄',
  search: '🔍',
  command: '$',
  memory: '💾',
  subtask: '◈',
  agent: '●',
};

// ═══════════════════════════════════════════════════════════════════════════
// Render State - tracks current nesting level
// ═══════════════════════════════════════════════════════════════════════════

interface RenderState {
  orchestratorActive: boolean;
  currentSubtask: { id: string; index: number; total: number } | null;
  agentActive: boolean;
  indentLevel: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function formatDuration(ms: number): string {
  if (ms < 1000) {return `${ms}ms`;}
  if (ms < 60000) {return `${(ms / 1000).toFixed(1)}s`;}
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function formatPath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) {return path;}
  const parts = path.split('/');
  if (parts.length <= 2) {return '...' + path.slice(-maxLen + 3);}
  return `.../${parts.slice(-2).join('/')}`;
}

function indent(level: number): string {
  return '  '.repeat(level);
}

function renderBoxTop(title: string, colorFn: (s: string) => string, width = 60): string {
  const titleLen = title.length + 2; // space around title
  const leftPad = 2;
  const rightPad = width - leftPad - titleLen - 2;
  return colorFn(
    `${box.topLeft}${box.horizontal.repeat(leftPad)} ${title} ${box.horizontal.repeat(Math.max(0, rightPad))}${box.topRight}`
  );
}

function renderBoxBottom(colorFn: (s: string) => string, width = 60): string {
  return colorFn(`${box.bottomLeft}${box.horizontal.repeat(width - 2)}${box.bottomRight}`);
}

function renderBoxLine(content: string, colorFn: (s: string) => string): string {
  return `${colorFn(box.vertical)} ${content}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Event Renderer Factory
// ═══════════════════════════════════════════════════════════════════════════

export function createEventRenderer(options: {
  verbose?: boolean;
  showToolOutput?: boolean;
  showLLMContent?: boolean;
}): AgentEventCallback {
  const { verbose = true, showToolOutput = true, showLLMContent = false } = options;

  const state: RenderState = {
    orchestratorActive: false,
    currentSubtask: null,
    agentActive: false,
    indentLevel: 0,
  };

  return (event: AgentEvent) => {
    const prefix = indent(state.indentLevel);

    switch (event.type) {
      // ═══════════════════════════════════════════════════════════════════
      // ORCHESTRATOR LEVEL (top-level container)
      // ═══════════════════════════════════════════════════════════════════
      case 'orchestrator:start': {
        state.orchestratorActive = true;
        state.indentLevel = 0;

        console.log();
        console.log(renderBoxTop('ORCHESTRATOR', color.accent));
        console.log(renderBoxLine(
          `Task: ${color.bold(event.data.task.slice(0, 50))}${event.data.task.length > 50 ? '...' : ''}`,
          color.accent
        ));
        console.log(renderBoxLine(
          `Complexity: ${color.dim(event.data.complexity)}`,
          color.accent
        ));
        console.log(color.accent(box.vertical));
        break;
      }

      case 'orchestrator:end': {
        console.log(color.accent(box.vertical));

        const statusLine = event.data.success
          ? `${symbols.success} Completed: ${event.data.completedCount}/${event.data.subtaskCount} subtasks`
          : `${symbols.error} Failed: ${event.data.completedCount}/${event.data.subtaskCount} subtasks`;

        const duration = event.data.durationMs ? ` ${color.dim(`(${formatDuration(event.data.durationMs)})`)}` : '';
        console.log(renderBoxLine(statusLine + duration, color.accent));

        // Show final result/answer from orchestrator
        if (event.data.summary) {
          console.log(color.accent(box.vertical));
          console.log(renderBoxLine(color.bold('📋 Final Answer:'), color.accent));

          // Word-wrap and display the summary
          const maxChars = showLLMContent ? 2000 : 1000;
          const summaryText = event.data.summary.slice(0, maxChars);
          const summaryLines = summaryText.split('\n').slice(0, 30);

          for (const line of summaryLines) {
            if (line.trim()) {
              // Word wrap long lines
              const words = line.split(' ');
              let currentLine = '';
              for (const word of words) {
                if (currentLine.length + word.length > 70) {
                  if (currentLine) {
                    console.log(renderBoxLine(`   ${currentLine}`, color.accent));
                  }
                  currentLine = word;
                } else {
                  currentLine = currentLine ? `${currentLine} ${word}` : word;
                }
              }
              if (currentLine) {
                console.log(renderBoxLine(`   ${currentLine}`, color.accent));
              }
            }
          }

          if (event.data.summary.length > maxChars) {
            console.log(renderBoxLine(color.dim('   ... (truncated)'), color.accent));
          }
        }

        console.log(renderBoxBottom(color.accent));
        console.log();

        state.orchestratorActive = false;
        state.indentLevel = 0;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════
      // SUBTASK LEVEL (nested under orchestrator)
      // ═══════════════════════════════════════════════════════════════════
      case 'subtask:start': {
        state.currentSubtask = {
          id: event.data.subtaskId,
          index: event.data.index,
          total: event.data.total,
        };
        state.indentLevel = 1;

        const subtaskNum = `${event.data.index + 1}/${event.data.total}`;
        console.log(color.accent(box.vertical));
        console.log(
          color.accent(`${box.leftT}${box.horizontal}`) +
          renderBoxTop(`SUBTASK ${subtaskNum}`, color.secondary, 50)
        );
        console.log(
          color.accent(box.vertical) + ' ' +
          renderBoxLine(
            `${symbols.subtask} ${event.data.description.slice(0, 45)}${event.data.description.length > 45 ? '...' : ''}`,
            color.secondary
          )
        );
        console.log(color.accent(box.vertical) + ' ' + color.secondary(box.vertical));
        break;
      }

      case 'subtask:end': {
        const status = event.data.success
          ? color.success(`${symbols.success} Done`)
          : color.error(`${symbols.error} Failed`);

        console.log(color.accent(box.vertical) + ' ' + color.secondary(box.vertical));
        console.log(
          color.accent(box.vertical) + ' ' +
          renderBoxLine(status, color.secondary)
        );
        console.log(
          color.accent(box.vertical) + ' ' +
          renderBoxBottom(color.secondary, 50)
        );

        state.currentSubtask = null;
        state.indentLevel = 0;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════
      // AGENT LEVEL (nested under subtask or standalone)
      // ═══════════════════════════════════════════════════════════════════
      case 'agent:start': {
        state.agentActive = true;

        // Determine prefix based on context
        const linePrefix = state.currentSubtask
          ? color.accent(box.vertical) + ' ' + color.secondary(box.vertical) + ' '
          : '';

        console.log(linePrefix);
        console.log(linePrefix + renderBoxTop(`AGENT [${event.data.tier}]`, color.primary, 45));
        console.log(linePrefix + renderBoxLine(
          `${symbols.agent} ${event.data.task.slice(0, 40)}${event.data.task.length > 40 ? '...' : ''}`,
          color.primary
        ));
        console.log(linePrefix + renderBoxLine(
          color.dim(`Tools: ${event.data.toolCount} | Max iterations: ${event.data.maxIterations}`),
          color.primary
        ));

        state.indentLevel = state.currentSubtask ? 3 : 1;
        break;
      }

      case 'agent:end': {
        const linePrefix = state.currentSubtask
          ? color.accent(box.vertical) + ' ' + color.secondary(box.vertical) + ' '
          : '';

        const status = event.data.success
          ? color.success(`${symbols.success} Success`)
          : color.error(`${symbols.error} Failed`);

        console.log(linePrefix + color.primary(box.vertical));
        console.log(linePrefix + renderBoxLine(
          `${status} ${color.dim(`(${formatDuration(event.data.durationMs)}, ${event.data.tokensUsed} tokens)`)}`,
          color.primary
        ));

        // Show the result summary - this is what the agent produced!
        if (event.data.summary) {
          console.log(linePrefix + color.primary(box.vertical));
          console.log(linePrefix + renderBoxLine(
            color.bold('📋 Result:'),
            color.primary
          ));
          // Split summary into lines and display (max 2000 chars for detailed mode)
          const maxChars = showLLMContent ? 2000 : 800;
          const summaryText = event.data.summary.slice(0, maxChars);
          const summaryLines = summaryText.split('\n').slice(0, 20);
          for (const line of summaryLines) {
            if (line.trim()) {
              // Word wrap long lines at ~80 chars
              const words = line.split(' ');
              let currentLine = '';
              for (const word of words) {
                if (currentLine.length + word.length > 75) {
                  if (currentLine) {
                    console.log(linePrefix + renderBoxLine(`   ${currentLine}`, color.primary));
                  }
                  currentLine = word;
                } else {
                  currentLine = currentLine ? `${currentLine} ${word}` : word;
                }
              }
              if (currentLine) {
                console.log(linePrefix + renderBoxLine(`   ${currentLine}`, color.primary));
              }
            }
          }
          if (event.data.summary.length > maxChars) {
            console.log(linePrefix + renderBoxLine(
              color.dim('   ... (truncated)'),
              color.primary
            ));
          }
        }

        if (event.data.filesModified.length > 0 || event.data.filesCreated.length > 0) {
          const files = [...event.data.filesCreated, ...event.data.filesModified];
          console.log(linePrefix + renderBoxLine(
            color.dim(`Files: ${files.slice(0, 3).map(f => formatPath(f, 20)).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`),
            color.primary
          ));
        }

        console.log(linePrefix + renderBoxBottom(color.primary, 45));

        state.agentActive = false;
        state.indentLevel = state.currentSubtask ? 1 : 0;
        break;
      }

      case 'agent:error': {
        const linePrefix = getLinePrefix(state);
        console.log(linePrefix + renderBoxLine(
          `${symbols.error} ${color.error('Error:')} ${event.data.error.slice(0, 50)}`,
          color.primary
        ));
        break;
      }

      // ═══════════════════════════════════════════════════════════════════
      // ITERATION & LLM (inside agent box)
      // ═══════════════════════════════════════════════════════════════════
      case 'iteration:start': {
        const linePrefix = getLinePrefix(state);
        if (verbose) {
          console.log(linePrefix + color.primary(box.vertical));
          console.log(linePrefix + renderBoxLine(
            color.dim(`─── Iteration ${event.data.iteration}/${event.data.maxIterations} ───`),
            color.primary
          ));
        }
        break;
      }

      case 'llm:start': {
        const linePrefix = getLinePrefix(state);
        if (verbose) {
          process.stdout.write(linePrefix + renderBoxLine(
            `${color.accent(symbols.thinking)} ${color.dim('Thinking...')}`,
            color.primary
          ));
        }
        break;
      }

      case 'llm:end': {
        if (verbose) {
          // Clear line and show result
          process.stdout.write(`\r`);
          const linePrefix = getLinePrefix(state);
          console.log(linePrefix + renderBoxLine(
            `${color.accent(symbols.thinking)} Thought ${color.dim(`(${formatDuration(event.data.durationMs)}, ${event.data.tokensUsed} tok)`)}`,
            color.primary
          ));

          // Always show LLM reasoning in verbose mode (truncated)
          if (event.data.content) {
            const maxLen = showLLMContent ? 500 : 150;
            const content = event.data.content.slice(0, maxLen).replace(/\n/g, ' ').trim();
            if (content) {
              console.log(linePrefix + renderBoxLine(
                color.dim(`  💭 "${content}${event.data.content.length > maxLen ? '...' : ''}"`),
                color.primary
              ));
            }
          }
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════════════
      // TOOL EXECUTION (inside agent, compact format)
      // ═══════════════════════════════════════════════════════════════════
      case 'tool:start': {
        const linePrefix = getLinePrefix(state);
        const toolName = event.data.toolName;
        const meta = event.data.metadata;

        let details = '';
        if (meta?.filePath) {
          details = ` ${color.dim(formatPath(meta.filePath as string, 30))}`;
        } else if (meta?.query) {
          details = ` ${color.dim(`"${(meta.query as string).slice(0, 25)}${(meta.query as string).length > 25 ? '...' : ''}"`)}`
        } else if (meta?.command) {
          details = ` ${color.dim(`$ ${(meta.command as string).slice(0, 25)}`)}`
        }

        process.stdout.write(linePrefix + renderBoxLine(
          `${color.highlight(symbols.tool)} ${color.highlight(toolName)}${details}`,
          color.primary
        ));
        break;
      }

      case 'tool:end': {
        const status = event.data.success
          ? ` ${symbols.success}`
          : ` ${symbols.error}`;

        process.stdout.write(`${status} ${color.dim(formatDuration(event.data.durationMs))}\n`);

        // Show tool output details
        if (showToolOutput) {
          const linePrefix = getLinePrefix(state);
          const meta = event.data.metadata;
          const output = event.data.output;

          // Show output preview for tools
          if (output && verbose) {
            // Truncate and clean output for display
            const cleanOutput = output
              .slice(0, 200)
              .replace(/\n/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

            if (cleanOutput && cleanOutput.length > 10) {
              console.log(linePrefix + renderBoxLine(
                color.dim(`    📄 ${cleanOutput}${output.length > 200 ? '...' : ''}`),
                color.primary
              ));
            }
          }

          // Show metadata summary if available
          if (meta?.summary && !output) {
            console.log(linePrefix + renderBoxLine(
              color.dim(`    └─ ${(meta.summary as string).slice(0, 80)}`),
              color.primary
            ));
          }
        }
        break;
      }

      case 'tool:error': {
        process.stdout.write(` ${symbols.error}\n`);
        const linePrefix = getLinePrefix(state);
        console.log(linePrefix + renderBoxLine(
          color.error(`    └─ ${event.data.error.slice(0, 50)}`),
          color.primary
        ));
        break;
      }

      // ═══════════════════════════════════════════════════════════════════
      // MEMORY & PROGRESS (compact notifications)
      // ═══════════════════════════════════════════════════════════════════
      case 'memory:write': {
        if (verbose) {
          const linePrefix = getLinePrefix(state);
          console.log(linePrefix + renderBoxLine(
            color.dim(`${symbols.memory} Saved ${event.data.entryType} to ${event.data.target}`),
            color.primary
          ));
        }
        break;
      }

      case 'status:change': {
        // Only show significant status in non-verbose mode
        if (!verbose && (event.data.status === 'done' || event.data.status === 'error')) {
          console.log(
            event.data.status === 'done'
              ? `${symbols.success} ${event.data.message}`
              : `${symbols.error} ${event.data.message}`
          );
        }
        break;
      }

      default:
        // Unknown event - ignore
        break;
    }
  };

  function getLinePrefix(state: RenderState): string {
    if (state.currentSubtask && state.agentActive) {
      return color.accent(box.vertical) + ' ' + color.secondary(box.vertical) + ' ';
    }
    if (state.currentSubtask) {
      return color.accent(box.vertical) + ' ' + color.secondary(box.vertical) + ' ';
    }
    if (state.agentActive) {
      return '';
    }
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Preset Renderers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Minimal renderer - only shows high-level events
 */
export function createMinimalRenderer(): AgentEventCallback {
  return createEventRenderer({
    verbose: false,
    showToolOutput: false,
    showLLMContent: false,
  });
}

/**
 * Detailed renderer - shows everything including LLM content
 */
export function createDetailedRenderer(): AgentEventCallback {
  return createEventRenderer({
    verbose: true,
    showToolOutput: true,
    showLLMContent: true,
  });
}
