/**
 * AgentSDK — composable builder + IAgentSDK interface for mocking in tests.
 *
 * Usage:
 *   import { AgentSDK } from '@kb-labs/agent-sdk';
 *   import { CoreToolPack, PromptInjectionGuard } from '@kb-labs/agent-core';
 *
 *   const agent = new AgentSDK()
 *     .withProfile({ id: 'default', role: 'orchestrator' })
 *     .register(new CoreToolPack())
 *     .addGuard(new PromptInjectionGuard())
 *     .use(new AuditMiddleware());
 *
 * extend() returns a deep clone — changes never affect the original:
 *   const subAgent = agent.extend().withProfile(atomicProfile);
 *
 * createRunner() is implemented by agent-core (injected via AgentSDK.setRunnerFactory()).
 * agent-sdk itself has no runtime dependency on agent-core.
 */

import type { AgentConfig, ToolPack } from '@kb-labs/agent-contracts';
import type { AgentMiddleware } from './middleware.js';
import type { AgentTracer, TraceLevel } from './tracer.js';
import type { AgentMode } from './mode.js';
import type { AgentMemory } from './memory.js';
import type { AgentProfile } from './profile.js';
import type { ExecutionLoop } from './loop.js';
import type { ContextStrategy } from './context-strategy.js';
import type { AgentErrorHandler } from './error-handler.js';
import type { StopCondition } from './stop-condition.js';
import type { OutputProcessor } from './output-processor.js';
import type { ToolGuard } from './guard.js';
import type { InputNormalizer } from './input-normalizer.js';
import type { TaskResult } from '@kb-labs/agent-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// IAgentRunner — the executable unit produced by sdk.createRunner()
// ─────────────────────────────────────────────────────────────────────────────

