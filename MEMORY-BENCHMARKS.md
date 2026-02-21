# Two-Tier Memory Benchmarks

Живой документ для ручного тестирования двухуровневой памяти агента.
Каждый запуск документируется вручную: команда → ожидание → факты из трейса → вывод.

**Дата введения в эксплуатацию:** 2026-02-21

---

## Конфигурация (зафиксировать при изменениях)

| Параметр | Значение | Файл |
|----------|----------|------|
| `slidingWindowSize` | 20 итераций | `constants.ts` |
| `summarizationInterval` | 5 итераций | `constants.ts` |
| `factSheetMaxEntries` | 60 фактов | `constants.ts` |
| `factSheetMaxTokens` | 5 000 токенов | `constants.ts` |
| `archiveMaxEntries` | 200 записей | `constants.ts` |
| `maxToolOutputChars` | 8 000 символов | `constants.ts` |

---

## Как читать трейс после запуска

```bash
# Последний индекс (summary + memory секция)
ls -t .kb/traces/incremental/*-index.json | head -1 | xargs cat | jq '{iterations: .summary.iterations, status: .summary.status, cost: .cost, memory: .memory}'

# Только токены/стоимость
ls -t .kb/traces/incremental/*-index.json | head -1 | xargs cat | jq '{cost: .cost, iterations: .summary.iterations}'

# Количество вызовов по типам
ls -t .kb/traces/incremental/*-index.json | head -1 | xargs cat | jq '.summary.eventCounts'

# Проверить дубли fs_read по конкретному файлу (заменить FILENAME)
TRACE=$(ls -t .kb/traces/incremental/*.ndjson | head -1) && \
  cat $TRACE | grep '"type":"tool:execution"' | grep '"name":"fs_read"' | grep FILENAME | wc -l

# Посмотреть archive_recall вызовы
TRACE=$(ls -t .kb/traces/incremental/*.ndjson | head -1) && \
  cat $TRACE | grep '"type":"tool:execution"' | grep '"name":"archive_recall"' | wc -l
```

---

## Benchmark 1 — Smoke Test (базовая работоспособность)

**Цель:** Убедиться что память инициализируется и memory секция появляется в трейсе.

**Задача:**
```bash
pnpm kb agent:run --task="Прочитай README.md из корня kb-labs-agents и кратко суммируй содержимое."
```

**Ожидаемое:**
- Агент завершается без ошибок
- `memory.totalFactsAdded` ≥ 1 (heuristic fact от fs_read)
- `memory.totalArchiveStores` ≥ 1
- `cost.totalCost` разумная (< $0.10 для простой задачи)
- FactSheet в system prompt агента содержит факт о README

| Дата | Итерации | Facts Added | Archive Stores | Токены (input/output) | Стоимость $ | Статус | Примечания |
|------|----------|-------------|----------------|-----------------------|------------|--------|------------|
| 2026-02-21 | 2 | 1 | 1 | 2830 / 548 | $0.012 | ✅ OK | README.md битый (20k строк повторов) — агент это обнаружил. memory:fact_added и memory:archive_store в трейсе есть. Индекс не содержит memory секцию — TraceSaverProcessor пишет task-*, а run-* индекс от CLI-трейсера. |

---

## Benchmark 2 — Исследование пакета (exploration)

**Цель:** Агент исследует пакет → накапливает факты → НЕ перечитывает файлы.

**Задача:**
```bash
pnpm kb agent:run --task="Исследуй архитектуру пакета @kb-labs/agent-core: структуру файлов, ключевые классы и как они связаны. Дай итоговый отчёт."
```

**Ожидаемое:**
- `memory.totalFactsAdded` > 10 (по одному heuristic факту на каждый прочитанный файл + LLM extraction)
- `memory.summarizationRuns` ≥ 1 (если > 5 итераций)
- `memory.avgCompressionRatio` > 3x
- Нет повторных `fs_read` по одному пути (проверить через ndjson)
- Токены: ожидаем рост FactSheet, но общий расход ниже чем без памяти (меньше wasted итераций)

