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

### What you get

- **Non-blocking spawn.** A `delegate` call proves the worker started (~15 s) and releases.
  A fan-out of five workers is five parallel calls — not five evenings of panel-watching.
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

You write one word — **delegate** — plus the task description. The rest is emergent:

1. the orchestrator decomposes the task and writes briefs per role;
2. workers spawn in parallel (worktree-isolated, model-tiered: cheap `flash` for execution,
   `frontier` for review and synthesis);
3. you do something else — the watcher queues every signal and wakes you at the right moment;
4. clarifications go through the mailbox; a smoke-test probe can verify the environment
   before a big fan-out;
5. strict reports come back, workers are torn down, the fleet cleans up after itself.

Judgment stays with the model (decomposition, verification, merge); mechanics belong to code.

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

### Что это даёт

- **Неблокирующий спавн.** Вызов `delegate` доказывает, что воркер стартовал (~15 с), и
  отпускает. Фан-аут из пяти воркеров — пять параллельных вызовов, а не пять вечеров
  наблюдения за панелями.
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

Вы пишете одно слово — **delegate** — и описание задачи. Дальше эмерджентность:

1. оркестратор раскладывает задачу и пишет брифы по ролям;
2. воркеры спавнятся параллельно (изоляция worktree, тиры моделей: дешёвый `flash` для
   исполнения, `frontier` для ревью и синтеза);
3. вы занимаетесь своим — вотчер копит сигналы и будит в нужный момент;
4. уточнения идут через почтовый ящик; перед большим фан-аутом smoke-проба проверит среду;
5. возвращаются строгие отчёты, воркеры закрываются, флот убирает за собой сам.

Суждение остаётся за моделью (декомпозиция, проверка, мерж), механика — за кодом.

### Установка

Скопируйте или засимлинкуйте расширение в `~/.pi/agent/extensions/pi-delegate/`, настройте
тиры моделей в `~/.pi/agent/pi-delegate.config.json` (одна строка) и стартуйте сессию pi.
Полная механика — в [DESIGN.md](./DESIGN.md).

---

Разница между «модель иногда справляется с субагентами» и «мультагентная разработка как
рабочий процесс» — в обвязке. Обвязка здесь.
