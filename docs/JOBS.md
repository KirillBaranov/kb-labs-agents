# Background Jobs в Plugin Template

## Что такое Background Jobs?

Background jobs (фоновые задачи) позволяют плагинам запускать код по расписанию (cron) или в фоне, независимо от CLI команд или REST запросов.

**Применения:**
- Периодическая синхронизация данных
- Очистка кеша
- Генерация отчетов
- Отправка уведомлений
- Любые повторяющиеся задачи

## Как работает?

Jobs загружаются State Daemon'ом при старте:
1. State Daemon читает манифесты всех плагинов
2. Находит секцию `jobs[]` в каждом манифесте
3. Регистрирует jobs в CronManager
4. CronManager запускает jobs по расписанию

## Быстрый старт

### 1. Объявите job в манифесте

```typescript
// src/manifest.v2.ts
export const manifest = defineManifest({
  // ... остальные поля ...

  jobs: [
    {
      id: 'hello-cron',
      handler: './jobs/hello.js#run',
      schedule: '*/5 * * * *', // Каждые 5 минут
      describe: 'Says hello every 5 minutes',
      enabled: true,
      priority: 5,
      timeout: 10000,
      retries: 2,
      tags: ['demo', 'hello'],
    },
  ],
});
```

### 2. Создайте handler с использованием defineJob

**⚠️ SECURITY: Jobs ДОЛЖНЫ использовать `defineJob()` helper для безопасности!**