**Проверка дублей чтений:**
```bash
TRACE=$(ls -t .kb/traces/incremental/*.ndjson | head -1)
cat $TRACE | python3 -c "
import sys, json
from collections import Counter
reads = []
for line in sys.stdin:
  e = json.loads(line)
  if e.get('type') == 'tool:execution' and e.get('tool', {}).get('name') == 'fs_read':
    path = (e.get('input') or {}).get('path', '?')
    reads.append(path)
dups = {p: c for p, c in Counter(reads).items() if c > 1}
print(f'Total fs_read: {len(reads)}, Duplicates: {dups}')
"
```

| Дата | Итерации | Facts Added | Summ. Runs | Avg Compression | Input tok | Output tok | Стоимость $ | Дубли чтений | Статус |
|------|----------|-------------|------------|-----------------|-----------|------------|------------|--------------|--------|
| 2026-02-21 | 10 | 15 | 0 ⚠️ | — | 2435 | 4497 | ~$0.025 | 3 × 2 ⚠️ | ⚠️ Есть проблемы |
| 2026-02-21 | 11 | 29 | 1 ✅ | 1.28x ⚠️ | ~3500 | ~5200 | ~$0.035 | 1 × 2 ⚠️ | ⚠️ P1 ✅, P3 ✅, dedup-bug ✅, P2 ⚠️ |
| 2026-02-21 | 13 | 29 ✅ | 2 ✅ | 2.34x | ~4700 | ~7557 | $0.083 | 1 × 3 ⚠️ | ⚠️ finalFactSheet=27 ✅, archive_recall=0 ⚠️ |

---

## Benchmark 3 — Поиск и анализ (search-heavy)

**Цель:** Агент делает много grep/glob → факты извлекаются из поисковых результатов.

**Задача:**
```bash
pnpm kb agent:run --task="Найди все экспортируемые типы (interface и type) в пакете @kb-labs/agent-contracts. Составь полный список с кратким описанием каждого."
```

**Ожидаемое:**
- `memory.totalArchiveStores` > 5 (каждый grep/glob архивируется)
- `memory.totalFactsAdded` > 5
- Нет дублирующихся grep с одним паттерном
- `avgNewFactRate` > 0.3 (LLM находит новое, не дублирует)

**Проверка дублей поисков:**
```bash
TRACE=$(ls -t .kb/traces/incremental/*.ndjson | head -1)
cat $TRACE | python3 -c "
import sys, json
from collections import Counter
patterns = []
for line in sys.stdin:
  e = json.loads(line)
  if e.get('type') == 'tool:execution' and e.get('tool', {}).get('name') == 'grep_search':
    pat = (e.get('input') or {}).get('pattern', '?')
    patterns.append(pat)
dups = {p: c for p, c in Counter(patterns).items() if c > 1}
print(f'Total grep: {len(patterns)}, Duplicates: {dups}')
"
```

| Дата | Итерации | Facts Added | Archive Stores | Avg New Fact Rate | Input tok | Output tok | Стоимость $ | Дубли поисков | Статус |
|------|----------|-------------|----------------|-------------------|-----------|------------|------------|---------------|--------|
| —    | —        | —           | —              | —                 | —         | —          | —          | —             | ⬜ не запускался |

---

## Benchmark 4 — Длинная задача (15+ итераций)

**Цель:** Факты из ранних итераций доступны в конце. Память не деградирует.

**Задача:**
```bash
pnpm kb agent:run --task="Проведи полный аудит kb-labs-agents: 1) список всех пакетов и их зависимостей, 2) все публичные интерфейсы из agent-contracts, 3) все инструменты в agent-tools, 4) все типы trace events в agent-tracing. Оформи структурированный отчёт."
```

**Ожидаемое:**
- `summary.iterations` > 12
- `memory.summarizationRuns` ≥ 2
- `memory.totalFactsAdded` > 20
- `memory.avgNewFactRate` > 0.3
- `memory.finalFactSheetSize` > 15 фактов (накопились и не стёрлись)
- Финальный отчёт содержит факты из ВСЕХ 4 пунктов, не только последнего
- Токены: input tokens на поздних итерациях выше (FactSheet растёт), но разумно

