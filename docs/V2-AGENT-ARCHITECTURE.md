# V2 Agent Architecture: "Руководитель + Специалисты"

**Date:** 2026-01-18
**Status:** Planning
**Author:** KB Labs Team

---

## 1. Философия V2

### Текущая модель (V1) - "Orchestrator + Тупые исполнители"

```
Orchestrator (умный) → Agent (тупой исполнитель с tools)
```

- Agents = просто wrapper над tools
- mind-specialist просто дергает mind:rag-query
- Нет глубокого понимания домена
- Каждый agent начинает с нуля

### Новая модель (V2) - "Руководитель + Умные специалисты"

```
Бизнес (пользователь)
    ↓ задача
Руководитель разработки (Orchestrator)
    │
    ├── Frontend-специалист (знает React, CSS, компоненты)
    ├── Backend-специалист (знает API, базы, архитектуру)
    ├── Тестировщик (знает как писать тесты, что покрывать)
    ├── DevOps (знает CI/CD, деплой, инфру)
    └── Code Reviewer (знает паттерны, best practices)
```

**Ключевое отличие:**
- V1: Agents = тупые исполнители с tools
- V2: Agents = **эксперты с глубоким контекстом** (знают архитектуру, паттерны, историю)

---

## 2. Что делает специалиста специалистом?

1. **Глубокий контекст домена** - system prompt с архитектурой, паттернами, conventions
2. **Знание кодовой базы** - какие файлы за что отвечают, где что лежит
3. **Примеры из прошлого** - как похожие задачи решались раньше
4. **Свои tools** - специфичные для его области
5. **Свой стиль работы** - как декомпозирует задачи, что проверяет

---

## 3. Текущая архитектура (V1) - Для справки

### 3.1 Пакеты в kb-labs-agents

```
kb-labs-agents/packages/
├── agent-contracts/     # Типы, интерфейсы, Zod-схемы
├── agent-core/          # Ядро: AgentExecutor, tools, planning
├── agent-cli/           # CLI команды (agent:run, agent:list)
├── adaptive-orchestrator/  # Старый план-then-execute orchestrator
├── iterative-orchestrator/ # Новый think-delegate-evaluate loop
├── progress-reporter/   # Reporting utilities
└── task-classifier/     # LLM-based task classification
```

### 3.2 Компоненты AgentExecutor (agent-core)

```
AgentExecutor
├── ReActPromptBuilder      # Строит промпты по task type
├── TaskClassifier          # Классифицирует задачи (cached)
├── ReActParser            # Парсит **Thought:**/**Action:** из текста
├── ToolExecutor           # Выполняет tools (fs:*, shell:*, plugin:*)
├── ToolDiscoverer         # Находит tools из manifests
├── ContextCompressor      # Сжимает контекст через LLM
├── ExecutionMemory        # Хранит findings для переиспользования
├── ProgressTracker        # Оценивает прогресс через LLM
├── ErrorRecovery          # Генерирует recovery strategies
└── LoopDetector           # Детектирует повторяющиеся паттерны
```

### 3.3 Текущий флоу выполнения

```
Task → TaskClassifier → ReActPromptBuilder → Agent Loop:
┌─────────────────────────────────────────────────────────┐
│ Step N:                                                 │
│  1. Check context compression (>5 messages)             │
│  2. Build prompt with ExecutionMemory                   │
│  3. Call LLM (chatWithTools)                           │
│  4. IF forced reasoning step → skip tools, reflect     │
│  5. ELSE → extract tool calls (native + text parsing)  │
│  6. Execute tools via ToolExecutor                     │
│  7. Extract findings → ExecutionMemory                 │
│  8. Check ProgressTracker (isStuck?)                   │
│  9. Check LoopDetector (loop detected?)                │
│ 10. IF stuck/loop → ErrorRecovery (generate strategy)  │
│ 11. Check termination signals                          │
└─────────────────────────────────────────────────────────┘
```

### 3.4 LLM Adapter архитектура

```
Plugin → useLLM({ tier }) → LLMRouter → ILLM Adapter → Provider

Tiers:
- small  → user-configured (e.g., gpt-4o-mini)
- medium → user-configured (e.g., claude-sonnet)
- large  → user-configured (e.g., claude-opus)
```

**Доступные адаптеры:**
- `adapters-openai` - OpenAI API (GPT-4o, GPT-4o-mini)
- `adapters-vibeproxy` - Любые модели через локальный прокси (Claude, GPT, Llama, etc.)

**Интерфейс ILLM:**
```typescript
interface ILLM {
  complete(prompt: string, options?: LLMOptions): Promise<LLMResponse>;
  stream(prompt: string, options?: LLMOptions): AsyncIterable<string>;
  chatWithTools(messages: LLMMessage[], options: LLMToolCallOptions): Promise<LLMToolCallResponse>;
}
```

---

## 4. Проблемы V1 (Pain Points)

### 4.1 Forced Reasoning = 2x шагов

**Проблема:** После каждого tool call - принудительный reasoning step без tools.

**Причина:** Без этого LLM спамит tools не анализируя результаты.

**Цена:** 2x шагов, 2x латентность, 2x tokens.

### 4.2 Медленное выполнение

**Пример:** 4.5 минуты на простой вопрос "What is ProgressTracker?"

**Причины:**
- Много шагов (10 max per agent)
- Spawn subprocess для plugin tools (`pnpm kb mind:rag-query`)
- Mind RAG сам медленный (10-30s per query)
- Forced reasoning удваивает шаги

### 4.3 High token usage

**Пример:** 67k tokens на простой вопрос.

**Причины:**
- Каждый шаг = полный контекст
- ContextCompressor помогает, но не идеально
- Tool outputs могут быть большими

### 4.4 Orchestrator → Agent gap

**Проблема:** Orchestrator делегирует задачу, Agent делает много лишних шагов.

**Причина:** Agent не знает что orchestrator уже делал, начинает с нуля.

### 4.5 No streaming

**Проблема:** Пользователь ждет минуты без feedback.

**Причина:** Batch execution, нет SSE/WebSocket интеграции.

### 4.6 Agents = тупые исполнители

**Проблема:** Agents не имеют глубокого контекста домена.

**Причина:** Только tools + generic prompt, нет специализации.

---

## 5. Сильные стороны V1 (что сохранить)

✅ **Vendor-agnostic tier system** - useLLM({ tier: 'small' })
✅ **Multi-adapter architecture** - можно использовать OpenAI + Claude одновременно
✅ **Context compression** - 97% token reduction
✅ **Execution memory** - prevents redundant tool calls
✅ **Loop detection** - prevents infinite loops
✅ **Error recovery strategies** - LLM-based recovery suggestions
✅ **Tool discovery** - automatic from plugin manifests
✅ **ReAct pattern** - structured thinking

---

## 6. ADRs агентной системы (для справки)

### ADR-0001: Hybrid ReAct Tool Execution

**Проблема:** Agent не вызывал tools proactively.

**Решение:**
1. Task Classification (LLM + cache)
2. ReAct Pattern Prompting (Thought → Action → Observation)
3. Text Parsing Fallback (extract tools from text when native fails)

**Результат:** 0% → 100% proactive tool usage.

### ADR-0002: Context Compression

**Проблема:** 148K tokens на простой вопрос (context explosion).

**Решение:** LLM-based summarization после 5 messages.

**Результат:** 97% token reduction (148K → 4.8K).

### ADR-0003: Execution Memory

**Проблема:** Agent re-reads same files, re-calls same tools.

**Решение:** Track findings, inject into prompt, prevent redundant calls.

**Структура:**
```typescript
interface Finding {
  tool: string;
  query: string;
  fact: string;
  step: number;
  success: boolean;
  filePath?: string;
}
```

### ADR-0004: Progress Tracking

**Проблема:** No way to detect if agent is stuck.

**Решение:** LLM-based progress estimation after each step.

```typescript
interface ProgressEstimate {
  progressPercent: number;
  reasoning: string;
  nextMilestone: string;
  blockers: string[];
  isStuck: boolean;
}
```

### ADR-0005: Adaptive Error Recovery

**Проблема:** Agent detected stuck state but couldn't recover.

**Решение:** LLM generates recovery strategies.

```typescript
type RecoveryStrategyType =
  | 'retry'
  | 'alternative-tool'
  | 'parameter-adjustment'
  | 'escalate'
  | 'give-up';
```

---

## 7. Вопросы для проработки V2

### 7.1 Откуда специалист получает свой "глубокий контекст"?

**Вариант A:** Статичный system prompt (написанный руками)
- Pros: Полный контроль, предсказуемо
- Cons: Нужно поддерживать вручную, может устареть

**Вариант B:** Динамический контекст из Mind RAG (подгружает релевантные docs/code)
- Pros: Всегда актуальный, автоматический
- Cons: Зависит от качества RAG, дополнительная латентность

**Вариант C:** Комбинация: база + динамическое обогащение
- Pros: Лучшее из обоих миров
- Cons: Сложнее в реализации

### 7.2 Как специалист "помнит" между задачами?

**Вариант A:** Сессионная память (в рамках одной сессии)
- ExecutionMemory уже есть
- Теряется между сессиями

**Вариант B:** Персистентная память (между сессиями)
- Нужен storage (файлы, DB)
- Сложнее управлять

**Вариант C:** Нет памяти (каждый раз с нуля, но с богатым контекстом)
- Проще в реализации
- Контекст компенсирует отсутствие памяти

### 7.3 Сколько специалистов нужно на старте?

Для kb-labs примерный список:

| Специалист | Домен | Tools |
|------------|-------|-------|
| **Codebase Expert** | Архитектура, где что лежит | mind:rag-query, fs:read, fs:search |
| **Mind/RAG Specialist** | Поиск, индексация, векторы | mind:*, fs:read |
| **Plugin Developer** | Plugin system, manifests, SDK | fs:*, shell:exec |
| **Test Writer** | Как писать тесты в проекте | fs:*, shell:exec (vitest) |
| **DevKit Expert** | DevKit команды, CI checks | devkit:*, shell:exec |

