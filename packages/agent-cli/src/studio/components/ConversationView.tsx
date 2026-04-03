/**
 * Turn-based conversation UI — Claude Code style
 * Adapted from studio/modules/agents for plugin widget use.
 */

import React from 'react';
import type { Turn, TurnStep, FileChangeSummary } from '@kb-labs/agent-contracts';
import { useMutateData, useData, UISpin, UIMarkdownViewer, UIModalConfirm } from '@kb-labs/sdk/studio';
import './conversation-view.css';

interface ConversationViewProps {
  turns: Turn[];
  isLoading?: boolean;
  sessionId?: string | null;
}

export function ConversationView({ turns, isLoading, sessionId }: ConversationViewProps) {
  if (isLoading) {
    return (
      <div className="cv-empty">
        <UISpin size="small" /> <span style={{ marginLeft: 8, color: '#999', fontSize: 13 }}>Loading history...</span>
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="cv-empty">
        <span className="cv-empty-text">Ask anything to get started</span>
      </div>
    );
  }

  return (
    <div className="cv">
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} sessionId={sessionId} />
      ))}
    </div>
  );
}

function TurnView({ turn, sessionId }: { turn: Turn; sessionId?: string | null }) {
  if (turn.type === 'user') {
    const text = turn.steps.find((s) => s.type === 'text');
    return (
      <div className="cv-user">
        <span className="cv-user-bubble">{text?.type === 'text' ? text.content : ''}</span>
      </div>
    );
  }

  const isStreaming = turn.status === 'streaming';
  const textSteps = turn.steps.filter((s) => s.type === 'text');
  const visibleTextSteps = textSteps.filter(
    (s) => !isInternalProgressText(s.content ?? '') && s.content?.trim(),
  );
  const hasInternalProgressText = textSteps.some((s) => isInternalProgressText(s.content ?? ''));

  const reportStep = turn.steps.find(
    (s) => s.type === 'tool_use' && (s as import('@kb-labs/agent-contracts').ToolUseStep).toolName === 'report'
  ) as import('@kb-labs/agent-contracts').ToolUseStep | undefined;
  const reportAnswer = (reportStep?.input as Record<string, unknown> | null)?.answer as string | undefined;

  const visibleSteps = turn.steps.filter(
    (s) => s.type !== 'text' && !(s.type === 'tool_use' && (s as import('@kb-labs/agent-contracts').ToolUseStep).toolName === 'report')
  );
  const hasToolSteps = visibleSteps.length > 0 || isStreaming || hasInternalProgressText;

  const answerContent = reportAnswer || null;
  const fileChanges = turn.metadata?.fileChanges;
  const runId = turn.metadata?.runId;
  const showFileChanges = !isStreaming && fileChanges && fileChanges.length > 0 && !!sessionId && !!runId;

  return (
    <div className="cv-assistant">
      {hasToolSteps && (
        <div className="cv-timeline">
          {visibleSteps.map((step, i) => (
            <StepRow key={step.id} step={step} isLast={false} isStreaming={isStreaming && i === visibleSteps.length - 1 && !answerContent && visibleTextSteps.length === 0} />
          ))}
          {isStreaming && (turn.steps.length === 0 || hasInternalProgressText) && (
            <div className="cv-step cv-step--thinking">
              <div className="cv-step-dot cv-step-dot--pulse" />
              <span className="cv-step-label">Agent is analyzing and executing steps...</span>
            </div>
          )}
        </div>
      )}
      {answerContent && (
        <div className="cv-timeline cv-timeline--answer">
          <div className="cv-step cv-answer-block">
            <div className="cv-step-dot cv-step-dot--answer" />
            <UIMarkdownViewer className="cv-answer" content={answerContent} />
          </div>
        </div>
      )}
      {!answerContent && visibleTextSteps.map((step) => (
        step.type === 'text' && step.content?.trim() ? (
          <div key={step.id} className="cv-timeline cv-timeline--answer">
            <div className="cv-step cv-answer-block">
              <div className="cv-step-dot cv-step-dot--answer" />
              <UIMarkdownViewer className="cv-answer" content={step.content} />
            </div>
          </div>
        ) : null
      ))}
      {showFileChanges && (
        <div className="cv-timeline">
          <FileChangesBlock
            sessionId={sessionId!}
            runId={runId!}
            fileChanges={fileChanges!}
          />
        </div>
      )}
    </div>
  );
}