export interface IAgentRunner {
  readonly agentId: string;
  execute(task: string): Promise<TaskResult>;
  requestStop(): void;
  injectUserContext(message: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunnerFactory — injected by agent-core to break circular dep
// ─────────────────────────────────────────────────────────────────────────────

export type RunnerFactory = (config: AgentConfig, sdk: AgentSDK) => IAgentRunner;

// ─────────────────────────────────────────────────────────────────────────────
// IAgentSDK — interface for mocking in tests
// ─────────────────────────────────────────────────────────────────────────────

export interface IAgentSDK {
  use(middleware: AgentMiddleware): IAgentSDK;
  register(pack: ToolPack): IAgentSDK;
  withTracer(tracer: AgentTracer, level?: TraceLevel): IAgentSDK;
  withMode(mode: AgentMode): IAgentSDK;
  withMemory(memory: AgentMemory): IAgentSDK;
  withProfile(profile: AgentProfile): IAgentSDK;
  withLoop(loop: ExecutionLoop): IAgentSDK;
  withContextStrategy(strategy: ContextStrategy): IAgentSDK;
  withErrorHandler(handler: AgentErrorHandler): IAgentSDK;
  addStopCondition(condition: StopCondition): IAgentSDK;
  addOutputProcessor(processor: OutputProcessor): IAgentSDK;
  addGuard(guard: ToolGuard): IAgentSDK;
  addInputNormalizer(normalizer: InputNormalizer): IAgentSDK;
  extend(): IAgentSDK;
  createRunner(config: AgentConfig): IAgentRunner;
}

// ─────────────────────────────────────────────────────────────────────────────
// SdkState — internal snapshot (private, not exported)
// ─────────────────────────────────────────────────────────────────────────────

interface SdkState {
  middlewares: AgentMiddleware[];
  packs: ToolPack[];
  tracer: AgentTracer | null;
  traceLevel: TraceLevel;
  modes: AgentMode[];
  memory: AgentMemory | null;
  profile: AgentProfile | null;
  loop: ExecutionLoop | null;
  contextStrategy: ContextStrategy | null;
  errorHandler: AgentErrorHandler | null;
  stopConditions: StopCondition[];
  outputProcessors: OutputProcessor[];
  guards: ToolGuard[];
  inputNormalizers: InputNormalizer[];
}

function emptyState(): SdkState {
  return {
    middlewares: [],
    packs: [],
    tracer: null,
    traceLevel: 'normal',
    modes: [],
    memory: null,
    profile: null,
    loop: null,
    contextStrategy: null,
    errorHandler: null,
    stopConditions: [],
    outputProcessors: [],
    guards: [],
    inputNormalizers: [],
  };
}

function cloneState(s: SdkState): SdkState {
  return {
    middlewares: [...s.middlewares],
    packs: [...s.packs],
    tracer: s.tracer,
    traceLevel: s.traceLevel,
    modes: [...s.modes],
    memory: s.memory,
    profile: s.profile,
    loop: s.loop,
    contextStrategy: s.contextStrategy,
    errorHandler: s.errorHandler,
    stopConditions: [...s.stopConditions],
    outputProcessors: [...s.outputProcessors],
    guards: [...s.guards],
    inputNormalizers: [...s.inputNormalizers],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentSDK — concrete class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module-level runner factory — injected once by agent-core at startup.
 * agent-sdk itself has no runtime dependency on agent-core.
 *
 * @example (in agent-core's entry point):
 *   AgentSDK.setRunnerFactory((config, sdk) => new AgentRunner(config, sdk));
 */
let _runnerFactory: RunnerFactory | null = null;

export class AgentSDK implements IAgentSDK {
  private readonly _state: SdkState;

  constructor(state?: SdkState) {
    this._state = state ?? emptyState();
  }

  // ── Static factory injection ────────────────────────────────────────────

  static setRunnerFactory(factory: RunnerFactory): void {
    _runnerFactory = factory;
  }

  // ── Extension points ────────────────────────────────────────────────────

  use(middleware: AgentMiddleware): this {
    this._state.middlewares.push(middleware);
    return this;
  }

  register(pack: ToolPack): this {
    this._state.packs.push(pack);
    return this;
  }

  withTracer(tracer: AgentTracer, level: TraceLevel = 'normal'): this {
    this._state.tracer = tracer;
    this._state.traceLevel = level;
    return this;
  }

  withMode(mode: AgentMode): this {
    this._state.modes.push(mode);
    return this;
  }

  withMemory(memory: AgentMemory): this {
    this._state.memory = memory;
    return this;
  }

  withProfile(profile: AgentProfile): this {
    this._state.profile = profile;
    return this;
  }

  withLoop(loop: ExecutionLoop): this {
    this._state.loop = loop;
    return this;
  }

  withContextStrategy(strategy: ContextStrategy): this {
    this._state.contextStrategy = strategy;
    return this;
  }

  withErrorHandler(handler: AgentErrorHandler): this {
    this._state.errorHandler = handler;
    return this;
  }

  addStopCondition(condition: StopCondition): this {
    this._state.stopConditions.push(condition);
    return this;
  }

  addOutputProcessor(processor: OutputProcessor): this {
    this._state.outputProcessors.push(processor);
    return this;
  }

  addGuard(guard: ToolGuard): this {
    this._state.guards.push(guard);
    return this;
  }

  addInputNormalizer(normalizer: InputNormalizer): this {
    this._state.inputNormalizers.push(normalizer);
    return this;
  }

  // ── Clone ───────────────────────────────────────────────────────────────

  extend(): AgentSDK {
    return new AgentSDK(cloneState(this._state));
  }

  // ── Read-only access for agent-core ─────────────────────────────────────

  get middlewares(): ReadonlyArray<AgentMiddleware>    { return this._state.middlewares; }
  get packs(): ReadonlyArray<ToolPack>                 { return this._state.packs; }
  get tracer(): AgentTracer | null                     { return this._state.tracer; }
  get traceLevel(): TraceLevel                         { return this._state.traceLevel; }
  get modes(): ReadonlyArray<AgentMode>                { return this._state.modes; }
  get memory(): AgentMemory | null                     { return this._state.memory; }
  get profile(): AgentProfile | null                   { return this._state.profile; }
  get loop(): ExecutionLoop | null                     { return this._state.loop; }
  get contextStrategy(): ContextStrategy | null        { return this._state.contextStrategy; }
  get errorHandler(): AgentErrorHandler | null         { return this._state.errorHandler; }
  get stopConditions(): ReadonlyArray<StopCondition>   { return this._state.stopConditions; }
  get outputProcessors(): ReadonlyArray<OutputProcessor> { return this._state.outputProcessors; }
  get guards(): ReadonlyArray<ToolGuard>               { return this._state.guards; }
  get inputNormalizers(): ReadonlyArray<InputNormalizer> { return this._state.inputNormalizers; }

  // ── Build ───────────────────────────────────────────────────────────────

  createRunner(config: AgentConfig): IAgentRunner {
    if (!_runnerFactory) {
      throw new Error(
        'No runner factory registered. Call AgentSDK.setRunnerFactory() from agent-core before createRunner().',
      );
    }
    return _runnerFactory(config, this);
  }
}