### 7.4 Как Orchestrator решает кому делегировать?

**Вариант A:** По явному описанию задачи
- "напиши тест" → Test Writer
- "найди где" → Codebase Expert

**Вариант B:** По анализу задачи LLM
- Orchestrator анализирует и выбирает

**Вариант C:** По capabilities
- Задача требует fs:write → кто умеет писать файлы

---

## 8. Черновик V2 флоу

```
User: "Добавь тесты для ProgressTracker"
         ↓
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATOR                                           │
│                                                         │
│  Анализирует задачу:                                    │
│  - Нужно понять что такое ProgressTracker              │
│  - Нужно понять как писать тесты в проекте             │
│  - Нужно написать тесты                                │
│                                                         │
│  Решение: Делегировать Codebase Expert                 │
│  Подзадача: "Найди ProgressTracker и его зависимости"  │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  CODEBASE EXPERT (специалист)                           │
│                                                         │
│  Контекст:                                              │
│  - Знает структуру kb-labs-agents                      │
│  - Знает где искать executor код                       │
│  - Знает паттерны именования                           │
│                                                         │
│  Выполняет:                                             │
│  1. mind:rag-query → находит файл                      │
│  2. fs:read → читает implementation                    │
│                                                         │
│  Возвращает: Структурированный ответ с фактами         │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATOR                                           │
│                                                         │
│  Получил: ProgressTracker в progress-tracker.ts        │
│  Зависимости: ExecutionMemory, AgentExecutionStep      │
│                                                         │
│  Решение: Делегировать Test Writer                     │
│  Подзадача: "Напиши тесты для ProgressTracker"         │
│  Контекст: [передает findings от Codebase Expert]      │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  TEST WRITER (специалист)                               │
│                                                         │
│  Контекст:                                              │
│  - Знает vitest patterns в проекте                     │
│  - Знает как мокать LLM                                │
│  - Знает структуру тестов                              │
│  + Findings от Codebase Expert                         │
│                                                         │
│  Выполняет:                                             │
│  1. fs:read existing tests → понять стиль              │
│  2. fs:write → создает тест файл                       │
│  3. shell:exec vitest → проверяет                      │
│                                                         │
│  Возвращает: Путь к созданным тестам + результат       │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATOR                                           │
│                                                         │
│  Проверяет: Тесты созданы? Проходят?                   │
│  Решение: COMPLETE                                      │
│  Ответ пользователю: "Созданы тесты в ..."             │
└─────────────────────────────────────────────────────────┘
```

---

## 9. Технические решения (TODO)

### 9.1 Формат определения специалиста

```yaml
# .kb/specialists/codebase-expert.yml
schema: kb.specialist/1
id: codebase-expert
name: "Codebase Expert"
description: "Knows project architecture and where things are located"

# LLM настройки
llm:
  tier: small  # Дешевая модель для простых задач
  temperature: 0.3

# Глубокий контекст (статичный)
context:
  system: |
    You are a Codebase Expert for KB Labs monorepo.

    ## Project Structure
    - kb-labs-agents/ - Agent system (executor, orchestrator)
    - kb-labs-mind/ - RAG and semantic search
    - kb-labs-core/ - Platform core (adapters, runtime)
    ...

    ## Your Expertise
    - Know where every component is located
    - Understand dependencies between packages
    - Can quickly find relevant code

  # Динамическое обогащение
  rag:
    enabled: true
    scope: "architecture"
    maxChunks: 5

# Доступные tools
tools:
  - mind:rag-query
  - fs:read
  - fs:search
  - fs:list

# Как отвечать
output:
  format: structured
  schema:
    files: string[]
    summary: string
    dependencies: string[]
```

### 9.2 Shared Session State (Blackboard Pattern)

**Проблема "испорченного телефона":** Если Orchestrator передает findings от Researcher к Implementer, информация может потеряться при сжатии.

**Решение:** Shared Session State — общая "доска", куда специалисты пишут и читают напрямую.

#### 9.2.1 Проблема: Token Explosion

**Наивный подход взорвёт контекст:**
```
Researcher записал 5 artifacts (код, факты, файлы) → ~3-5K tokens
Orchestrator читает SessionState → +3-5K tokens
Implementer получает SessionState + свой контекст → +3-5K tokens + history
```

**Worst case:** Каждый специалист накапливает artifacts → экспоненциальный рост.

#### 9.2.2 Решение: Hybrid Lazy-Loading SessionState

**Принцип:** Храним метаданные inline, полные данные — по требованию.

```typescript
interface SessionState {
  id: string;
  task: string;

  // ═══════════════════════════════════════════════════════════
  // INLINE (всегда в контексте) — ~800-1200 tokens max
  // ═══════════════════════════════════════════════════════════

  // Критичные решения (max 5, короткие строки)
  keyDecisions: string[];

  // Текущая цель
  currentGoal: string;

  // Что блокирует прогресс
  blockers: string[];

  // Сжатая история (LLM summarization)
  historySummary: string;

  // ═══════════════════════════════════════════════════════════
  // LAZY (только метаданные, загружаются по требованию)
  // ═══════════════════════════════════════════════════════════

  // Артефакты — только preview + ссылка на полные данные
  artifacts: ArtifactRef[];

  // ═══════════════════════════════════════════════════════════
  // METRICS
  // ═══════════════════════════════════════════════════════════
  history: SpecialistRun[];
  totalTokens: number;
  totalCostUsd: number;
}

interface ArtifactRef {
  id: string;
  type: 'code_snippet' | 'file_path' | 'fact' | 'decision' | 'error_log' | 'test_result';

  // Preview для Orchestrator (первые 100-200 chars)
  preview: string;

  // Размер полного контента (для budget decisions)
  tokens: number;

  // Где лежит полный контент
  storageKey: string;  // State Broker key или file path

  // Metadata
  createdBy: string;   // specialist id
  createdAt: Date;
}
```

#### 9.2.3 Storage Backend

**Используем платформенный кэш** (`platform.cache` / `useCache()` composable):

```typescript
import { useCache } from '@kb-labs/sdk';

// В SessionStateManager
const cache = useCache();

// Сохранить artifact
await cache.set(`session:${sessionId}:artifact:${artifactId}`, content, {
  ttl: 3600 * 1000,  // 1 час
});

// Загрузить artifact
const content = await cache.get(`session:${sessionId}:artifact:${artifactId}`);
```

**Преимущества:**
- ✅ Уже есть в платформе (не нужен отдельный State Broker)
- ✅ TTL auto-cleanup (1 час default)
- ✅ Работает in-memory или с персистентным backend
- ✅ Композабл паттерн (`useCache()`)

**Fallback для больших artifacts (>10KB):**
- Путь: `.kb/session/{sessionId}/artifacts/{artifactId}.json`
- Manual cleanup при `session.end()`

#### 9.2.4 Flow с Lazy Loading

```
┌─────────────────────────────────────────────────────────────┐
│  RESEARCHER завершил работу                                 │
│                                                             │
│  Записывает в SessionState:                                 │
│  - keyDecisions: ["Используем vitest"]                     │
│  - artifacts: [                                             │
│      { id: "a1", preview: "class ProgressTracker {...",    │
│        tokens: 450, storageKey: "session:123:a1" }         │
│    ]                                                        │
│  - Полный код сохранён в platform.cache по ключу           │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR читает SessionState                           │
│                                                             │
│  Видит (~1K tokens):                                        │
│  - keyDecisions: ["Используем vitest"]                     │
│  - currentGoal: "Написать тесты для ProgressTracker"       │
│  - artifacts: [                                             │
│      { id: "a1", preview: "class ProgressTracker {...",    │
│        tokens: 450 }   ← видит только preview!             │
│    ]                                                        │
│                                                             │
│  Решение: Делегировать Implementer                         │
│  includeArtifacts: ["a1"]  ← явно указывает что нужно      │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  IMPLEMENTER получает задачу                                │
│                                                             │
│  Input:                                                     │
│  - task: "Напиши тесты для ProgressTracker"                │
│  - includeArtifacts: ["a1"]                                │
│                                                             │
│  Перед стартом:                                             │
│  1. Загружает artifact "a1" из platform.cache              │
│  2. Получает полный код (450 tokens)                       │
│  3. Начинает работу с полным контекстом                    │
└─────────────────────────────────────────────────────────────┘
```

#### 9.2.5 API для работы с artifacts

```typescript
interface SessionStateManager {
  // Создать artifact (specialist вызывает после работы)
  createArtifact(artifact: {
    type: ArtifactType;
    content: unknown;
    preview?: string;  // Auto-generated if not provided
  }): Promise<ArtifactRef>;

  // Загрузить полный artifact (lazy load)
  getArtifact(id: string): Promise<SessionArtifact>;

  // Загрузить несколько artifacts
  getArtifacts(ids: string[]): Promise<SessionArtifact[]>;

  // Получить текущий state (только inline + refs)
  getState(): SessionState;

  // Обновить inline поля
  updateDecisions(decisions: string[]): void;
  updateGoal(goal: string): void;
  addBlocker(blocker: string): void;
}
```

#### 9.2.6 Гарантии по токенам

| Компонент | Max Tokens | Описание |
|-----------|------------|----------|
| `keyDecisions` | ~200 | Max 5 × ~40 chars |
| `currentGoal` | ~50 | Одна строка |
| `blockers` | ~150 | Max 3 × ~50 chars |
| `historySummary` | ~500 | LLM-compressed |
| `artifacts` (refs) | ~300 | Max 10 × ~30 chars preview |
| **Total inline** | **~1200** | Фиксированный размер |

**Полные artifacts загружаются отдельно** и добавляются к контексту специалиста только когда нужны.

#### 9.2.7 Сравнение подходов