// --- File Changes Block ---

interface FileChangesBlockProps {
  sessionId: string;
  runId: string;
  fileChanges: FileChangeSummary[];
}

function FileChangesBlock({ sessionId, runId, fileChanges }: FileChangesBlockProps) {
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());
  const rollback = useMutateData<{ runId?: string; changeIds?: string[] }, { rolledBack: number; skipped: number; conflicts: unknown[] }>(
    `/v1/plugins/agents/sessions/${sessionId}/rollback`,
    'POST'
  );
  const approve = useMutateData<{ runId?: string; changeIds?: string[] }, { approved: number }>(
    `/v1/plugins/agents/sessions/${sessionId}/approve`,
    'POST'
  );

  const visible = fileChanges.filter((c) => !dismissed.has(c.changeId) && !c.approved);
  if (visible.length === 0) { return null; }

  const allApproved = visible.every((c) => c.approved);

  const handleRollback = () => {
    UIModalConfirm({
      title: 'Rollback changes?',
      content: `This will revert ${visible.length} ${pluralFiles(visible.length)} to the state before the agent run.`,
      okText: 'Rollback',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const result = await rollback.mutateAsync({ runId });
          if (result.conflicts?.length) {
            console.warn(`Rolled back: ${result.rolledBack}, skipped due to conflicts: ${result.skipped}`);
          }
          setDismissed(new Set(visible.map((c) => c.changeId)));
        } catch {
          console.error('Failed to rollback changes');
        }
      },
    });
  };

  const handleApprove = async () => {
    try {
      await approve.mutateAsync({ runId });
      setDismissed(new Set(visible.map((c) => c.changeId)));
    } catch {
      console.error('Failed to approve changes');
    }
  };

  return (
    <div className="cv-step cv-changes-block">
      <div className="cv-step-dot cv-step-dot--changes" />
      <div className="cv-step-body cv-changes-body">
        <div className="cv-changes-header">
          <span className="cv-changes-title">{visible.length} {pluralFiles(visible.length)} changed</span>
          {!allApproved && (
            <div className="cv-changes-actions">
              <button
                className="cv-changes-btn cv-changes-btn--approve"
                onClick={handleApprove}
                disabled={approve.isLoading || rollback.isLoading}
                title="Approve all changes"
              >✓</button>
              <button
                className="cv-changes-btn cv-changes-btn--rollback"
                onClick={handleRollback}
                disabled={rollback.isLoading || approve.isLoading}
                title="Rollback all changes"
              >✕</button>
            </div>
          )}
        </div>
        <ul className="cv-changes-list">
          {visible.map((change) => (
            <FileChangeRow
              key={change.changeId}
              change={change}
              sessionId={sessionId}
              onDismiss={() => setDismissed((prev) => new Set([...prev, change.changeId]))}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

interface FileChangeRowProps {
  change: FileChangeSummary;
  sessionId: string;
  onDismiss: () => void;
}

function FileChangeRow({ change, sessionId, onDismiss }: FileChangeRowProps) {
  const [open, setOpen] = React.useState(false);
  const rollback = useMutateData<{ changeIds: string[] }, { rolledBack: number; skipped: number; conflicts: unknown[] }>(
    `/v1/plugins/agents/sessions/${sessionId}/rollback`,
    'POST'
  );
  const approve = useMutateData<{ changeIds: string[] }, { approved: number }>(
    `/v1/plugins/agents/sessions/${sessionId}/approve`,
    'POST'
  );

  const diffUrl = open ? `/v1/plugins/agents/sessions/${sessionId}/changes/${encodeURIComponent(change.changeId)}/diff` : '';
  const { data: diffData, isLoading: diffLoading, isError: diffError } = useData<{ diff: string }>(diffUrl, { enabled: open });

  const handleRollback = (e: React.MouseEvent) => {
    e.stopPropagation();
    UIModalConfirm({
      title: 'Rollback file?',
      content: change.filePath,
      okText: 'Rollback',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await rollback.mutateAsync({ changeIds: [change.changeId] });
          onDismiss();
        } catch {
          console.error('Failed to rollback');
        }
      },
    });
  };

  const handleApprove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await approve.mutateAsync({ changeIds: [change.changeId] });
      onDismiss();
    } catch {
      console.error('Failed to approve');
    }
  };

  const opBadge = change.operation === 'delete'
    ? { label: 'del', cls: 'cv-changes-op--delete' }
    : change.isNew
    ? { label: 'new', cls: 'cv-changes-op--new' }
    : { label: 'mod', cls: 'cv-changes-op--mod' };

  const fileName = change.filePath.split('/').slice(-2).join('/');

  return (
    <li className="cv-change-row">
      <button className="cv-change-main" onClick={() => setOpen((v) => !v)}>
        <span className={`cv-changes-op ${opBadge.cls}`}>{opBadge.label}</span>
        <span className="cv-change-path" title={change.filePath}>{fileName}</span>
        {(change.linesAdded !== undefined || change.linesRemoved !== undefined) && (
          <span className="cv-change-stats">
            {change.linesAdded ? <span className="cv-change-add">+{change.linesAdded}</span> : null}
            {change.linesRemoved ? <span className="cv-change-rem"> -{change.linesRemoved}</span> : null}
          </span>
        )}
        <span className="cv-change-row-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="cv-changes-btn cv-changes-btn--approve cv-changes-btn--sm"
            onClick={handleApprove}
            disabled={approve.isLoading || rollback.isLoading}
            title="Approve"
          >✓</button>
          <button
            className="cv-changes-btn cv-changes-btn--rollback cv-changes-btn--sm"
            onClick={handleRollback}
            disabled={rollback.isLoading || approve.isLoading}
            title="Rollback"
          >✕</button>
        </span>
        <span className="cv-change-toggle">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="cv-change-diff">
          {diffLoading && <span className="cv-change-diff-loading">Loading diff...</span>}
          {diffData && <DiffView diff={diffData.diff} />}
          {diffError && <span className="cv-change-diff-err">Failed to load diff</span>}
        </div>
      )}
    </li>
  );
}