| Дата | Итерации | Facts Added | Summ. Runs | Final Fact Sheet | Avg New Fact Rate | Input tok | Output tok | Стоимость $ | Статус |
|------|----------|-------------|------------|------------------|-------------------|-----------|------------|------------|--------|
| —    | —        | —           | —          | —                | —                 | —         | —          | —          | ⬜ не запускался |

---

## Benchmark 5 — Archive Recall (повторный доступ к файлам)

**Цель:** Агент использует `archive_recall` вместо повторного `fs_read`.

**Задача:**
```bash
pnpm kb agent:run --task="Прочитай packages/agent-core/src/agent.ts. Затем исследуй все импортируемые им локальные модули. В конце вернись к agent.ts и объясни как он оркестрирует найденные компоненты."
```

**Ожидаемое:**
- `fs_read` для agent.ts: ровно 1 раз
- `archive_recall` для agent.ts: ≥ 1 раз (при возврате в конце)
- Если агент делает `fs_read` дважды для agent.ts → это регрессия

**Проверка:**
```bash
TRACE=$(ls -t .kb/traces/incremental/*.ndjson | head -1)

echo "=== fs_read agent.ts ==="
cat $TRACE | python3 -c "
import sys, json
for line in sys.stdin:
  e = json.loads(line)
  if e.get('type') == 'tool:execution' and e.get('tool', {}).get('name') == 'fs_read':
    path = str((e.get('input') or {}).get('path', ''))
    if 'agent.ts' in path and 'test' not in path:
      print(f\"  iter={e.get('iteration')} path={path}\")
"

echo "=== archive_recall agent.ts ==="
cat $TRACE | python3 -c "
import sys, json
for line in sys.stdin:
  e = json.loads(line)
  if e.get('type') == 'tool:execution' and e.get('tool', {}).get('name') == 'archive_recall':
    inp = e.get('input') or {}
    if 'agent.ts' in str(inp):
      print(f\"  iter={e.get('iteration')} input={inp}\")
"
```

| Дата | fs_read agent.ts | archive_recall agent.ts | Input tok | Output tok | Стоимость $ | Результат |
|------|-----------------|------------------------|-----------|------------|------------|-----------|
| —    | —               | —                      | —         | —          | —          | ⬜ не запускался |

---

## Benchmark 6 — Стоимость с памятью vs без (token efficiency)

**Цель:** Убедиться что FactSheet экономит токены на длинных задачах (меньше повторных чтений = меньше общий расход).

**Методология:** Запустить одинаковую задачу дважды — с текущими настройками (память включена всегда) и теоретически сравнить с baseline (если бы agentа не было FactSheet). Пока — просто трекаем стоимость по запускам.

**Задача (та же что Benchmark 4):**
```
Полный аудит kb-labs-agents — 4 пункта.
```

**Формула эффективности памяти:**
```
archive_recall_count / (fs_read_count + archive_recall_count) = archive_hit_rate
Цель: archive_hit_rate > 30% на задачах с повторным доступом к файлам
```

| Дата | Benchmark | Total Input Tok | Total Output Tok | Total $ | archive_hit_rate | Итерации | Примечания |
|------|-----------|----------------|-----------------|---------|-----------------|----------|------------|
| —    | —         | —              | —               | —       | —               | —        | ⬜ не запускался |

---

## Шаблон для заполнения после запуска

```
### Запуск: [Benchmark N] — [дата]

**Команда:** pnpm kb agent:run --task="..."

**Трейс-индекс:**
\```json
// вставить вывод jq
\```

**Итоги:**
- Итерации: X
- Facts Added: X
- Archive Stores: X
- Summarization Runs: X
- Avg Compression: Xx
- Avg New Fact Rate: X%
- Input tokens: X | Output tokens: X
- Стоимость: $X.XX
- archive_hit_rate: X%

**Наблюдения:**
- [что работает хорошо]
- [что вызвало вопросы]
- [регрессии если есть]

**Вердикт:** ✅ OK / ⚠️ Есть проблемы / ❌ Регрессия
```