| Подход | Tokens | Потеря данных | Сложность |
|--------|--------|---------------|-----------|
| Naive (всё inline) | Неконтролируемый | Нет | Низкая |
| Importance-based pruning | Неконтролируемый | Высокая | Низкая |
| Rolling window + summarization | ~2-3K fixed | Средняя | Средняя |
| **Hybrid lazy-loading** | **~1.2K fixed** | **Минимальная** | Средняя |

**Flow с Session State:**
```
Researcher → записывает artifacts в SessionState (preview + storage)
Orchestrator → читает SessionState (только previews, ~1K tokens)
Orchestrator → решает какие artifacts нужны Implementer
Implementer → загружает нужные artifacts (lazy load)
Implementer → работает с полным контекстом
```

### 9.3 Handoff Contract

```typescript
interface SpecialistResult {
  specialistId: string;
  task: string;
  success: boolean;

  // Записывается в SessionState
  artifacts: SessionArtifact[];

  // Рекомендации для Orchestrator
  handoff?: {
    suggestedNext?: string;        // "implementer"
    constraints?: string[];        // "Не меняй API", "Используй Vitest"
    blockers?: string[];           // Что мешает продолжить
  };
}
```

### 9.3 Orchestrator prompt

```
You are a Tech Lead orchestrating a team of specialists.

## Your Team
{list of specialists with descriptions}

## Current Task
{user task}

## Execution History
{previous specialist results}

## Your Job
1. Break down the task into specialist assignments
2. Delegate to the RIGHT specialist (not yourself)
3. Pass relevant context from previous results
4. Decide when task is COMPLETE

## Rules
- ONE specialist at a time (not parallel for now)
- Pass findings to next specialist
- COMPLETE when user's goal is achieved
- ESCALATE if stuck or need clarification
```

---

## 10. Принятые решения (Design Decisions)

| # | Вопрос | Решение | Обоснование |
|---|--------|---------|-------------|
| 1 | Контекст специалиста | **Комбо: статичная база + Mind RAG** | База = принципы, паттерны. RAG = актуальный код |
| 2 | Память между задачами | **Сессионная (MVP), FAQ Post-MVP** | FAQ усложняет, Mind RAG достаточно для старта |
| 3 | Специалисты MVP | **Researcher + Implementer** | Миграция из существующих агентов |
| 4 | Выбор специалиста | **LLM анализ** | Хорошие описания, без сложных эвристик |
| 5 | Forced reasoning | **Configurable per specialist (default: 3)** | В YAML: `forcedReasoningInterval: 3` |
| 6 | SessionState токены | **Hybrid Lazy-Loading** | ~1.2K tokens fixed, данные по требованию (см. 9.2) |
| 7 | Artifact storage | **platform.cache / useCache()** | Платформенный кэш с TTL, FS fallback для >10KB |
| 8 | Session TTL | **1 час fixed + explicit end()** | Auto-cleanup через cache TTL |
| 9 | partial результат | **Сохранять в SessionState** | Следующий специалист может продолжить |
| 10 | historySummary | **После каждого specialist, small tier** | Сжатие истории для экономии токенов |

---

## 11. MVP Специалисты

### 11.1 Researcher (Read-Only)

**Роль:** Глаза команды. Ищет, читает, объясняет.

```yaml
# .kb/specialists/researcher.yml
schema: kb.specialist/1
id: researcher
name: "Researcher"

# LLM настройки
llm:
  tier: small
  temperature: 0.3
  maxTokens: 4096

# Лимиты выполнения
limits:
  maxSteps: 10
  maxToolCalls: 15
  timeoutMs: 120000
  forcedReasoningInterval: 3  # Reasoning step каждые N tool calls (default: 3)

capabilities:
  - Поиск кода через Mind RAG
  - Чтение файлов
  - Объяснение архитектуры
  - Анализ зависимостей

tools:
  - mind:rag-query
  - fs:read
  - fs:list
  - fs:search

constraints:
  - ❌ НЕ может писать файлы
  - ❌ НЕ может выполнять shell команды

# Structured I/O
input:
  schema:
    task: string           # Что нужно найти/понять
    context?: string       # Дополнительный контекст от Orchestrator

output:
  schema:
    files: string[]        # Найденные файлы
    facts: string[]        # Ключевые факты
    code?: Record<string, string>  # filename → snippet
    summary: string        # Краткое резюме
```

### 11.2 Implementer (Read + Write)

**Роль:** Руки команды. Пишет код, создает файлы.

```yaml
# .kb/specialists/implementer.yml
schema: kb.specialist/1
id: implementer
name: "Implementer"

llm:
  tier: medium
  temperature: 0.2
  maxTokens: 8192

limits:
  maxSteps: 15
  maxToolCalls: 20
  timeoutMs: 300000  # 5 min - может долго билдить
  forcedReasoningInterval: 5  # Implementer может делать больше подряд

capabilities:
  - Написание кода
  - Создание файлов
  - Редактирование существующего кода
  - Запуск команд (build, test)

tools:
  - fs:read
  - fs:write
  - fs:edit
  - shell:exec

constraints:
  - ⚠️ ТРЕБУЕТ контекст от Researcher перед работой
  - ⚠️ Не начинает с нуля - всегда получает findings

input:
  schema:
    task: string
    context: string          # ОБЯЗАТЕЛЬНО от Researcher
    files: string[]          # Какие файлы затрагиваем
    patterns?: string        # Паттерны кода из проекта

output:
  schema:
    created: string[]        # Созданные файлы
    modified: string[]       # Измененные файлы
    commands: string[]       # Выполненные команды
    testResult?: 'passed' | 'failed' | 'skipped'
    summary: string
```

### 11.3 FAQ Service (Knowledge Base)

**Роль:** Память команды. Сервис (не агент) для хранения знаний.

**Архитектура:** FAQ = коллекция в Mind RAG (не отдельный пакет)

```
Mind RAG Collections:
├── code      (read-only, индексируется из файлов)
├── docs      (read-only, индексируется из .md)
└── faq       (read/write, агенты пишут сюда)
```

**API:**
```typescript
// Orchestrator использует напрямую (без LLM)
mind.faqSearch(query: string): FAQEntry[]
mind.faqWrite(entry: FAQEntry): void
mind.faqDelete(id: string): void
mind.faqMarkHelpful(id: string): void
mind.faqMarkNotHelpful(id: string): void
```

**Структура записи:**
```typescript
interface FAQEntry {
  id: string;
  problem: string;
  solution: string;

  // Категория (для приоритизации при поиске)
  category: 'knowledge' | 'experience' | 'troubleshooting';
  // knowledge = факты о коде ("Модуль X в папке Y")
  // experience = как решали задачи ("Для тестов используем vi.mock")
  // troubleshooting = решения ошибок ("Ошибка X лечится командой Y")

  tags?: string[];
  relatedFiles?: string[];  // Для инвалидации при изменении

  stats: {
    retrievedCount: number;   // Сколько раз нашли
    helpfulCount: number;     // Сколько раз помогло
    notHelpfulCount: number;  // Сколько раз НЕ помогло
    lastUsedAt: Date;
  };

  createdAt: Date;
  createdBy: 'user' | 'orchestrator' | 'auto-learn';
}
```

**Инвалидация и очистка:**

| Триггер | Действие |
|---------|----------|
| helpRate < 20% (после 3+ использований) | Auto-delete |
| Не использовали 90 дней | Archive |
| Связанный файл изменился | Mark for review |
| User: "забудь про X" | Delete |
| User: "не помогло" | markNotHelpful |

**Garbage Collection:**
```typescript
// Запускать периодически (раз в неделю / при старте)
async function cleanupFAQ() {
  for (const entry of await faq.getAll()) {
    if (isGarbage(entry)) await faq.delete(entry.id);
    else if (isStale(entry)) await faq.archive(entry.id);
  }
}
```

---

## 12. Error Handling & Recovery

### 12.1 Контракт результата специалиста (SpecialistOutcome)

**Каждый specialist ОБЯЗАН вернуть один из двух вариантов:**

```typescript
type SpecialistOutcome =
  | { ok: true; result: SpecialistResult; meta: RunMeta }
  | { ok: false; failure: FailureReport; partial?: SpecialistResult; meta: RunMeta }

interface RunMeta {
  durationMs: number;
  tokenUsage: { prompt: number; completion: number };
  toolCalls: number;
  modelTier: 'small' | 'medium' | 'large';
  escalations: number;
}
```

**Важно:** При ошибке `partial` содержит то, что удалось сделать (не теряем работу).

### 12.2 FailureReport (структурированная ошибка)

```typescript
interface FailureReport {
  kind:
    | 'tool_error'      // Tool вернул ошибку
    | 'timeout'         // Превышен timeout
    | 'validation_failed' // Output не прошел валидацию
    | 'stuck'           // Loop detected / no progress
    | 'policy_denied'   // Нарушение constraints
    | 'unknown';

  message: string;
  hypothesis?: string;      // Почему не получилось (LLM анализ)
  lastToolCalls?: ToolCall[];
  suggestedNext?: RecoveryHint[];
}
```

### 12.3 RecoveryHint (подсказки для Orchestrator)

```typescript
interface RecoveryHint {
  action:
    | 'retry'              // Просто повторить
    | 'escalate_model'     // Использовать более мощную модель
    | 'change_strategy'    // Попробовать другой подход
    | 'switch_specialist'  // Передать другому специалисту
    | 'ask_user';          // Эскалация к пользователю

  note: string;            // Пояснение
}
```

### 12.4 Recovery Flow

```
Specialist failed?
    │
    ├── Retry (1 раз, тот же tier)
    │   └── Success? → Continue
    │
    ├── Escalate Model? (small → medium → large)
    │   └── Success? → Continue
    │
    ├── Change Strategy?
    │   └── Orchestrator выбирает альтернативный подход
    │
    ├── Switch Specialist?
    │   └── Другой специалист может справиться?
    │
    └── Ask User (финальная эскалация)
```

### 12.5 Escalation Policy (Лимиты стоимости)

