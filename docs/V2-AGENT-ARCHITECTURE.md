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

### Phase 4: Orchestrator V2
- [ ] Новый prompt с описаниями специалистов
- [ ] LLM-based выбор специалиста
- [ ] Session-level memory (inline SessionState)
- [ ] Evaluation после каждого specialist result
- [ ] partial результат → сохранение в SessionState

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

**Last Updated:** 2026-01-18
**Status:** Design Complete, Ready for Phase 1
**Next Steps:** Начать Phase 1 - создать YAML схему `kb.specialist/1` и loader