---

## Известные проблемы (по результатам запусков)

### P1 — Summarization не срабатывает ✅ ИСПРАВЛЕНО (2026-02-21)

**Симптом:** `summarizationRuns = 0` при 10 итерациях (интервал = 5).
**Причина:** В `agent.ts` hardcoded `iteration % 10 === 0` вместо `% AGENT_SUMMARIZER.summarizationInterval`.
**Фикс:** Заменено на `% AGENT_SUMMARIZER.summarizationInterval` (значение 5).
**Результат:** После фикса `summarizationRuns = 2` на 13 итерациях. ✅

### P2 — archive_recall не используется агентом (2026-02-21)

**Симптом:** `agent.ts` читается 3 раза, `archive_recall` = 0 вызовов.
**Задача:** Benchmark 2 — exploration.
**Частичный фикс:** Добавлено явное правило в system prompt:
`"Before calling fs_read, first check archive_recall"`.
**Результат:** Улучшение с 3×2 дублей до 1×3 дублей, но archive_recall всё ещё 0.
**Вероятная причина:** `agent.ts` — очень большой файл (3600 строк), агент читает его частями по окну
(`startLine`/`endLine`), а archive_recall возвращает только первый read (первое окно). Агент вынужден
читать дальше, т.к. нужен контент из разных частей файла.
**Что можно улучшить:** Научить archive_recall возвращать все chunks по файлу + агент должен знать
что файл уже частично прочитан и использовать offset/limit запросы вместо повторного чтения.
**Статус:** ⚠️ Частично — для больших файлов это ожидаемое поведение

### P3 — memory секция отсутствует в trace index ✅ ИСПРАВЛЕНО (2026-02-21)

**Симптом:** `jq .memory` из `-index.json` возвращает `null`.
**Причина:** CLI IncrementalTraceWriter не вызывал `finalize()` — index не генерировался.
**Фикс:** Добавлен `await tracer.finalize()` в `run.ts` после `storeTraceArtifacts`.
**Результат:** `memory` секция теперь содержит полную статистику в `task-*-index.json`. ✅

### P4 — Dedup слишком агрессивный для file_content ✅ ИСПРАВЛЕНО (2026-02-21)

**Симптом:** `finalFactSheetSize = 1` при 13 фактах типа `file_content` — все схлопнулись в один.
**Причина:** Функция `findSimilarFact` использовала word overlap (60%) для всех категорий.
Факты `"Read kb-labs-agents/packages/agent-core/src/index.ts"` и `"Read kb-labs-agents/packages/agent-core/src/agent.ts"`
имеют общие слова: `read`, `labs`, `agents`, `packages`, `agent`, `core`, `src` → overlap > 60% → merge.
**Фикс:** Для категории `file_content` деdup по extracted file path (exact match через regex `^Read\s+(\S+)\s*\(`).
Разные пути = разные факты, один путь = merge.
**Результат:** `finalFactSheetSize = 27`, `merged = 2/29` (только реальные повторы). ✅

---

## Признаки регрессии (алёрты)

| Симптом | Возможная причина |
|---------|------------------|
| `memory` отсутствует в индексе | FactSheet/ArchiveMemory не инициализируются в agent.ts |
| `totalFactsAdded = 0` | heuristic extraction не работает для fs_read/grep |
| `summarizationRuns = 0` при > 5 итерациях | SmartSummarizer не срабатывает / onFactsExtracted не вызывается |
| `avgNewFactRate < 0.1` | LLM дублирует факты, prompt нужно доработать |
| Повторные `fs_read` по одному пути | `archive_recall` не предлагается агентом, system prompt надо усилить |
| Стоимость резко выросла vs прошлого запуска | FactSheet переполнен, eviction не работает |
| `finalFactSheetSize = 0` при > 10 итерациях | Eviction слишком агрессивна |