```yaml
# В конфиге проекта .kb/kb.config.json
orchestrator:
  escalation:
    # Лимиты эскалации модели
    maxEscalationsPerSpecialist: 2
    maxLargeTierUsesPerRun: 3

    # Лимиты стоимости
    maxCostUsdPerRun: 1.00
    warnCostUsdThreshold: 0.50

    # Budget per specialist (% от общего)
    budgetAllocation:
      researcher: 30
      implementer: 60
      orchestrator: 10

    # Ladder по умолчанию
    defaultLadder:
      researcher: [small, medium]      # НЕ эскалируется до large
      implementer: [medium, large]
```

**Триггеры эскалации:**
| Триггер | Действие |
|---------|----------|
| validation_failed ×2 | escalate_model |
| stuck detected | change_strategy или escalate_model |
| critical timeout | escalate_model |
| unknown + high impact | ask_user |

### 12.6 Пример Recovery

```
Implementer: fs:write failed (permission denied)
    ↓
FailureReport:
  kind: tool_error
  message: "EACCES: permission denied"
  hypothesis: "Нет прав на запись в директорию"
  suggestedNext:
    - { action: 'ask_user', note: 'Запросить права доступа' }
    - { action: 'change_strategy', note: 'Записать в другую директорию' }
    ↓
Orchestrator: Выбирает ask_user (т.к. права критичны)
    ↓
Escalate: "Нет прав на запись в /path. Выполните: chmod +w /path"
```

---

## 13. Обновленный флоу V2

```
User: "Добавь тесты для ProgressTracker"
         ↓
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATOR (Tech Lead)                               │
│                                                         │
│  Команда:                                               │
│  - Researcher: searches, reads, explains (READ ONLY)   │
│  - Implementer: writes code (NEEDS CONTEXT FIRST)      │
│  - FAQ: knows common problems                          │
│                                                         │
│  Анализ: Нужно найти код, потом написать тест          │
│  Решение: Researcher → Implementer                     │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  RESEARCHER                                             │
│                                                         │
│  Контекст (статичный):                                  │
│  - Знает структуру kb-labs-agents                      │
│  - Знает где искать executor код                       │
│                                                         │
│  Контекст (динамический через Mind RAG):               │
│  - Актуальные примеры тестов                           │
│                                                         │
│  Действия:                                              │
│  1. mind:rag-query "ProgressTracker"                   │
│  2. fs:read найденный файл                             │
│  3. mind:rag-query "примеры тестов в agent-core"       │
│                                                         │
│  (forced reasoning после 3 tools)                      │
│                                                         │
│  Результат:                                             │
│  - files: [progress-tracker.ts]                        │
│  - facts: ["использует LLM для оценки прогресса"]     │
│  - test_pattern: "describe/it/expect, vi.mock LLM"    │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATOR                                           │
│                                                         │
│  Получил findings от Researcher                        │
│  Решение: Передать Implementer с контекстом            │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  IMPLEMENTER                                            │
│                                                         │
│  Получает:                                              │
│  - Задача: "Напиши тесты для ProgressTracker"          │
│  - Контекст от Researcher: файл, паттерн тестов        │
│                                                         │
│  Действия:                                              │
│  1. fs:read progress-tracker.ts (уточнить детали)      │
│  2. fs:write progress-tracker.test.ts                  │
│  3. shell:exec "pnpm vitest progress-tracker"          │
│                                                         │
│  (forced reasoning после 3 tools)                      │
│                                                         │
│  Результат:                                             │
│  - created: progress-tracker.test.ts                   │
│  - tests: PASSED                                       │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATOR                                           │
│                                                         │
│  Тесты созданы и прошли → COMPLETE                     │
│                                                         │
│  (Опционально) → FAQ: "Сохрани паттерн тестов для      │
│  executor компонентов"                                 │
└─────────────────────────────────────────────────────────┘
```

---

## 14. Финальный Roadmap

### Phase 1: Specialist Definition Format ⬅️ НАЧИНАЕМ ЗДЕСЬ
- [ ] YAML схема `kb.specialist/1` с `forcedReasoningInterval`
- [ ] Loader для .kb/specialists/
- [ ] Миграция mind-specialist → researcher
- [ ] Миграция coding-agent → implementer
- [ ] Unit тесты для loader

### Phase 2: Specialist Executor
- [ ] Executor с configurable `forcedReasoningInterval` (default: 3)
- [ ] Инъекция статичного контекста из YAML
- [ ] Динамическое обогащение через Mind RAG
- [ ] Structured output для findings
- [ ] historySummary compression (small tier, после каждого run)

### Phase 3: Context Handoff (Hybrid Lazy-Loading SessionState)
- [ ] `SessionStateManager` класс с lazy-loading API
- [ ] `ArtifactRef` с preview + storageKey
- [ ] **`useCache()` backend** для artifacts (TTL = 1 час)
- [ ] File System fallback для больших artifacts (>10KB)
- [ ] Auto-preview generation (первые 100-200 chars)
- [ ] Orchestrator: `includeArtifacts` в delegation task
- [ ] Specialist: загрузка artifacts перед стартом
- [ ] Token budget tracking (~1.2K inline max)
- [ ] `session.end()` для явного cleanup

### Phase 4: Orchestrator V2 ✅ COMPLETED (2026-01-18)

**Implemented:**
- [x] Smart task decomposition with LLM planning
- [x] Specialist selection with capability matching
- [x] Early stopping - LLM evaluates if task already solved (only when remaining ≥2)
- [x] Specialist cancellation - dynamic decision to skip remaining work
- [x] ToolTrace verification integration (placeholder for Phase 2)
- [x] Confidence-based decisions (all with confidence scores)
- [x] Single entry point (`orchestrator:run` only)
- [x] Cleaned up command architecture (removed `agent:run`, `specialist:run`)
- [x] **Fixed prompt** - Forces LLM to use ONLY real specialists from registry
- [x] **Optimization gating** - Smart checks only when remaining ≥2 tasks (avoids excess LLM calls)

**Test Results (After Improvements):**
- Simple task: 1 subtask, 100% success, 50.4s (3x faster than before)
- Complex task: 2 subtasks, 100% success, 252.4s
- Before fix: Used fake specialists ("researcher", "implementer" - not in registry)
- After fix: Uses real specialists from `.kb/agents/` directory
- ToolTrace: Creating traces for each specialist execution

**Files Modified:**
- `orchestrator-executor.ts` - Smart features + optimization gating + prompt fix
- `specialist-executor.ts` - Integrated ToolTrace
- `manifest.v3.ts` - Removed unused commands
- `delegateTask()` - Passes through traceRef

**Token Consumption Optimizations (2026-01-18):**

After analyzing production usage, implemented aggressive optimizations to reduce token consumption:

1. **Aggressive Tool Result Truncation:**
   - Problem: Single `fs:search` result consumed 77,997 prompt tokens
   - Solution: Truncate tool results to max 800 chars (~200 tokens)
   - Messages inform LLM: "truncated X chars to save ~Y tokens, full result in artifacts"
   - Impact: **96% reduction** on large tool results (78k → 3.4k tokens)

2. **Token-Aware Context Compression:**
   - Problem: Compression only triggered by message count (>5), not token size
   - Solution: Added `TOKEN_COMPRESSION_THRESHOLD = 8000`
   - Triggers on: `messages.length > 5 OR estimatedTokens > 8000`
   - Impact: Prevents context explosion even with few large messages

3. **Multiple Safety Fixes:**
   - Fixed: `Cannot read properties of undefined (reading 'length')` errors
   - Added: `m.content?.length ?? 0` for message token estimation
   - Added: `JSON.stringify(result.output ?? null) ?? ''` for tool output
   - Added: `rawOutput && rawOutput.length` check before truncation
   - Impact: **100% success rate** (was 67% with errors)

4. **Measured Results (Complex Tasks):**

   **Before optimizations:**
   - Max single call: 78,137 tokens (context explosion)
   - Total tokens (auth): 167,562 tokens
   - Success rate: 67% (undefined errors)
   - Cost: $0.025 per task

   **After optimizations:**
   - Max single call: 3,379 tokens (**96% reduction**)
   - Total tokens (auth): 27,824 tokens (**83% reduction**)
   - Total tokens (REST API): 306,111 tokens (larger task, 7 components)
   - Success rate: **100%** (no errors)
   - Cost: $0.0067-0.046 per task (**~75% cost reduction**)

   **Key benefits:**
   - Self-regulating: simple tasks unaffected, complex tasks optimized
   - No context explosion: max prompt stays under 4k tokens
   - Reliable: defensive null checks prevent crashes

**Known Issues:**
- Specialists can make too many tool calls (needs better prompts/timeouts)
- Early stopping not fully tested (need tasks with 3+ subtasks)
- No streaming progress yet

**Next Steps:**
- Phase 5 (Optimizations - streaming, parallel specialists)
- ADR-0002 (TaskVerifier - deep verification)
- Further specialist prompt improvements for efficiency

### Phase 5: Optimizations
- [ ] Streaming progress
- [ ] Parallel specialists (когда независимы)
- [ ] Caching specialist contexts
- [ ] Доменные специалисты (Agent Expert, Mind Expert, etc.)

### Phase 6: FAQ Service (Post-MVP)
- [ ] Добавить `faq` коллекцию в Mind RAG
- [ ] API: mind.faqSearch / faqWrite / faqDelete
- [ ] Feedback: markHelpful / markNotHelpful
- [ ] Stats tracking (retrievedCount, helpfulCount, etc.)
- [ ] Garbage collection (auto-delete низкий helpRate, archive stale)
- [ ] Инвалидация при изменении relatedFiles

### Phase 7: Self-Learning (Post-MVP)
- [ ] Orchestrator учится делегировать (track success/fail per specialist)
- [ ] Specialists учат project-specific паттерны
- [ ] Auto-save успешных решений в FAQ
- [ ] Валидация перед сохранением (только успешные паттерны)
- [ ] Project knowledge accumulation (.kb/learning/)