```typescript
// src/jobs/hello.ts
import { defineJob, permissions } from '@kb-labs/shared-command-kit';
import { join, dirname } from 'node:path';

/**
 * Hello job - демонстрирует sandbox isolation и permissions
 */
export const helloJob = defineJob({
  id: 'hello-cron',
  schedule: '*/1 * * * *', // Каждую минуту
  describe: 'Says hello every minute and writes to log file (sandboxed)',
  enabled: true,
  priority: 5,
  timeout: 10000,
  retries: 2,
  tags: ['demo', 'hello'],

  // ✅ SECURITY: Permissions для job (запуск в sandbox)
  permissions: permissions.combine(
    permissions.presets.pluginWorkspace('template'), // Доступ к .kb/template/
    {
      quotas: {
        timeoutMs: 10000, // 10 seconds timeout
        memoryMb: 64, // 64 MB memory limit
        cpuMs: 5000, // 5 seconds CPU time
      },
    }
  ),

  /**
   * Job handler - выполняется в sandbox с ctx.runtime.fs
   */
  async handler(input, ctx) {
    const message = `Hello from sandboxed cron job! Run #${input.runCount} at ${input.executedAt.toISOString()}`;

    // ✅ SECURITY: Используйте ctx.runtime.fs вместо прямого fs доступа
    const logPath = join('.kb', 'template', 'cron.log');

    try {
      // Создать директорию если не существует
      await ctx.runtime.fs.mkdir(dirname(logPath), { recursive: true });

      // Прочитать существующий контент
      let existingContent = '';
      try {
        existingContent = (await ctx.runtime.fs.readFile(logPath, {
          encoding: 'utf-8',
        })) as string;
      } catch {
        // Файл не существует, игнорируем
      }

      // Записать новое сообщение
      await ctx.runtime.fs.writeFile(logPath, existingContent + message + '\n', {
        encoding: 'utf-8',
      });

      ctx.logger?.info(message);

      return {
        ok: true,
        message,
        executedAt: input.executedAt.toISOString(),
        runCount: input.runCount,
      };
    } catch (error) {
      ctx.logger?.error('Job failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

/**
 * Export handler для reference в манифесте
 * Манифест ссылается на это через './jobs/hello.js#run'
 */
export const run = helloJob.handler;
```

### 3. Добавьте в tsup.config.ts

```typescript
// tsup.config.ts
export default defineConfig({
  ...nodePreset,
  entry: {
    // ... остальные entry points ...
    'jobs/hello': 'src/jobs/hello.ts', // Добавьте ваш job
  },
});
```

### 4. Пересоберите пакет

```bash
pnpm --filter @kb-labs/plugin-template-core run build
```

### 5. Перезапустите State Daemon

```bash
pnpm dev:stop
pnpm dev:start
```

## Cron Expressions

Jobs используют стандартный формат cron:

```
┌───────────── минута (0 - 59)
│ ┌───────────── час (0 - 23)
│ │ ┌───────────── день месяца (1 - 31)
│ │ │ ┌───────────── месяц (1 - 12)
│ │ │ │ ┌───────────── день недели (0 - 6) (0 = воскресенье)
│ │ │ │ │
* * * * *
```

**Примеры:**

| Расписание | Описание |
|------------|----------|
| `* * * * *` | Каждую минуту |
| `*/5 * * * *` | Каждые 5 минут |
| `0 * * * *` | Каждый час |
| `0 0 * * *` | Каждый день в полночь |
| `0 0 * * 0` | Каждое воскресенье в полночь |
| `0 9 * * 1-5` | Каждый будний день в 9:00 |

**Shortcuts:**
- `@hourly` = `0 * * * *`
- `@daily` = `0 0 * * *`
- `@weekly` = `0 0 * * 0`
- `@monthly` = `0 0 1 * *`
- `@yearly` = `0 0 1 1 *`

## HTTP API

State Daemon предоставляет HTTP API для управления jobs:

### Список всех jobs

```bash
curl http://localhost:7777/jobs | jq
```

**Ответ:**
```json
{
  "jobs": [
    {
      "id": "@kb-labs/plugin-template:hello-cron",
      "schedule": "*/1 * * * *",
      "status": "active",
      "lastRun": "2025-12-06T10:15:05.103Z",
      "nextRun": "2025-12-06T10:16:00.000Z",
      "runCount": 2
    }
  ]
}
```

### Manual trigger

```bash
curl -X POST http://localhost:7777/jobs/@kb-labs/plugin-template:hello-cron/trigger | jq
```

**Ответ:**
```json
{
  "ok": true,
  "message": "Job @kb-labs/plugin-template:hello-cron triggered successfully"
}
```

### Статистика

```bash
curl http://localhost:7777/jobs/stats | jq
```

## Job Context

Handler функция получает `JobHandlerContext` (когда использует `defineJob`):

```typescript
interface JobHandlerContext {
  // Job input
  jobId: string;
  executedAt: Date;
  runCount: number;

  // Plugin info
  pluginId: string;
  pluginVersion: string;
  workdir: string;
  outdir: string;

  // ✅ SECURITY: Sandboxed file system (ОБЯЗАТЕЛЬНО использовать!)
  runtime: {
    fs: {
      readFile(path: string, options?: ReadFileOptions): Promise<string | Buffer>;
      writeFile(path: string, data: string | Buffer, options?: WriteFileOptions): Promise<void>;
      mkdir(path: string, options?: MkdirOptions): Promise<void>;
      readdir(path: string): Promise<string[]>;
      stat(path: string): Promise<Stats>;
      unlink(path: string): Promise<void>;
      // ... другие fs методы с permissions enforcement
    };
  };

  // Output для structured logging
  output?: {
    info(message: string, data?: any): void;
    warn(message: string, data?: any): void;
    error(message: string, data?: any): void;
  };
}
```

**⚠️ КРИТИЧНО:** Всегда используйте `ctx.runtime.fs` вместо `import fs from 'node:fs'`! Прямой доступ к fs обходит sandbox и нарушает безопасность.

## Security & Permissions

### Почему Sandbox важен?

Background jobs запускаются автоматически по расписанию, БЕЗ участия пользователя. Это делает их потенциальным вектором атаки:
- Зловредный код может читать sensitive files (`.env`, `.pem`, `.key`)
- Может писать в критичные директории (`node_modules/`, `.git/`)
- Может выполнять arbitrary shell команды
- Может превышать quota (CPU, memory, time) и DDoS'ить систему

**Решение:** Jobs выполняются в sandbox с explicit permissions.

### Как работает Sandbox?

1. **Job объявляет permissions** в `defineJob()`:
   ```typescript
   permissions: permissions.combine(
     permissions.presets.pluginWorkspace('template'),
     { quotas: { timeoutMs: 10000, memoryMb: 64, cpuMs: 5000 } }
   )
   ```

2. **JobsManager передает permissions в execute()**:
   ```typescript
   await execute({ handler, input, manifest, perms: jobPermissions }, ctx);
   ```

3. **execute() создает sandboxed runtime**:
   ```typescript
   const runtime = buildRuntime(perms, ctx, env, manifest, ...);
   ```

4. **Handler получает ctx.runtime.fs с enforcement**:
   - Каждый fs call проверяется против `permissions.fs.allow` и `permissions.fs.deny`
   - Quota enforcement: timeout, memory, CPU limits
   - Attempts to access forbidden paths → throws Error

### Permission Presets

**pluginWorkspace** - Доступ к `.kb/{namespace}/`:
```typescript
permissions.presets.pluginWorkspace('template')
// Результат:
{
  fs: {
    mode: 'readWrite',
    allow: [
      '.kb/template',      // Директория (для mkdir)
      '.kb/template/**',   // Файлы внутри
      'package.json',
      '**/package.json',
    ],
    deny: [
      '**/*.key',
      '**/*.secret',
      '**/*.pem',
      '**/*.env',
      '**/node_modules/**',
      '**/.git/**',
    ],
  },
  quotas: {
    timeoutMs: 60000,
    memoryMb: 512,
    cpuMs: 30000,
  },
}
```

**llmApi** - Доступ к LLM providers:
```typescript
permissions.presets.llmApi(['openai', 'anthropic'])
// Результат:
{
  net: {
    allowHosts: ['api.openai.com', 'api.anthropic.com', 'localhost'],
  },
  env: {
    allow: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  quotas: {
    timeoutMs: 120000, // LLM calls can be slow
    memoryMb: 512,
    cpuMs: 60000,
  },
}
```

**vectorDb** - Доступ к vector databases:
```typescript
permissions.presets.vectorDb(['qdrant'])
// Результат:
{
  net: {
    allowHosts: ['*.qdrant.io', 'localhost:6333'],
  },
  env: {
    allow: ['QDRANT_URL', 'QDRANT_API_KEY'],
  },
}
```

**Комбинирование permissions:**
```typescript
permissions: permissions.combine(
  permissions.presets.pluginWorkspace('mind'),
  permissions.presets.llmApi(['openai']),
  permissions.presets.vectorDb(['qdrant']),
  {
    // Custom overrides
    quotas: {
      timeoutMs: 300000, // 5 minutes for heavy processing
      memoryMb: 1024,
      cpuMs: 180000,
    },
  }
)
```

### FS Access Enforcement

**Разрешенные операции:**
```typescript
// ✅ ALLOWED: Writing to plugin workspace
await ctx.runtime.fs.writeFile('.kb/template/data.json', JSON.stringify(data));

// ✅ ALLOWED: Reading from plugin workspace
const data = await ctx.runtime.fs.readFile('.kb/template/config.json');

// ✅ ALLOWED: Creating directories in workspace
await ctx.runtime.fs.mkdir('.kb/template/cache', { recursive: true });
```

**Запрещенные операции:**
```typescript
// ❌ DENIED: Reading sensitive files
await ctx.runtime.fs.readFile('.env'); // Throws: FS access denied

// ❌ DENIED: Writing outside workspace
await ctx.runtime.fs.writeFile('../../etc/passwd', 'hack'); // Throws: FS access denied

// ❌ DENIED: Accessing node_modules
await ctx.runtime.fs.readdir('node_modules'); // Throws: FS access denied
```

### Quota Enforcement

**timeoutMs** - Maximum execution time:
```typescript
quotas: { timeoutMs: 10000 } // 10 seconds

// Job exceeds timeout → automatically killed
async handler(input, ctx) {
  await sleep(15000); // ❌ Killed after 10 seconds
}
```

**memoryMb** - Maximum memory usage:
```typescript
quotas: { memoryMb: 64 } // 64 MB

// Job exceeds memory → throws error
async handler(input, ctx) {
  const bigArray = new Array(100_000_000); // ❌ OOM error
}
```

**cpuMs** - Maximum CPU time:
```typescript
quotas: { cpuMs: 5000 } // 5 seconds CPU

// Job exceeds CPU → throttled or killed
async handler(input, ctx) {
  for (let i = 0; i < 1e10; i++) {} // ❌ Throttled
}
```

### Shell Permissions (опционально)

Если job нужен shell access (например, для git commands):

```typescript
permissions: permissions.combine(
  permissions.presets.pluginWorkspace('template'),
  {
    shell: {
      allow: [
        'git status',
        'git log --oneline -n 10',
      ],
      deny: ['**'], // Deny everything else
    },
    capabilities: ['shell-exec'], // Required для ctx.runtime.shell
  }
)

// В handler:
async handler(input, ctx) {
  const result = await ctx.runtime.shell.exec('git status');
  console.log(result.stdout);
}
```

**⚠️ WARNING:** Shell access - это мощный инструмент. Используйте с осторожностью!

### Debug Mode для Development

При разработке можно включить inprocess mode для быстрой итерации:

```bash
# Enable debug mode (uses inprocess runner instead of subprocess)
KB_LOG_LEVEL=debug KB_JOBS_DEBUG=true node ./kb-labs-core/packages/core-state-daemon/dist/bin.cjs
```

**Inprocess mode:**
- ✅ Быстрее (no process spawn overhead)
- ✅ Легче дебажить (breakpoints работают)
- ✅ Sandbox все равно работает (permissions enforced)
- ⚠️ Но: не изолирован от memory leaks

**Production mode (subprocess):**
- ✅ Полная изоляция (separate process)
- ✅ Memory safety (OOM не убьет daemon)
- ✅ Crash resilience (job crash не влияет на daemon)
- ⚠️ Но: медленнее (process spawn ~50-100ms)

## Пример: Периодическая очистка

```typescript
// src/jobs/cleanup.ts
export async function run(ctx: CronContext) {
  const cacheDir = path.join('.kb', 'template', 'cache');

  const files = await fs.readdir(cacheDir);
  const now = Date.now();
  let cleaned = 0;

  for (const file of files) {
    const filePath = path.join(cacheDir, file);
    const stats = await fs.stat(filePath);

    // Удалить файлы старше 7 дней
    if (now - stats.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
      await fs.unlink(filePath);
      cleaned++;
    }
  }

  ctx.logger.info(`Cleaned ${cleaned} old cache files`);

  return { ok: true, cleaned };
}
```

**Манифест:**
```typescript
jobs: [
  {
    id: 'cleanup',
    handler: './jobs/cleanup.js#run',
    schedule: '@daily', // Каждый день в полночь
    describe: 'Clean old cache files',
  },
]
```

## Пример: Отчет по статистике

```typescript
// src/jobs/daily-report.ts
export async function run(ctx: CronContext) {
  // Собрать статистику за последний день
  const stats = await collectDailyStats();

  // Сохранить отчет
  const reportPath = path.join('.kb', 'template', 'reports',
    `daily-${ctx.executedAt.toISOString().split('T')[0]}.json`);

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(stats, null, 2));

  ctx.logger.info('Daily report generated', { reportPath });

  return { ok: true, reportPath };
}
```

**Манифест:**
```typescript
jobs: [
  {
    id: 'daily-report',
    handler: './jobs/daily-report.js#run',
    schedule: '0 1 * * *', // Каждый день в 01:00
    describe: 'Generate daily statistics report',
  },
]
```

## Конфигурация через переменные окружения

Вы можете указать кастомные пути к манифестам через переменную окружения:

```bash
export KB_PLUGIN_MANIFESTS="path/to/plugin1/manifest.v2.js,path/to/plugin2/manifest.v2.js"
pnpm dev:start
```

По умолчанию используется:
- `kb-labs-plugin-template/packages/plugin-template-core/dist/manifest.v2.js`

## Best Practices

**DO ✅:**

**Security:**
- ✅ **ВСЕГДА используйте `defineJob()`** для type-safety и permissions
- ✅ **ВСЕГДА используйте `ctx.runtime.fs`** вместо `import fs from 'node:fs'`
- ✅ **Объявляйте минимальные permissions** - principle of least privilege
- ✅ **Используйте presets** (`pluginWorkspace`, `llmApi`) вместо custom permissions
- ✅ **Проверяйте paths** перед fs operations (avoid path traversal)
- ✅ **Validate input** - не доверяйте данным из `input`

**Development:**
- ✅ Используйте `ctx.logger` для structured logging (не `console.log`, see [Migration Guide](./MIGRATION-ui-output.md))
- ✅ Возвращайте структурированный результат (`{ ok: true, ... }`)
- ✅ Обрабатывайте ошибки gracefully (try/catch)
- ✅ Тестируйте jobs через manual trigger перед деплоем
- ✅ Используйте `KB_JOBS_DEBUG=true` для debug mode
- ✅ Документируйте permissions в комментариях

**Performance:**
- ✅ Используйте async/await (не блокирующие операции)
- ✅ Устанавливайте разумные quotas (timeout, memory, CPU)
- ✅ Избегайте memory leaks (cleanup resources)
- ✅ Используйте `.kb/{namespace}/cache/` для temporary data

**DON'T ❌:**

**Security:**
- ❌ **НИКОГДА не используйте `import fs from 'node:fs'`** - обходит sandbox!
- ❌ **Не используйте `eval()`, `Function()`, `child_process`** - security holes
- ❌ **Не храните secrets в коде** - используйте env vars через `permissions.env.allow`
- ❌ **Не пишите в system directories** (`/etc`, `/usr`, `/tmp`)
- ❌ **Не делайте unbounded network requests** - используйте `permissions.net.allowHosts`

**Development:**
- ❌ Не делайте долгие синхронные операции (блокируют event loop)
- ❌ Не забывайте про `timeout` - по умолчанию 10 секунд
- ❌ Не полагайтесь на глобальное состояние (jobs могут запускаться параллельно)
- ❌ Не используйте `process.exit()` (убьет daemon)
- ❌ Не используйте `process.env` напрямую - используйте `permissions.env.allow`

## Troubleshooting

### Job не загружается

**Проверьте логи:**
```bash
tail -f /tmp/kb-state-daemon.log
```

**Возможные проблемы:**
- Манифест не собран (`pnpm build`)
- Синтаксическая ошибка в handler
- Job отключен (`enabled: false`)

### Job не выполняется

**Проверьте статус:**
```bash
curl http://localhost:7777/jobs | jq
```

**Проверьте расписание:**
- Используйте https://crontab.guru для проверки cron expression
- Попробуйте manual trigger для тестирования

### Ошибка при выполнении

Проверьте логи State Daemon:
```bash
tail -100 /tmp/kb-state-daemon.log | grep "Job execution failed"
```

## Архитектура

```
┌─────────────────────────────────────────┐
│         State Daemon Process            │
│  ┌───────────────────────────────────┐  │
│  │      JobsManager                  │  │
│  │  - loadPluginJobs()               │  │
│  │  - listJobs()                     │  │
│  │  - triggerJob()                   │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │      CronManager                  │  │
│  │  - register(id, schedule, fn)     │  │
│  │  - trigger(id)                    │  │
│  │  - pause/resume                   │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │      HTTP Server (:7777)          │  │
│  │  GET  /jobs                       │  │
│  │  POST /jobs/:id/trigger           │  │
│  │  GET  /jobs/stats                 │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Roadmap

См. [docs/tasks/TASK-002-state-daemon-plugin-discovery.md](../../docs/tasks/TASK-002-state-daemon-plugin-discovery.md) для планов по улучшению:

- [ ] Lightweight plugin discovery (без cli-commands зависимостей)
- [ ] Hot-reload jobs при изменении манифеста
- [ ] Redis persistence для distributed setup
- [ ] Quota enforcement per-plugin
- [ ] Job execution history в State Broker
- [ ] Webhooks для уведомлений об ошибках

---

**См. также:**
- [State Daemon README](../../../kb-labs-core/packages/core-state-daemon/README.md)
- [CronManager source](../../../kb-labs-core/packages/core-runtime/src/core/cron-manager.ts)
- [TASK-002: Plugin Discovery](../../docs/tasks/TASK-002-state-daemon-plugin-discovery.md)
