# pi-delegate

**[English](#english)** · **[Русский](#русский)**

> One orchestrator — a whole team. Spawn a fleet of AI workers, walk away, and get woken up
> only when a report lands, a worker asks a question, or something breaks.
> **Один оркестратор — целая команда.** Заспавнил воркеров, ушёл заниматься своим —
> вотчер разбудит, когда будет нужен ход.

---

## English

**pi-delegate** is a multi-agent orchestration harness for [pi](https://github.com/badlogic/pi-mono).
It is not another subagent wrapper — it is the missing discipline: strict contracts instead of
hoping the model stays careful, code instead of a 100-line ritual the model must remember
from scratch every time.

### What it is

You stay the orchestrator: you describe the task, review briefs, verify reports, and own the
single merge gate. The extension owns the mechanics — one tool call replaces the entire
spawn-and-baby-sit ritual.

### Prerequisites

- **herdr on PATH — a hard requirement.** The extension drives a backend host through the
  `WorkerHost` seam; today the only production backend is herdr. Without the `herdr` CLI
  the tools do not work.
- **A resolvable tier/provider/model/thinking** — a named tier in
  `~/.pi/agent/pi-delegate.config.json` or explicit per-call params. There is no built-in
  tier; unresolved → `E_TIER`.
- **A brief before the call** — a non-empty file at an absolute path inside the exchange
  layout (`<exchangeRoot>/<task>/brief-<name>.md`). Missing, empty or outside the layout →
  `E_BRIEF`.
- **The exchange tree conventions** — manifests, reports, mailbox and progress files live
  next to the brief in the task dir; see [DESIGN.md](./DESIGN.md).

Success is defined by the artifact, not by the agent's mood: a `delegate` call succeeds when
a **validated JSON report** is on disk — never when the agent status says done/idle.

### What you get

- **Blocking by default.** A `delegate` call blocks the orchestrator session until the
  worker settles, the settle gate expires (default `watch.settleGateMs` — 15 s, just enough
  to prove the worker started), or you abort. Long blocking is explicit opt-in (`waitMs`).
- **Abort (Esc) cancels the wait, not the worker.** The call detaches; the worker keeps
  running. Recover via `delegate_status`, the mailbox, or the background watcher — the
  report file stays the completion criterion.
- **Optional early release.** With `releaseOn: "started"` (config or per-call) the call
  returns as soon as the worker is proven started and working — control passes to the
  background watcher. That is "the spawn is proven", not "the task is collected": the
  validated report still ends the job.
- **Parallel fan-out = parallel tool calls.** Each call carries its own brief and
  collect discipline; parallelism never removes the per-call preparation.
- **Event-driven watcher.** You are woken only when attention is needed: report ready or
  invalid, mailbox question, worker blocked on an interactive deck, context critical (≥90%),
  worker died without a report, collected-but-still-mounted worker. No `sleep 1500`.
- **File mailbox.** `q-<name>.json` / `a-<name>.json` — send follow-ups to a running worker
  or answer its questions without respawning it.
- **Strict reports.** The completion criterion is a **validated JSON report** with evidence
  (`file:line`), never a "done" status. Custom schemas via brief frontmatter, with
  `$extends` inheritance and a schema library.
- **Budgets & gauges.** Output-token caps per worker (`E_BUDGET` on breach), live `ctx%`
  and token counters, restart before compaction eats the worker.
- **Isolation.** Git worktree per worker (own checkout + branch) or shared tab — sub-
  orchestrators structurally cannot create worktrees.
- **Clean teardown.** Interactive `/delegate-teardown`, auto-cleanup after a collected
  report, full audit in `teardown.log`.
- **Honest errors.** Every refusal is a structured code with a recovery hint:
  `E_BRIEF`, `E_NAME`, `E_TIER`, `E_PLACE`, `E_START`, `E_TIMEOUT`, `E_BUDGET`, `E_CONTEXT`,
  `E_REPORT_MISSING`, `E_REPORT_INVALID`.

### How it automates the routine

Preparing a fan-out is real orchestration work, and the tool contract reflects it. "One
word — delegate — and it all happens" is the human UX aspiration this project steers
toward, not the machine contract of the tool today. What a call actually requires:

1. the orchestrator decomposes the task and writes briefs per role;
2. workers spawn via parallel tool calls, each with its own brief and collect discipline
   (worktree-isolated, model-tiered: cheap `flash` for execution,
   `frontier` for review and synthesis);
3. you do something else — the watcher queues every signal and wakes you at the right moment;
4. clarifications go through the mailbox; a smoke-test probe can verify the environment
   before a big fan-out;
5. strict reports come back, workers are torn down, the fleet cleans up after itself.

Judgment stays with the model (decomposition, verification, merge); mechanics belong to code.

### Operational notes

- **The exchange root is not a durable store.** The default location is `/tmp/exchange`:
  it is cleared on reboot, and on a multi-user host it is a shared path (other users can
  read the manifests; task-slug collisions are possible). The `PI_DELEGATE_EXCHANGE_ROOT`
  environment variable overrides it.
- Collected reports are copied to `~/.pi/agent/delegate-archive/<task>/` (best-effort,
  30-day TTL) — that archive is the durable copy.
- Watcher wake-ups are scoped to the owning session via ownership metadata and are
  FAIL-CLOSED by default: a manifest with no owner fields anywhere (legacy) delivers
  nothing — no bystander session is woken for a foreign fleet. The only rollback is the
  explicit config `watch.legacyFailOpen: true`, which is unsafe on a machine with several
  sessions. A session that cannot read its own identity delivers nothing unconditionally
  (no config escape).

### Install

Copy or symlink the extension into `~/.pi/agent/extensions/pi-delegate/`, configure model
tiers in `~/.pi/agent/pi-delegate.config.json` (one line), and start a pi session.
Full mechanics: [DESIGN.md](./DESIGN.md).

---

## Русский

**pi-delegate** — харнесс мультагентной оркестрации для [pi](https://github.com/badlogic/pi-mono).
Это не очередной враппер над субагентами — это недостающая дисциплина: строгие контракты
вместо надежды на аккуратность модели, код вместо 100-строчного ритуала, который модель
должна помнить с каждого раза.

### Что это

Вы — оркестратор: описываете задачу, проверяете брифы, верифицируете отчёты, держите
единственный мерж-гейт. Расширение владеет механикой — один вызов инструмента заменяет
весь ритуал «заспавнить и нянчить».

### Требования

- **herdr на PATH — жёсткое требование.** Расширение управляет backend-хостом через шов
  `WorkerHost`; единственный production-бэкенд сегодня — herdr. Без CLI `herdr`
  инструменты не работают.
- **Разрешимый tier/provider/model/thinking** — именованный тир в
  `~/.pi/agent/pi-delegate.config.json` или явные параметры вызова. Встроенного тира нет;
  не разрешилось → `E_TIER`.
- **Бриф до вызова** — непустой файл по абсолютному пути внутри exchange layout
  (`<exchangeRoot>/<task>/brief-<имя>.md`). Нет файла, пустой или вне layout → `E_BRIEF`.
- **Соглашения exchange-дерева** — manifest, отчёты, почтовые и progress-файлы лежат рядом
  с брифом в каталоге задачи; см. [DESIGN.md](./DESIGN.md).

Успех определяется артефактом, а не настроением агента: вызов `delegate` успешен, когда на
диске лежит **валидный JSON-отчёт**, — никогда не тогда, когда статус агента говорит
done/idle.

### Что это даёт

- **Блокирующий вызов по умолчанию.** Вызов `delegate` блокирует сессию оркестратора, пока
  воркер не осядет, не истечёт settle-гейт (по умолчанию `watch.settleGateMs` — 15 с,
  ровно чтобы доказать, что воркер стартовал), или вы не прервёте ожидание. Долгая
  блокировка — явный opt-in через `waitMs`.
- **Abort (Esc) отменяет ожидание, а не воркера.** Вызов отсоединяется (detach); воркер
  продолжает работать. Вернуться к нему можно через `delegate_status`, почтовый ящик или
  фоновый вотчер — критерий завершения по-прежнему файл отчёта.
- **Опциональное раннее отпускание.** С `releaseOn: "started"` (в конфиге или в вызове)
  вызов возвращается, как только доказано, что воркер стартовал и работает, — управление
  переходит фоновому вотчеру. Это «спавн доказан», а не «задача собрана»: валидный отчёт
  всё ещё является завершением работы.
- **Параллельный фан-аут = параллельные tool calls.** Каждый вызов несёт свой бриф и свою
  collect-дисциплину; параллельность не отменяет подготовку каждого вызова.
- **Event-driven вотчер.** Будит только когда нужен ход: отчёт готов или бит, вопрос через
  почтовый ящик, воркер завис на интерактивном grill-deck, контекст критический (≥90%),
  воркер умер без отчёта, собранный воркер всё ещё висит. Никаких `sleep 1500`.
- **Почтовый ящик.** `q-<имя>.json` / `a-<имя>.json` — докидывайте уточнения работающему
  воркеру и отвечайте на его вопросы без пересоздания.
- **Строгие отчёты.** Критерий завершения — **валидный JSON-отчёт** с evidence
  (`file:line`), а не «статус done». Свои схемы — во frontmatter брифа, с наследованием
  `$extends` и библиотекой схем.
- **Бюджеты и градусники.** Лимиты output-токенов (`E_BUDGET` при превышении), живые
  `ctx%` и счётчики токенов, рестарт до того, как компакшен съест воркера.
- **Изоляция.** Git worktree на воркера (свой чекаут + ветка) или общий tab — суб-
  оркестратор структурно не может создать worktree.
- **Чистая уборка.** Интерактивный `/delegate-teardown`, автоборка после собранного
  отчёта, полный аудит в `teardown.log`.
- **Честные ошибки.** Каждый отказ — структурный код с подсказкой:
  `E_BRIEF`, `E_NAME`, `E_TIER`, `E_PLACE`, `E_START`, `E_TIMEOUT`, `E_BUDGET`, `E_CONTEXT`,
  `E_REPORT_MISSING`, `E_REPORT_INVALID`.

### Как автоматизирует рутину

Подготовка фан-аута — настоящая оркестрационная работа, и контракт инструмента это
отражает. «Одно слово — delegate — и всё случилось» — это человеческое UX-желание, к
которому проект движется, а не machine contract инструмента сегодня. Что вызов требует
на самом деле:

1. оркестратор раскладывает задачу и пишет брифы по ролям;
2. воркеры спавнятся параллельными tool calls, каждый со своим брифом и collect-дисциплиной
   (изоляция worktree, тиры моделей: дешёвый `flash` для исполнения,
   `frontier` для ревью и синтеза);
3. вы занимаетесь своим — вотчер копит сигналы и будит в нужный момент;
4. уточнения идут через почтовый ящик; перед большим фан-аутом smoke-проба проверит среду;
5. возвращаются строгие отчёты, воркеры закрываются, флот убирает за собой сам.

Суждение остаётся за моделью (декомпозиция, проверка, мерж), механика — за кодом.

### Эксплуатационные заметки

- **Exchange-корень — не durable store.** Путь по умолчанию — `/tmp/exchange`: он
  очищается при ребуте, а на multi-user хосте это общий путь (другие пользователи могут
  читать манифесты; возможны коллизии task slug). Переменная окружения
  `PI_DELEGATE_EXCHANGE_ROOT` переопределяет его.
- Собранные отчёты копируются в `~/.pi/agent/delegate-archive/<task>/` (best-effort,
  TTL 30 дней) — архив и есть долговременная копия.
- Пробуждения вотчера ограничены сессией-владельцем через метки владения и по умолчанию
  fail-closed: манифест без полей владельца (legacy) не доставляет ничего — чужая сессия
  не получает wake по чужому флоту. Единственный откат — явный конфиг-ключ
  `watch.legacyFailOpen: true`; это небезопасно на машине с несколькими сессиями. Сессия,
  которая не может прочитать собственную идентичность, не доставляет ничего безусловно
  (конфигурационного выхода нет).

### Установка

Скопируйте или засимлинкуйте расширение в `~/.pi/agent/extensions/pi-delegate/`, настройте
тиры моделей в `~/.pi/agent/pi-delegate.config.json` (одна строка) и стартуйте сессию pi.
Полная механика — в [DESIGN.md](./DESIGN.md).

---

Разница между «модель иногда справляется с субагентами» и «мультагентная разработка как
рабочий процесс» — в обвязке. Обвязка здесь.