function pluralFiles(n: number): string {
  return n === 1 ? 'file' : 'files';
}

function StepRow({ step, isStreaming }: { step: TurnStep; isLast: boolean; isStreaming: boolean }) {
  switch (step.type) {
    case 'thinking': {
      const content = step.content?.trim() ?? '';
      if (isNoisyThinking(content)) { return null; }
      return (
        <div className="cv-step cv-step--insight">
          <div className={`cv-step-dot cv-step-dot--insight ${isStreaming ? 'cv-step-dot--pulse' : ''}`} />
          <div className="cv-step-body">
            <UIMarkdownViewer className="cv-thinking-md" content={content} />
          </div>
        </div>
      );
    }

    case 'tool_use':
      return <ToolRow step={step} isStreaming={isStreaming} />;

    case 'tool_result':
      return (
        <div className="cv-step">
          <div className={`cv-step-dot cv-step-dot--result-${step.success ? 'ok' : 'err'}`} />
          <div className="cv-step-body">
            <span className="cv-step-label">
              <span className="cv-tool-name">{formatToolName(step.toolName)}</span>
              {step.durationMs !== undefined && <span className="cv-step-duration">{step.durationMs}ms</span>}
            </span>
            {!step.success && step.error && <p className="cv-step-error-text">{step.error}</p>}
          </div>
        </div>
      );

    case 'subagent':
      return (
        <div className="cv-step">
          <div className="cv-step-dot cv-step-dot--tool" />
          <div className="cv-step-body">
            <span className="cv-step-label">
              <span className="cv-tool-name">Agent: {step.agentName}</span>
              <span className="cv-step-meta"> — {step.task?.slice(0, 60)}{(step.task?.length ?? 0) > 60 ? '...' : ''}</span>
            </span>
          </div>
        </div>
      );

    case 'error':
      return (
        <div className="cv-step">
          <div className="cv-step-dot cv-step-dot--result-err" />
          <div className="cv-step-body">
            <span className="cv-step-label cv-step-label--err">{step.code}</span>
            <p className="cv-step-error-text">{step.message}</p>
          </div>
        </div>
      );

    default:
      return null;
  }
}