### Phase 8: Playbooks (Future)
- [ ] YAML схема для playbooks (kb.playbook/1)
- [ ] Playbook loader из .kb/playbooks/
- [ ] Playbook matcher (по triggers/patterns)
- [ ] Step executor с делегированием специалистам
- [ ] Передача контекста между шагами (step.output → next step.input)
- [ ] Параметризация ({{featureName}}, {{scope}})
- [ ] **Conditional steps** (ветвление по результату)
- [ ] Примеры playbooks:
  - [ ] add-feature.yml - добавление новой фичи
  - [ ] fix-bug.yml - исправление бага
  - [ ] add-test.yml - добавление тестов
  - [ ] refactor.yml - рефакторинг кода
  - [ ] review-pr.yml - code review

**Пример playbook:**
```yaml
# .kb/playbooks/add-feature.yml
schema: kb.playbook/1
id: add-feature
name: "Добавление новой фичи"

triggers:
  - "добавь фичу"
  - "реализуй функционал"
  - "implement feature"

params:
  - name: featureName
    required: true
    prompt: "Название фичи?"
  - name: scope
    required: false
    default: "."

steps:
  - id: research
    specialist: researcher
    task: "Найди похожие фичи в проекте и паттерны реализации для {{featureName}}"

  - id: plan
    specialist: researcher
    task: "Составь план реализации на основе найденных паттернов"
    input:
      context: "{{research.output}}"

  - id: implement
    specialist: implementer
    task: "Реализуй {{featureName}} по плану"
    input:
      context: "{{plan.output}}"
      files: "{{research.output.files}}"

  - id: test
    specialist: implementer
    task: "Добавь тесты для {{featureName}}"
    input:
      context: "{{implement.output}}"

  # Conditional step — выполняется только если тесты упали
  - id: debug
    condition: "{{test.output.testResult}} == 'failed'"
    specialist: researcher
    task: "Найди причину падения тестов"
    input:
      context: "{{test.output}}"

  - id: fix
    condition: "{{debug.output}}"
    specialist: implementer
    task: "Исправь код на основе анализа"
    input:
      context: "{{debug.output}}"
```

---

## 15. Non-Functional Requirements

| Категория | Требование | Метрика |
|-----------|------------|---------|
| **Cost** | Cheap-by-default | 80% задач на small tier |
| **Reliability** | No single-agent failure | Recovery в 95% случаев |
| **Debuggability** | Full execution trace | Каждый step логируется |
| **Explainability** | Deterministic recovery | RecoveryHint для каждой ошибки |
| **Extensibility** | New specialists без core rewrite | YAML-only добавление |
| **Latency** | Быстрый feedback | Streaming progress |
| **Vendor-agnostic** | Любой LLM провайдер | Через tier abstraction |

---

## 16. Ключевой принцип (ADR)

> **Агентная система — это не "умная модель", а управляемая система исполнения.**
> **Модели — расходник. Контроль — ценность.**

Это означает:
- ❌ Не полагаемся на "интеллект" модели
- ✅ Полагаемся на структуру, контракты, recovery
- ❌ claude.md — костыль
- ✅ Specialists + FAQ + Playbooks — фундамент

---

## 17. Scope разделение

### MVP (Phase 1-5)

**MUST:**
- [ ] Specialist YAML schema `kb.specialist/1` с `forcedReasoningInterval`
- [ ] Миграция существующих агентов (mind-specialist → researcher, coding-agent → implementer)
- [ ] Specialist Executor с configurable reasoning interval
- [ ] SessionStateManager с `useCache()` backend
- [ ] Hybrid Lazy-Loading (inline ~1.2K tokens + lazy artifacts)
- [ ] Orchestrator V2 с delegation и evaluation
- [ ] SpecialistOutcome + FailureReport контракты
- [ ] Model escalation (small → medium → large)
- [ ] Cost limits (maxCostUsdPerRun)

**SHOULD:**
- [ ] Streaming progress
- [ ] Partial results → сохранение в SessionState
- [ ] historySummary compression

### Post-MVP (Phase 6-8)

**NOT MVP:**
- [ ] FAQ Service в Mind RAG
- [ ] Self-learning orchestration
- [ ] Parallel specialists
- [ ] Auto-playbook matching (triggers)
- [ ] Domain specialists (Frontend, Backend, etc.)

---

## 18. Verification & Anti-Hallucination

### 18.1 Проблема

**V1 проблема:** Orchestrator доверяет словам specialist'а без проверки.

```typescript
// ❌ V1 - доверяем на слово
specialist: "Я создал файл test.ts"
orchestrator: "Отлично!" ✅ (но файл может не существовать!)
```

**Последствия:**
- Ложноположительное "success"
- Orchestrator принимает решения на основе hallucination
- Следующий specialist получает некорректный контекст
- Цепная реакция ошибок

### 18.2 Решение: Runtime ToolTrace + 3-Tier Verification

**Ключевая идея:** Source of truth = runtime trace, НЕ слова LLM.

```typescript
// ✅ V2 - проверяем через runtime trace
specialist: "Я создал файл test.ts"
verifier:
  1. Load runtime ToolTrace by traceRef
  2. Check: fs:write was actually called with path="test.ts"
  3. Re-read file, compare hash
  4. Verdict: passed ✅ (доказано)
```

---

### 18.3 Architecture

```
Specialist Execution:
┌─────────────────────────────────────────────────────────┐
│ Specialist executes tools                               │
│  ↓                                                      │
│ Runtime Proxy intercepts each tool call                │
│  ↓                                                      │
│ Records to ToolTrace:                                   │
│  - invocationId                                         │
│  - tool name                                            │
│  - args hash                                            │
│  - timestamp                                            │
│  - status (success/failed/timeout)                     │
│  - evidenceRefs (files, receipts, logs)                │
│  - output (raw data)                                    │
│  ↓                                                      │
│ Stores in ToolTraceStore (in-memory / cache / file)    │
└─────────────────────────────────────────────────────────┘
         ↓
Specialist returns SpecialistOutput with traceRef
         ↓
┌─────────────────────────────────────────────────────────┐
│ Orchestrator Verification                               │
│  ↓                                                      │
│ Load ToolTrace by traceRef                             │
│  ↓                                                      │
│ For each tool invocation:                              │
│  - Tier 1 (fs/code/shell): deterministic re-check      │
│  - Tier 2 (plugins): receipt + schema validation       │
│  - Tier 3 (remote/llm): inconclusive (trust minimal)   │
│  ↓                                                      │
│ Aggregate verdicts → final Verdict                     │
│  - passed: all checks passed                           │
│  - failed: any critical check failed                   │
│  - inconclusive: missing evidence/proofs               │
└─────────────────────────────────────────────────────────┘
```

---

### 18.4 Core Interfaces

```typescript
// ═══════════════════════════════════════════════════════════
// Runtime Truth: ToolTrace
// ═══════════════════════════════════════════════════════════

interface ToolTrace {
  traceId: string;
  sessionId: string;
  specialistId: string;
  invocations: ToolInvocation[];
  createdAt: Date;
}

interface ToolInvocation {
  invocationId: string;
  tool: string;
  argsHash: string;        // SHA-256 of args for dedup
  timestamp: Date;
  purpose: 'execution' | 'verification';  // Prevent recursive probes

  // Status от runtime execution
  status: 'success' | 'failed' | 'timeout' | 'error';

  // Evidence для проверки
  evidenceRefs: EvidenceRef[];

  // Raw output (может быть schema-validated)
  output?: unknown;

  // Digest для быстрых проверок
  digest?: {
    keyEvents?: string[];
    counters?: Record<string, number>;
  };
}

interface EvidenceRef {
  kind: 'file' | 'http' | 'receipt' | 'log' | 'hash';
  ref: string;        // path, URL, ID
  sha256?: string;    // для integrity checks
  meta?: unknown;
}

// ═══════════════════════════════════════════════════════════
// Specialist Output (with traceRef)
// ═══════════════════════════════════════════════════════════

interface SpecialistOutput {
  summary: string;
  traceRef: string;  // ← REQUIRED (not optional!)
  claims?: Claim[];  // Optional specialist claims
  artifacts?: CompactArtifact[];
}

// ═══════════════════════════════════════════════════════════
// Verification Result
// ═══════════════════════════════════════════════════════════

type Verdict = 'passed' | 'failed' | 'inconclusive';

interface VerificationResult {
  verdict: Verdict;
  confidence: 'low' | 'medium' | 'high';
  reason?: string;
  details?: CheckDetail[];
}

interface CheckDetail {
  check: string;      // "fs:write hash match"
  verdict: Verdict;
  reason?: string;
  evidence?: string;
}

// ═══════════════════════════════════════════════════════════
// Claims (specialist может заявлять, verifier проверяет)
// ═══════════════════════════════════════════════════════════

type Claim =
  | FileWriteClaim
  | FileEditClaim
  | FileDeleteClaim
  | CommandExecutedClaim
  | CodeInsertedClaim;

interface FileEditClaim {
  kind: 'file-edit';
  filePath: string;

  // Anchors для стабильной проверки (не линии!)
  anchor: {
    beforeSnippet: string;  // 3-5 строк ДО изменения
    afterSnippet: string;   // 3-5 строк ПОСЛЕ изменения
    contentHash: string;    // SHA-256 изменённого блока
  };

  // Line numbers - только hint (могут поплыть)
  editedRegion?: { start: number; end: number };
}
```

---

### 18.5 3-Tier Verification Model

#### Tier 1: Built-in Tools (fs, code, shell)
**Confidence:** High - full deterministic verification

**Sources of truth:**
- **ToolTrace** (runtime) - what was actually invoked
- **Filesystem state** - re-read files to verify writes
- **Shell exit codes** - process.exitCode for commands
- **Code AST** - parse and check structure

**Verification strategy:**
1. Load runtime ToolTrace by `output.traceRef` (required)
2. For each tool invocation:
   - `fs:write` → re-read file, compare hash with claim
   - `fs:delete` → check file doesn't exist
   - `shell:exec` → check exit code, optionally re-run dry-run
   - `code:insert` → verify anchor snippets exist in file