function ToolDetails({
  step,
  hasDiff,
  hasOutput,
}: {
  step: import('@kb-labs/agent-contracts').ToolUseStep;
  hasDiff: boolean;
  hasOutput: boolean;
}) {
  const input = step.input as Record<string, unknown> | null | undefined;
  const toolLower = step.toolName.toLowerCase();

  const isWrite = toolLower.includes('write') || toolLower.includes('patch') || toolLower.includes('edit');
  const isRead = toolLower.includes('read');
  const isShell = toolLower.includes('bash') || toolLower.includes('exec') || toolLower.includes('shell') || toolLower.includes('run');
  const isSearch = toolLower.includes('grep') || toolLower.includes('search') || toolLower.includes('glob') || toolLower.includes('list') || toolLower.includes('rag');

  if (isWrite) {
    if (hasDiff) { return <DiffView diff={step.metadata!.diff!} />; }
    const content = (input?.content ?? input?.new_content ?? input?.text) as string | undefined;
    if (content) {
      const filePath = (input?.path ?? input?.filePath ?? input?.file_path ?? input?.file) as string | undefined;
      const ext = filePath ? filePath.split('.').pop() : undefined;
      return (
        <div className="cv-code-block">
          {filePath && <div className="cv-code-block-header">{filePath}</div>}
          <pre className={`cv-tool-output cv-tool-output--code${ext ? ` lang-${ext}` : ''}`}>{String(content)}</pre>
        </div>
      );
    }
    return null;
  }

  if (isRead && hasOutput) { return <pre className="cv-tool-output cv-tool-output--code">{formatOutput(step.output)}</pre>; }
  if (isShell && hasOutput) { return <pre className="cv-tool-output cv-tool-output--terminal">{formatOutput(step.output)}</pre>; }
  if (isSearch && hasOutput) { return <pre className="cv-tool-output">{formatOutput(step.output)}</pre>; }

  if (hasDiff) { return <DiffView diff={step.metadata!.diff!} />; }
  if (hasOutput) {
    const isFailed = step.status === 'done' && step.success === false;
    return <pre className={`cv-tool-output${isFailed ? ' cv-tool-output--error' : ''}`}>{formatOutput(step.output)}</pre>;
  }
  return null;
}

interface TodoItemData {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
}

interface TodoListData {
  sessionId: string;
  items: TodoItemData[];
}

const TODO_STATUS_ICON: Record<string, string> = {
  'completed': '✓',
  'in-progress': '●',
  'blocked': '✕',
  'pending': '○',
};