**Verdict:**
- `passed` - deterministic proof found
- `failed` - proof contradicts claim
- `inconclusive` - cannot verify (file disappeared, etc.)

**Example:**
```typescript
// Specialist claim
claim = { kind: 'file-edit', filePath: 'test.ts', anchor: {...} }

// Verifier
const trace = await traceStore.load(output.traceRef);
const inv = trace.invocations.find(i => i.tool === 'fs:write' && i.args.path === 'test.ts');

if (!inv) return { verdict: 'failed', reason: 'No fs:write in trace' };

const content = await fs.read('test.ts');
if (!content.includes(claim.anchor.beforeSnippet)) {
  return { verdict: 'failed', reason: 'Anchor not found' };
}
if (!content.includes(claim.anchor.afterSnippet)) {
  return { verdict: 'failed', reason: 'Anchor not found' };
}

return { verdict: 'passed', confidence: 'high' };
```

---

#### Tier 2: Plugin Tools
**Confidence:** Medium - receipt + schema validation

**Sources of truth:**
- **ToolTrace receipts** - status, evidenceRefs from runtime
- **Schema validation** - Zod checks for contract compliance

**Two-level schema validation:**

1. **Runtime validation** (infrastructure sanity check):
   ```typescript
   // Executed IMMEDIATELY after tool returns, BEFORE specialist sees it
   const result = await platform.invoke('mind:rag-query', args);

   // Get schema from plugin manifest
   const manifest = await pluginRegistry.getManifest('@kb-labs/mind');
   const toolDef = manifest.tools.find(t => t.id === 'rag-query');
   const schema = toolDef.output.schema;

   // Validate format
   const validation = schema.safeParse(result);
   if (!validation.success) {
     // ❌ Plugin bug - tool returned invalid format
     throw new Error(`Tool output does not match schema: ${validation.error}`);
   }

   // ✅ Only valid output goes to specialist
   return validation.data;
   ```

2. **Verification validation** (anti-hallucination check):
   ```typescript
   // Executed AFTER specialist completes, checks ToolTrace
   const trace = await traceStore.load(output.traceRef);
   const inv = trace.invocations.find(i => i.tool === 'mind:rag-query');

   // Check 1: Receipt status
   if (inv.status !== 'success') {
     return { verdict: 'failed', reason: 'Tool execution failed' };
   }

   // Check 2: Schema compliance (redundant but proves it was called)
   const schema = await this.getPluginSchema('mind:rag-query');
   const validation = schema.safeParse(inv.output);
   if (!validation.success) {
     // Should never happen if runtime validation works
     return { verdict: 'failed', reason: 'Schema validation failed' };
   }

   // ✅ Tool was called AND returned valid format
   return { verdict: 'passed', confidence: 'medium' };
   ```

**Verification strategy:**
1. Load ToolTrace by `output.traceRef`
2. For each plugin tool invocation:
   - Check `receipt.status === 'success'`
   - Validate `output.data` against `manifest.output.schema` (if present)
   - Collect evidenceRefs for audit trail

**Verdict:**
- `passed` - receipt OK + schema OK + evidenceRefs present
- `failed` - receipt failed OR schema invalid
- `inconclusive` - missing receipt OR missing schema

**Important:** Schema validation proves **format**, NOT **execution**.
- Runtime validation = infrastructure sanity (plugin не сломан)
- Verification validation = anti-hallucination (specialist действительно вызвал tool)
- For execution proof (что tool реально что-то сделал), use Tier 1 tools or Probes (Post-MVP)

**Example:**
```typescript
// Plugin manifest
{
  "tools": [{
    "id": "deploy",
    "output": {
      "schema": {
        "type": "object",
        "properties": {
          "deploymentId": { "type": "string" },
          "url": { "type": "string" }
        },
        "required": ["deploymentId", "url"]
      }
    }
  }]
}

// Runtime Proxy (validates BEFORE returning to specialist)
async function invokePluginTool(toolId: string, args: unknown): Promise<unknown> {
  const result = await plugin.execute(toolId, args);

  const manifest = await pluginRegistry.getManifest(plugin.id);
  const toolDef = manifest.tools.find(t => t.id === toolId);

  if (toolDef?.output?.schema) {
    const schema = await loadSchema(toolDef.output.schema);
    const validation = schema.safeParse(result);

    if (!validation.success) {
      // Infrastructure error - plugin broken
      throw new Error(`Plugin ${plugin.id}:${toolId} returned invalid output`);
    }
  }

  return result; // ✅ Validated output to specialist
}

// Verifier (validates AFTER specialist completes)
async function verifyPluginTool(inv: ToolInvocation): Promise<VerificationResult> {
  // Check status
  if (inv.status !== 'success') {
    return { verdict: 'failed', reason: 'Tool execution failed' };
  }

  // Load schema from manifest
  const manifest = await pluginRegistry.getManifest(inv.pluginId);
  const toolDef = manifest.tools.find(t => t.id === inv.toolId);

  if (toolDef?.output?.schema) {
    const schema = await loadSchema(toolDef.output.schema);
    const validation = schema.safeParse(inv.output);

    if (!validation.success) {
      // Should rarely happen (runtime should catch this)
      return { verdict: 'failed', reason: 'Schema validation failed' };
    }
  }

  // Check evidence refs
  if (!inv.evidenceRefs?.length) {
    return { verdict: 'inconclusive', reason: 'No evidence refs' };
  }

  return { verdict: 'passed', confidence: 'medium' };
}
```

---

#### Tier 3: Remote/LLM Tools
**Confidence:** Low - trust but verify via compact artifacts

For `llm:complete`, `api:call`, etc. - **no ground truth available**.