function TodoView({ todoList }: { todoList?: TodoListData }) {
  if (!todoList?.items?.length) { return null; }
  const completed = todoList.items.filter((i) => i.status === 'completed').length;
  return (
    <div className="cv-todo">
      <div className="cv-todo-progress">{completed}/{todoList.items.length}</div>
      <ul className="cv-todo-list">
        {todoList.items.map((item) => (
          <li key={item.id} className={`cv-todo-item cv-todo-item--${item.status}`}>
            <span className="cv-todo-icon">{TODO_STATUS_ICON[item.status] ?? '○'}</span>
            <span className="cv-todo-desc">{item.description}</span>
            {item.priority !== 'medium' && (
              <span className="cv-todo-priority">{item.priority}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="cv-tool-output cv-diff">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++')
          ? 'cv-diff-add'
          : line.startsWith('-') && !line.startsWith('---')
          ? 'cv-diff-remove'
          : line.startsWith('@@')
          ? 'cv-diff-hunk'
          : '';
        return <span key={i} className={cls}>{line}{'\n'}</span>;
      })}
    </pre>
  );
}

function CopyPath({ path, label }: { path: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button className="cv-copy-path" onClick={handleClick} title={`Copy path: ${path}`}>
      {copied ? 'copied' : label}
    </button>
  );
}

function getToolMeta(step: import('@kb-labs/agent-contracts').ToolUseStep): { badge?: string; summary?: string; filePath?: string } {
  const input = step.input as Record<string, unknown> | null | undefined;
  if (!input) { return {}; }

  const toolLower = step.toolName.toLowerCase();
  const isWrite = toolLower.includes('write') || toolLower.includes('patch') || toolLower.includes('edit');
  const isRead = toolLower.includes('read');

  const path = (input.path ?? input.filePath ?? input.file_path ?? input.file) as string | undefined;
  if (path) {
    const fileName = String(path).split('/').pop() ?? String(path);
    let badge: string | undefined;
    if (isRead) {
      const offset = input.offset ?? input.startLine ?? input.start_line;
      const limit = input.limit ?? input.endLine ?? input.end_line;
      if (offset !== undefined && limit !== undefined) { badge = `${offset}-${Number(offset) + Number(limit)}`; }
      else if (limit !== undefined) { badge = `${limit} lines`; }
    }
    return { summary: fileName, filePath: String(path), badge };
  }

  const query = (input.query ?? input.text ?? input.pattern ?? input.search) as string | undefined;
  if (query) { return { summary: String(query).slice(0, 100) }; }

  const command = (input.command ?? input.cmd) as string | undefined;
  if (command) { return { summary: String(command).slice(0, 100) }; }

  if (isWrite) { return {}; }

  const content = (input.content ?? input.message) as string | undefined;
  if (content) { return { summary: String(content).slice(0, 100) }; }

  return {};
}

function ToolRow({ step, isStreaming }: { step: import('@kb-labs/agent-contracts').ToolUseStep; isStreaming: boolean }) {
  const [open, setOpen] = React.useState(false);

  const isPending = step.status === 'pending';
  const isDone = step.status === 'done';
  const isError = step.status === 'error';
  const isFailed = isDone && step.success === false;

  const meta = getToolMeta(step);
  const hasDiff = isDone && !!step.metadata?.diff;
  const hasOutput = isDone && step.output != null;
  const input = step.input as Record<string, unknown> | null | undefined;
  const isWriteTool = /write|patch|edit/i.test(step.toolName);
  const hasWriteInput = isWriteTool && isDone && !!(input?.content ?? input?.new_content);
  const canExpand = hasOutput || hasDiff || hasWriteInput || isError;

  const dotClass = isPending
    ? (isStreaming ? 'cv-step-dot--pulse' : 'cv-step-dot--tool')
    : (isDone && !isFailed ? 'cv-step-dot--result-ok' : 'cv-step-dot--result-err');

  const m = step.metadata;
  const todoList = (isDone && m?.uiHint === 'todo' && m.structured != null)
    ? (m.structured as Record<string, unknown>).todoList as TodoListData | undefined
    : undefined;

  return (
    <div className="cv-step cv-step--tool">
      <div className={`cv-step-dot ${dotClass}`} />
      <div className="cv-step-body">
        <button
          className={`cv-tool-header${canExpand ? ' cv-tool-header--clickable' : ''}`}
          onClick={() => canExpand && setOpen((v) => !v)}
          disabled={!canExpand}
        >
          <span className="cv-tool-name">{formatToolName(step.toolName)}</span>
          {meta.badge && <span className="cv-tool-badge">{meta.badge}</span>}
          {isDone && m?.resultCount !== undefined && <span className="cv-tool-badge">{m.resultCount} results</span>}
          {isDone && m?.confidence !== undefined && <span className="cv-tool-badge">{Math.round(m.confidence * 100)}%</span>}
          {isDone && m?.exitCode !== undefined && m.exitCode !== 0 && <span className="cv-tool-badge cv-tool-badge--err">exit {m.exitCode}</span>}
          {isDone && (m?.linesAdded !== undefined || m?.linesRemoved !== undefined) && (
            <span className="cv-tool-badge cv-tool-badge--diff">
              {m?.linesAdded != null && m.linesAdded > 0 ? `+${m.linesAdded}` : ''}
              {m?.linesRemoved != null && m.linesRemoved > 0 ? ` -${m.linesRemoved}` : ''}
            </span>
          )}
          {!isPending && step.durationMs !== undefined && <span className="cv-step-duration">{step.durationMs}ms</span>}
          {canExpand && <span className="cv-tool-toggle">{open ? 'collapse' : 'expand'}</span>}
        </button>

        {meta.summary && (
          <p className="cv-tool-summary">
            {meta.filePath
              ? <CopyPath path={meta.filePath} label={meta.summary} />
              : meta.summary}
          </p>
        )}

        {todoList != null && <TodoView todoList={todoList} />}

        {isError && step.error && <p className="cv-step-error-text">{step.error}</p>}
        {isFailed && !open && step.output != null && <p className="cv-step-error-text">{String(step.output)}</p>}

        {open && (
          <div className="cv-tool-details">
            <ToolDetails step={step} hasDiff={hasDiff} hasOutput={hasOutput} />
          </div>
        )}
      </div>
    </div>
  );
}

function formatToolName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[_-]/g, ' ');
  if (normalized.includes('fs read') || normalized.includes('read file')) { return 'Read'; }
  if (normalized.includes('fs write') || normalized.includes('write file')) { return 'Write'; }
  if (normalized.includes('fs patch') || normalized.includes('patch file')) { return 'Edit'; }
  if (normalized.includes('fs edit') || normalized.includes('edit file')) { return 'Edit'; }
  if (normalized.includes('fs delete') || normalized.includes('delete file') || normalized.includes('remove file')) { return 'Delete'; }
  if (normalized.includes('fs list') || normalized.includes('list files') || normalized.includes('glob')) { return 'Glob'; }
  if (normalized.includes('grep') || normalized.includes('search content')) { return 'Grep'; }
  if (normalized.includes('bash') || normalized.includes('exec') || normalized.includes('shell') || normalized.includes('run command')) { return 'Bash'; }
  if (normalized.includes('rag') || normalized.includes('mind')) { return 'Mind'; }
  if (normalized.includes('todo')) { return 'TodoWrite'; }

  const colonIdx = name.indexOf(':');
  const base = colonIdx >= 0 ? name.slice(colonIdx + 1) : name;
  return base
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isNoisyThinking(content: string): boolean {
  const t = content.trim().toLowerCase();
  if (t === '[executing tools...]' || t === '[thinking...]' || t === '[planning...]' || t === '[analyzing...]') { return true; }
  if (t === 'analyzing context and choosing the next step.') { return true; }
  if (t.startsWith('checking facts with tool:') || t.startsWith('running step with tool:') || t.startsWith('running the next step')) { return true; }
  if (t === 'done.' || t === 'ok.' || t === 'done' || t === 'ok') { return true; }
  return false;
}

function isInternalProgressText(content: string): boolean {
  return isNoisyThinking(content);
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') { return output.slice(0, 2000); }
  try { return JSON.stringify(output, null, 2).slice(0, 2000); }
  catch { return String(output).slice(0, 2000); }
}