**Verification strategy:**
1. Check ToolTrace shows invocation happened
2. Validate schema if available
3. Verdict = `inconclusive` (trust specialist's judgment)

**Policy:** Use compact artifacts to minimize trust surface.

---

### 18.6 Inconclusive Policy

When verifier returns `inconclusive`, orchestrator follows policy:

```yaml
# .kb/kb.config.json
verifier:
  inconclusivePolicy:
    # What to do on inconclusive
    action: 'warn' | 'retry' | 'escalate' | 'fail'

    # Retry with more evidence if possible
    retryWithProbes: false  # MVP: false (probes Post-MVP)
    maxRetries: 1

    # Escalate to orchestrator for decision
    escalateTo: 'orchestrator'

    # Fail immediately (strict mode)
    failOnInconclusive: false  # MVP: false (warn only)
```

**Example flow:**
```
Specialist: implementer
Tool: plugin:reset-cache
Receipt: status=success, but no evidenceRefs
Verdict: inconclusive

Policy action: warn
→ Orchestrator: "Cannot verify reset-cache. Proceeding with caution."
→ Continue execution (trust specialist)
```

---

### 18.7 ToolTraceStore

**Interface:**
```typescript
interface ToolTraceStore {
  // Create new trace
  create(sessionId: string, specialistId: string): Promise<ToolTrace>;

  // Append invocation
  append(traceId: string, invocation: ToolInvocation): Promise<void>;

  // Load trace
  load(traceRef: string): Promise<ToolTrace>;

  // Cleanup
  delete(traceRef: string): Promise<void>;
}
```

**Storage options (MVP decision pending):**

| Option | Pros | Cons | MVP? |
|--------|------|------|------|
| **In-memory** | Fast, simple | Lost on crash | ✅ Start here |
| **State Broker (useCache)** | TTL cleanup, persistent | Requires broker | ⏳ Phase 2 |
| **File-based (.kb/session/)** | Persistent, debuggable | I/O overhead | ⏳ Fallback |

**MVP decision:** Start with **in-memory**, migrate to State Broker in Phase 2.

---

### 18.8 Future: Post-Action Probes (Post-MVP)

**Status:** Designed but NOT implemented in MVP

Probes would enable verification of plugin/remote tools via read-only post-action checks.

**Design principles:**
- Probes defined in plugin manifest
- Executed after tool invocation in verification phase
- Only read-only tools allowed (fs:read, http:get, etc.)
- Non-recursive (`purpose: verification` invocations skip probe checks)

**Example manifest:**
```yaml
tools:
  - id: 'reset-cache'
    probes:
      - tool: 'fs:list'
        argsTemplate:
          path: '.kb/cache'
        expect:
          empty: true
```

**Benefits:**
- Turn Tier 2 `inconclusive` → `passed`/`failed`
- Enable verification of C2/C3 criticality tools
- Reduce trust surface for plugin ecosystem

**Complexity:**
- Template engine for probe args
- Probe registry + fallback logic
- Policy for when to run probes
- LLM-generated probe approval workflow

**Decision:** Defer to Post-MVP to keep core verification simple.

See future ADR for full design (when implemented).

---

### 18.9 Anti-Hallucination Guarantees

**What V2 verification system guarantees:**

✅ **Tier 1 tools:** Deterministic proof
- fs:write → file exists with correct content (hash verified)
- fs:delete → file doesn't exist
- shell:exec → exit code verified
- code:insert → anchors found in AST

✅ **Tier 2 tools:** Contract compliance
- Receipt exists and status=success
- Output matches schema (format validated)
- EvidenceRefs present for audit

⚠️ **Tier 3 tools:** Minimal trust
- Invocation recorded in trace
- No execution proof available
- Verdict = inconclusive (honest)

❌ **What we DON'T guarantee (yet):**
- Tier 2 execution proof (needs probes - Post-MVP)
- Semantic correctness (only format/structure)
- Side-effects verification for remote APIs

**Key principle:** Better to say `inconclusive` honestly than `passed` falsely.

---

### 18.10 Integration with SessionState

```typescript
interface SpecialistRun {
  specialistId: string;
  task: string;
  output: SpecialistOutput;

  // NEW: Verification result
  verification: VerificationResult;

  durationMs: number;
  tokenUsage: { prompt: number; completion: number };
}

// Orchestrator после получения результата
const result = await specialist.execute(task);
const verification = await verifier.verify(result.output);

// Сохранить в SessionState
sessionState.history.push({
  specialistId: specialist.id,
  task,
  output: result.output,
  verification,  // ← Честная оценка
  durationMs: result.meta.durationMs,
  tokenUsage: result.meta.tokenUsage,
});

// Принять решение на основе verification
if (verification.verdict === 'failed') {
  // Retry или escalate
} else if (verification.verdict === 'inconclusive') {
  // Warn и продолжить (если policy позволяет)
} else {
  // Passed - можно доверять
}
```

---

### 18.11 Roadmap Integration

**Phase 1.5: Runtime Trace (after Specialist Executor)** ✅ COMPLETED (2026-01-18)
- [x] `ToolTrace` и `ToolInvocation` interfaces
- [x] `ToolTraceStore` (in-memory implementation)
- [x] Runtime proxy для записи tool calls
- [x] Runtime schema validation (validate plugin tool outputs BEFORE returning to specialist)
- [x] `traceRef` в `SpecialistOutput` (required)

**Phase 2.5: Basic Verification (after Orchestrator V2)**
- [ ] `Verifier` класс с 3-tier model
- [ ] Tier 1: fs/code/shell deterministic checks
- [ ] Tier 2: receipt + verification schema validation (check ToolTrace outputs match plugin manifest schemas)
- [ ] Tier 3: inconclusive for remote/llm
- [ ] `Verdict` aggregation
- [ ] Integration with SessionState

**Phase 3.5: Anchors & Claims (after optimizations)**
- [ ] `Claim` types (FileEditClaim, etc.)
- [ ] Anchor-based verification (not line numbers)
- [ ] `CheckDetail` для debugging

**Post-MVP: Probes**
- [ ] Probe definitions in plugin manifest
- [ ] Template engine for probe args
- [ ] Probe executor (read-only tools only)
- [ ] Non-recursive verification (purpose flag)
- [ ] LLM-generated probe proposals (with approval)

---

## 19. Phase 1: Детальный план реализации

### 19.1 Обзор Phase 1

**Цель:** Создать YAML-based систему определения специалистов с loader'ом по аналогии с manifest loader.

**Scope:**
- ✅ YAML схема `kb.specialist/1` (простая, декларативная)
- ✅ Discovery strategy для поиска specialist definitions
- ✅ Loader с timeout protection и error aggregation
- ✅ Validation с Zod (опционально, для debugging)
- ✅ Migration helpers для текущих агентов
- ✅ Unit tests

**Non-scope (Post-MVP):**
- ✅ Dynamic context enrichment (Phase 2) - COMPLETED
- ✅ Specialist executor (Phase 2) - COMPLETED
- ✅ Orchestrator integration (Phase 4) - COMPLETED

---

### 19.2 YAML Schema: `kb.specialist/1`

```yaml
# .kb/specialists/researcher.yml
schema: kb.specialist/1
id: researcher
version: 1.0.0

display:
  name: "Code Researcher"
  description: "Semantic code search and analysis specialist"
  emoji: "🔍"

# Core specialist role
role: |
  You are a code researcher specializing in semantic code exploration.
  Your job is to FIND and READ code, not to modify it.

  Use Mind RAG for semantic searches (NOT grep).
  Always provide file paths with line numbers in your findings.
  Extract key information for other specialists to use.

# Allowed tools (whitelist)
tools:
  - mind:rag-query
  - fs:read
  - fs:list
  - code:search

# Forced reasoning configuration
forcedReasoningInterval: 3  # After every 3 tool calls

# Static context (optional)
staticContext: |
  # KB Labs Architecture

  - KB Labs is a monorepo with 18 repositories
  - Main packages: mind, workflow, plugin, core
  - Always check Mind RAG before using grep
  - File naming convention: kebab-case
  - Test files: *.test.ts or *.spec.ts

# Examples of successful patterns (optional)
examples:
  - task: "Find how authentication works"
    approach: |
      1. mind:rag-query "authentication flow architecture"
      2. fs:read identified auth files
      3. Extract key classes and flow
    outcome: "Found JWT auth in core-auth package"

  - task: "Locate all API endpoints"
    approach: |
      1. mind:rag-query "REST API endpoints definitions"
      2. fs:list packages/*/src/rest/
      3. Compile list with descriptions
    outcome: "Found 24 endpoints across 5 packages"
```

**TypeScript Interface:**
```typescript
interface SpecialistDefinition {
  schema: 'kb.specialist/1';
  id: string;
  version: string;

  display: {
    name: string;
    description?: string;
    emoji?: string;
  };

  role: string;  // System prompt for specialist
  tools: string[];  // Allowed tool IDs
  forcedReasoningInterval: number;

  staticContext?: string;  // Static knowledge (markdown)
  examples?: Array<{
    task: string;
    approach: string;
    outcome: string;
  }>;
}
```

---

### 19.3 Discovery Strategy

**Аналогично WorkspaceStrategy + PkgStrategy**, но упрощённо:

```typescript
// packages/specialist-loader/src/discovery/specialist-discovery.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import type { SpecialistDefinition } from '../types.js';
import { isSpecialistV1 } from '../validation.js';
import { getLogger } from '@kb-labs/core-sys/logging';

const logger = getLogger('SpecialistDiscovery');

export interface SpecialistBrief {
  id: string;
  version: string;
  display: {
    name: string;
    description?: string;
    emoji?: string;
  };
  source: {
    path: string;  // Full path to .yml file
  };
}

export interface DiscoveryResult {
  specialists: SpecialistBrief[];
  definitions: Map<string, SpecialistDefinition>;
  errors: Array<{ path: string; error: string }>;
}

export class SpecialistDiscoveryStrategy {
  async discover(roots: string[]): Promise<DiscoveryResult> {
    logger.debug('Starting specialist discovery', { roots });

    const specialists: SpecialistBrief[] = [];
    const definitions = new Map<string, SpecialistDefinition>();
    const errors: Array<{ path: string; error: string }> = [];

    for (const root of roots) {
      // Look for .kb/specialists/ directory
      const specialistsDir = path.join(root, '.kb/specialists');

      if (!fs.existsSync(specialistsDir)) {
        logger.debug('Specialists directory not found', { specialistsDir });
        continue;
      }

      logger.debug('Found specialists directory', { specialistsDir });

      try {
        // Find all *.yml files
        const yamlPattern = path.join(specialistsDir, '*.yml');
        const yamlFiles = await glob(yamlPattern, { absolute: true });

        logger.debug('Found YAML files', { count: yamlFiles.length });

        for (const yamlPath of yamlFiles) {
          try {
            // Read and parse YAML
            const content = fs.readFileSync(yamlPath, 'utf8');
            const parsed: unknown = parseYaml(content);

            // Validate schema
            if (!isSpecialistV1(parsed)) {
              const schema = (parsed as any)?.schema || 'unknown';
              errors.push({
                path: yamlPath,
                error: `Invalid schema: expected "kb.specialist/1", got "${schema}"`,
              });
              logger.warn('Invalid schema', { yamlPath, schema });
              continue;
            }

            const definition = parsed as SpecialistDefinition;

            // Store brief
            specialists.push({
              id: definition.id,
              version: definition.version,
              display: definition.display,
              source: { path: yamlPath },
            });

            // Store full definition
            definitions.set(definition.id, definition);

            logger.debug('Successfully loaded specialist', {
              id: definition.id,
              path: yamlPath
            });

          } catch (error) {
            const errorMessage = error instanceof Error
              ? error.message
              : String(error);

            logger.error('Error loading specialist YAML', {
              yamlPath,
              error: errorMessage,
              stack: error instanceof Error ? error.stack : undefined,
            });

            errors.push({
              path: yamlPath,
              error: `Failed to parse YAML: ${errorMessage}`,
            });
          }
        }
      } catch (error) {
        errors.push({
          path: specialistsDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { specialists, definitions, errors };
  }
}
```

**Key features:**
- ✅ No `safeImport` needed (YAML is static)
- ✅ Error aggregation (не fail fast)
- ✅ Structured result (brief + full definition)
- ✅ Logging с context

---

### 19.4 Type Guard & Validation

```typescript
// packages/specialist-loader/src/validation.ts

import { z } from 'zod';

/**
 * Minimal type guard (schema check only)
 */
export function isSpecialistV1(data: unknown): data is SpecialistDefinition {
  return (
    typeof data === 'object' &&
    data !== null &&
    'schema' in data &&
    data.schema === 'kb.specialist/1'
  );
}

/**
 * Full Zod validation (for detailed error messages)
 */
export const SpecialistDefinitionSchema = z.object({
  schema: z.literal('kb.specialist/1'),
  id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/), // semver

  display: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    emoji: z.string().optional(),
  }),

  role: z.string().min(10), // At least 10 chars
  tools: z.array(z.string()).min(1), // At least one tool
  forcedReasoningInterval: z.number().int().min(1).max(100),

  staticContext: z.string().optional(),
  examples: z.array(z.object({
    task: z.string(),
    approach: z.string(),
    outcome: z.string(),
  })).optional(),
});

export type SpecialistDefinition = z.infer<typeof SpecialistDefinitionSchema>;

export interface ValidationResult {
  valid: boolean;
  data?: SpecialistDefinition;
  errors?: z.ZodError[];
}

/**
 * Validate specialist definition with detailed errors
 */
export function validateSpecialist(data: unknown): ValidationResult {
  const result = SpecialistDefinitionSchema.safeParse(data);

  if (!result.success) {
    return {
      valid: false,
      errors: [result.error]
    };
  }

  return {
    valid: true,
    data: result.data
  };
}
```

---

### 19.5 Loader API

```typescript
// packages/specialist-loader/src/loader.ts

import type { SpecialistDefinition, SpecialistBrief } from './types.js';
import { SpecialistDiscoveryStrategy } from './discovery/specialist-discovery.js';
import { getLogger } from '@kb-labs/core-sys/logging';

const logger = getLogger('SpecialistLoader');

export class SpecialistLoader {
  private definitions = new Map<string, SpecialistDefinition>();
  private specialists: SpecialistBrief[] = [];
  private errors: Array<{ path: string; error: string }> = [];

  /**
   * Load all specialist definitions from roots
   */
  async load(roots: string[]): Promise<void> {
    logger.info('Loading specialists', { roots });

    const strategy = new SpecialistDiscoveryStrategy();
    const result = await strategy.discover(roots);

    this.specialists = result.specialists;
    this.definitions = result.definitions;
    this.errors = result.errors;

    if (this.errors.length > 0) {
      logger.warn('Specialist discovery found errors', {
        count: this.errors.length,
        errors: this.errors,
      });
    }

    logger.info('Specialists loaded', {
      count: this.specialists.length,
      errorCount: this.errors.length,
    });
  }

  /**
   * Get specialist definition by ID
   */
  get(id: string): SpecialistDefinition | undefined {
    return this.definitions.get(id);
  }

  /**
   * List all specialist briefs
   */
  list(): SpecialistBrief[] {
    return [...this.specialists];
  }

  /**
   * Get all errors from discovery
   */
  getErrors(): Array<{ path: string; error: string }> {
    return [...this.errors];
  }

  /**
   * Check if specialist exists
   */
  has(id: string): boolean {
    return this.definitions.has(id);
  }
}
```

---

### 19.6 Migration Plan

**Шаг 1: Создать YAML определения для текущих агентов**

```bash
# Create directory
mkdir -p .kb/specialists

# Migrate mind-specialist → researcher
cat > .kb/specialists/researcher.yml <<EOF
schema: kb.specialist/1
id: researcher
version: 1.0.0

display:
  name: "Code Researcher"
  description: "Semantic code search specialist"
  emoji: "🔍"

role: |
  You are a code researcher. Find and analyze code using Mind RAG.
  Do NOT modify files. Extract findings for other specialists.

tools:
  - mind:rag-query
  - fs:read
  - fs:list

forcedReasoningInterval: 3
EOF

# Migrate coding-agent → implementer
cat > .kb/specialists/implementer.yml <<EOF
schema: kb.specialist/1
id: implementer
version: 1.0.0

display:
  name: "Code Implementer"
  description: "Writes and modifies code"
  emoji: "💻"

role: |
  You are a code implementer. Write clean, tested code.
  Follow existing patterns. Always run tests after changes.

tools:
  - fs:read
  - fs:write
  - shell:exec
  - code:insert

forcedReasoningInterval: 5
EOF
```

**Шаг 2: Обновить команды для использования loader**

```typescript
// packages/agent-cli/src/commands/agent-run.ts

import { SpecialistLoader } from '@kb-labs/specialist-loader';

export async function run(ctx: CommandContext) {
  const { agentId, task } = ctx.flags;

  // Load specialists
  const loader = new SpecialistLoader();
  await loader.load([process.cwd()]);

  // Get definition
  const definition = loader.get(agentId);
  if (!definition) {
    ctx.ui.error(`Specialist "${agentId}" not found`);
    return { ok: false };
  }

  // Execute with definition
  const executor = new SpecialistExecutor(definition);
  const result = await executor.execute(task);

  return { ok: result.success };
}
```

---

### 19.7 Testing Strategy

**Unit Tests:**

```typescript
// packages/specialist-loader/src/__tests__/discovery.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SpecialistDiscoveryStrategy } from '../discovery/specialist-discovery';

describe('SpecialistDiscoveryStrategy', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/specialist-test-');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('discovers valid specialist YAML files', async () => {
    // Setup
    const specialistsDir = path.join(tmpDir, '.kb/specialists');
    fs.mkdirSync(specialistsDir, { recursive: true });

    const yamlContent = `
schema: kb.specialist/1
id: test-specialist
version: 1.0.0
display:
  name: "Test Specialist"
role: "Test role"
tools: ["fs:read"]
forcedReasoningInterval: 3
`;
    fs.writeFileSync(
      path.join(specialistsDir, 'test.yml'),
      yamlContent
    );

    // Execute
    const strategy = new SpecialistDiscoveryStrategy();
    const result = await strategy.discover([tmpDir]);

    // Assert
    expect(result.specialists).toHaveLength(1);
    expect(result.specialists[0].id).toBe('test-specialist');
    expect(result.definitions.has('test-specialist')).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('handles invalid schema gracefully', async () => {
    // Setup
    const specialistsDir = path.join(tmpDir, '.kb/specialists');
    fs.mkdirSync(specialistsDir, { recursive: true });

    const yamlContent = `
schema: kb.specialist/99
id: invalid
`;
    fs.writeFileSync(
      path.join(specialistsDir, 'invalid.yml'),
      yamlContent
    );

    // Execute
    const strategy = new SpecialistDiscoveryStrategy();
    const result = await strategy.discover([tmpDir]);

    // Assert
    expect(result.specialists).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('Invalid schema');
  });

  it('aggregates errors without failing fast', async () => {
    // Setup
    const specialistsDir = path.join(tmpDir, '.kb/specialists');
    fs.mkdirSync(specialistsDir, { recursive: true });

    // Valid file
    fs.writeFileSync(
      path.join(specialistsDir, 'valid.yml'),
      'schema: kb.specialist/1\nid: valid\nversion: 1.0.0\ndisplay:\n  name: "Valid"\nrole: "test"\ntools: ["fs:read"]\nforcedReasoningInterval: 3'
    );

    // Invalid file
    fs.writeFileSync(
      path.join(specialistsDir, 'invalid.yml'),
      'invalid yaml: [[[['
    );

    // Execute
    const strategy = new SpecialistDiscoveryStrategy();
    const result = await strategy.discover([tmpDir]);

    // Assert
    expect(result.specialists).toHaveLength(1); // Still got valid one
    expect(result.errors).toHaveLength(1); // Recorded error
  });
});
```

**Integration Tests:**

```typescript
// packages/specialist-loader/src/__tests__/loader.integration.test.ts

import { describe, it, expect } from 'vitest';
import { SpecialistLoader } from '../loader';

describe('SpecialistLoader Integration', () => {
  it('loads specialists from .kb/specialists/', async () => {
    const loader = new SpecialistLoader();
    await loader.load([process.cwd()]);

    const specialists = loader.list();
    expect(specialists.length).toBeGreaterThan(0);

    const researcher = loader.get('researcher');
    expect(researcher).toBeDefined();
    expect(researcher?.tools).toContain('mind:rag-query');
  });
});
```

---

### 19.8 CLI Commands

```bash
# List all available specialists
pnpm kb specialist:list

# Validate a specialist definition
pnpm kb specialist:validate --path .kb/specialists/researcher.yml

# Show specialist details
pnpm kb specialist:info --id researcher
```

**Implementation:**

```typescript
// packages/agent-cli/src/commands/specialist-list.ts

export async function listSpecialists(ctx: CommandContext) {
  const loader = new SpecialistLoader();
  await loader.load([process.cwd()]);

  const specialists = loader.list();

  ctx.ui.write('\n📋 Available Specialists:\n\n');

  for (const spec of specialists) {
    const emoji = spec.display.emoji || '🤖';
    ctx.ui.write(`  ${emoji} ${spec.display.name} (${spec.id})\n`);
    if (spec.display.description) {
      ctx.ui.write(`     ${spec.display.description}\n`);
    }
  }

  const errors = loader.getErrors();
  if (errors.length > 0) {
    ctx.ui.write('\n⚠️  Errors:\n');
    for (const err of errors) {
      ctx.ui.write(`  ${err.path}: ${err.error}\n`);
    }
  }

  return { ok: true };
}
```

---

### 19.9 Phase 1 Checklist

**Core Implementation:**
- [ ] Create `@kb-labs/specialist-loader` package
- [ ] Define `SpecialistDefinition` TypeScript types
- [ ] Implement `SpecialistDiscoveryStrategy`
- [ ] Implement `SpecialistLoader` class
- [ ] Add Zod schema for validation
- [ ] Add `isSpecialistV1` type guard

**YAML Definitions:**
- [ ] Create `.kb/specialists/researcher.yml` (ex mind-specialist)
- [ ] Create `.kb/specialists/implementer.yml` (ex coding-agent)
- [ ] Add static context to researcher (KB Labs architecture)
- [ ] Add examples to researcher

**CLI Commands:**
- [ ] `specialist:list` - list all specialists
- [ ] `specialist:validate` - validate YAML file
- [ ] `specialist:info` - show specialist details
- [ ] Update `agent:run` to use loader

**Tests:**
- [ ] Unit tests for discovery strategy
- [ ] Unit tests for validation
- [ ] Unit tests for loader API
- [ ] Integration tests (load from .kb/specialists/)
- [ ] Test error aggregation
- [ ] Test invalid schema handling

**Documentation:**
- [ ] README for specialist-loader package
- [ ] YAML schema reference
- [ ] Migration guide (V1 agents → V2 specialists)
- [ ] Examples for common specialist types

---

### 19.10 Success Criteria

**Phase 1 считается завершённым, когда:**

✅ **Loader работает:**
- Discovery находит все `.yml` файлы в `.kb/specialists/`
- Парсинг YAML не падает на invalid files
- Валидация корректно проверяет schema
- Errors aggregated, не fail fast

✅ **YAML definitions созданы:**
- `researcher.yml` (ex mind-specialist)
- `implementer.yml` (ex coding-agent)
- Оба содержат `staticContext` и `examples`

✅ **CLI команды работают:**
- `specialist:list` показывает specialists
- `specialist:validate` проверяет YAML
- `specialist:info` показывает details

✅ **Тесты проходят:**
- Unit tests: 100% coverage для loader
- Integration tests: load from real `.kb/specialists/`
- Error handling tests

✅ **Документация готова:**
- README с примерами
- YAML schema reference
- Migration guide

---

**Last Updated:** 2026-01-18
**Status:** Phase 1 Design Complete, Ready for Implementation
**Next Steps:** Создать package `@kb-labs/specialist-loader` и начать с discovery strategy
