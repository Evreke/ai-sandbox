# Архитектурный гайдлайн: исправление причин багов watcher в pi-delegate

**Статус:** нормативный гайдлайн для правок control-plane доставки событий  
**Объект:** pi-delegate — живой нормативный документ, актуален для 1.17.0 (layout v3; watcher stages A–C на main — коммиты `538f9b1` / `9b8fde5` / `ef33ec9`)  
**Вне scope (явно):** системный daemon на всю машину; non-blocking redesign tool `delegate`; смена Transport/herdr; «delegate без файлов» как обязательный первый шаг  
**Дата:** 2026-09-11 (обновлён для 1.17.0)  

Этот документ задаёт **обязательные правила** для изменений, которые чинят классы багов:

- сообщение ушло **не тому** оркестратору;
- сообщение ушло **повторно**;
- сообщения **не было**, хотя факт на диске/host был.

Гайдлайн **не** заменяет DESIGN.md целиком. С 1.17.0 DESIGN.md синхронизирован с layout v3; при конфликте приоритет у фактического кода + этого гайдлайна в части **delivery policy**.

---

## 0. Термины (обязательные)

Использовать эти значения без подмены смысла.

| Термин | Определение |
|--------|-------------|
| **Session** | Один runtime-экземпляр pi (один process + один session file / session identity, доступный через `sessionManager.getSessionFile()` или согласованный эквивалент). |
| **Audience** | Session, которой **разрешено** получить wake-up по конкретному worker-событию. |
| **Owner** | Идентификатор session, записанный при spawn как владелец worker’а (см. §3). Owner и Audience для wake должны совпадать после успешного resolve. |
| **Worker** | Запись в exchange manifest + соответствующий agent на host (herdr), порождённая `delegate` (или probe-путём того же пайплайна). |
| **Fleet / task** | Exchange directory + `manifest.json` с набором worker entries. |
| **Control plane** | Manifest fields, ownership, mount/stop watcher, dedup/outbox, live status с host, доставка `sendUserMessage`. **Не** должен зависеть от корректности JSON, который сгенерировала LLM. |
| **Result plane** | Артефакты результата/диалога, которые **должна** породить модель: в первую очередь `report-*.json`, `q-*.json`. Ошибки модели здесь — ожидаемый класс, не «баг router’а». |
| **WatchEvent** | Кортеж `(workerName, taskDir, kind, fingerprint?, observedAt)`. |
| **Fingerprint** | Стабильный идентификатор *конкретного* факта данного kind (например mtime report, ts вопроса). Для kind’ов «однократно на эпизод» fingerprint может быть фиксированным/пустым по правилу §5. |
| **Delivery key** | `(audienceSessionId, workerName, taskDir, kind, fingerprint)`. Единица дедупа и outbox. |
| **Wake** | Доставка текста follow-up в Audience через `pi.sendUserMessage` (или согласованный эквивалент **внутри той же session**). |
| **Fail-closed (ownership)** | Нет доказанного Owner/Audience → **не** deliver. |
| **Fail-open (ownership)** | Нет Owner → deliver шире, чем одному Owner. **Запрещён** для новых путей; legacy — только по §3.5. |
| **Local watcher** | Watcher in-process текущей session (текущая архитектура). Не daemon. |

---

## 1. Цели и неголы

### 1.1. Цели

1. Один и тот же WatchEvent не должен быть доставлен **двум** разным Audience при корректно заполненном Owner.  
2. Один и тот же Delivery key не должен быть доставлен **дважды** одной Audience после успешного commit доставки (включая restart session — см. §5).  
3. Если факт на control plane наблюдаем и Audience жива и смонтировала watcher, отсутствие wake не должно объясняться «потеряли в seen».  
4. Ошибки result plane (нет report / invalid report) должны давать **явные** состояния, отличимые от сбоя router’а.  
5. Любой fix watcher’а должен либо соответствовать этому гайдлайну, либо явно амnesty’ить исключение в DESIGN/CHANGELOG с датой снятия.

### 1.2. Неголы (сейчас)

1. Не строить system-wide daemon.  
2. Не требовать отказа от exchange-файлов в первом этапе.  
3. Не менять completion criterion collect: успех collect = validated report (как в текущем контракте tool).  
4. Не смешивать в одном PR: delivery policy + полный разрез `spawn.ts` + смену default exchange root.  
5. Не «чинить» LLM-промахи усложнением ownership.

---

## 2. Разделение control plane и result plane

### 2.1. Правило

Код доставки (detect → audience → dedup → send) **обязан** разделять:

- **Наблюдение control plane** (manifest, host status, stamps, outbox);
- **Наблюдение result plane** (report/q содержимое и schema).

### 2.2. Обязательные следствия

1. Решение **кому** слать принимается **только** по control plane (Owner + registration/mount identity session). Содержимое report **не** влияет на Audience.  
2. Решение **какой kind** для report-ветки (`report-ready` vs `report-invalid` vs «нет report») опирается на result plane; это не повод ослаблять ownership.  
3. Баг «не тот оркестратор» **всегда** классифицируется как дефект control plane, даже если в том же инциденте report был битый.  
4. Баг «тишина при отсутствии report» **не** классифицируется как дефект dedup, если detect честно не видел файла: это result plane / worker behavior.  
5. Документация и тексты wake обязаны не называть LLM-промах «watcher failed».

### 2.3. Запрет

Запрещено добавлять эвристику вида: «если report интересный — разбудим всех session на machine».  
Запрещено использовать fail-open ownership «чтобы не потерять report-ready».

---

## 3. Ownership (причина класса «не тому»)

### 3.1. Инвариант

> Для каждого worker entry, по которому разрешён wake, существует ровно один Owner session id. Wake по этому worker допускается **только** в session, чей id совпадает с Owner (с учётом §3.4 tier-1).

### 3.2. Каноническое поле

- **Канон:** `orchestratorSessionPath` на **worker entry** в manifest (значение = session file path оркестратора на момент spawn, тот же идентификатор, что использует mount gate).  
- **Дополнительно:** `masterSessionPath` на task-level может существовать для fleet accounting; для **wake routing** канон — worker-level Owner.  
- **Сравнение session-путей (с 1.17.0, TZ windows §3.4):** любое сравнение «owner vs self» / «self vs worker entry» идёт через ЕДИНСТВЕННЫЙ хелпер `sameSessionPath(a, b, platform)` (`src/watch-role.ts`), не через raw-сравнение строк: POSIX — байт-идентичное `===` (без casefold и свёртки разделителей — на case-sensitive ФС это разные файлы); win32 — casefold + свёртка `/` и `\` (дрейф регистра/разделителей между писателем и читателем не делает пути разными). Call sites: `workerAudienceMatch`, `sessionRole` (isWorker + ownsChildren), watch-detect isSelf, leaf-worker gate в `watcher.ts`. Регрессии: `test/ownership-check.ts` W1–W5, `test/watcher-check.ts` W21.1 (posix: различие регистра глушит доставку) / W21.2 (win32: дрейф регистра всё ещё доставляет).  
- Запрещено вводить третий «почти owner» без удаления старых правил из detect.

### 3.3. Кто пишет Owner

1. **Только spawn-путь** (код в `spawn.ts` / эквивалент), сразу при append manifest entry, **до** или атомарно с появлением entry, которую может увидеть scan.  
2. Watcher **никогда** не присваивает Owner «угадыванием».  
3. Если spawn не смог получить session id:  
   - **предпочтительно:** fail spawn с явной ошибкой control plane (не оставлять worker без Owner);  
   - **допустимо временно:** не регистрировать worker для wake (entry помечена `wakeEligible: false` или отсутствует owner → detect возвращает пусто **fail-closed**).  
4. Запрещено оставлять production-путь «worker в manifest + wakeEligible по умолчанию + owner отсутствует + fail-open deliver».

### 3.4. Роли session (таблица обязательна в коде или DESIGN)

| Роль | Определение | Mount local watcher? | Получает wake по worker W? |
|------|-------------|----------------------|----------------------------|
| **Pure orchestrator** | Не является worker entry ни в одном live manifest; является Owner своих worker’ов | Да | Да, если Owner(W) = эта session |
| **Pure worker** | Является worker entry; не Owner ни одного child worker | Нет | Нет (не audience флота) |
| **Worker-orchestrator (tier-1)** | Является worker entry родителя **и** Owner своих child worker’ов | Да | Да **только** для W, где Owner(W) = эта session; нет для siblings родителя |
| **Foreign** | Любая другая session | Неважно | Нет для W с чужим Owner |

Реализация mount gate и detect **обязаны** реализовывать одну и ту же таблицу. Расхождение «UI считает foreign, wake ушёл» или наоборот — дефект.

### 3.5. Legacy manifests без Owner

1. Новые spawns **всегда** пишут Owner.  
2. Legacy (нет `orchestratorSessionPath`):  
   - **Целевое правило:** fail-closed — **ноль** wake (факт может логироваться в audit file).  
   - Переходный период (если нужен): только при явном config `watch.legacyFailOpen: true`, default **false** после миграционного релиза; пока true — поведение документировать как небезопасное на multi-session.  
3. Запрещено молчаливое fail-open как default «навсегда».

### 3.6. Self-id degradation

Если session не может прочитать свой session file:

- mount может остаться (или нет — одно правило на проект);  
- **deliver запрещён** (fail-closed), пока identity неизвестна;  
- audit: причина `E_WATCH_NO_SELF_ID` или аналог в log file.  

Запрещено: «identity неизвестна → шлём как раньше всем фактам».

### 3.7. Тесты ownership (обязательный минимум)

Комбинации, которые должны быть в automated checks:

1. Owner A, watcher A → deliver.  
2. Owner A, watcher B → no deliver.  
3. Legacy no owner, legacyFailOpen false → no deliver.  
4. Tier-1 lead: child Owner=lead → deliver lead; parent worker sibling → no deliver lead.  
5. Pure worker session → watcher not mounted (или mounted but no deliver — одно зафиксировать и тестировать).  
6. Missing self-id → no deliver.

---

## 4. Mount и lifecycle local watcher

### 4.1. Инварианты

1. Watcher не переживает session: `session_shutdown` → stop, таймеры cleared.  
2. Double `session_start` не создаёт два независимых tick loop без stop предыдущего (idempotent replace).  
3. Mount decision использует **ту же** role table, что §3.4.  
4. Headless/rpc: mount разрешён, если есть способ deliver; если `sendUserMessage` отсутствует — watcher может tick’ать в audit-only режиме, но **не** обязан притворяться, что wake доставлен.

### 4.2. Запрет

Запрещено монтировать «глобальный» in-process watcher в первой session с broadcast на все manifests без Owner filter «как временную замену daemon».

---

## 5. Exactly-once delivery (причина класса «повторно» / части «тишина»)

### 5.1. Инвариант

> Успешная доставка Wake для Delivery key K commit’ится в **durable** состояние до или атомарно с момента, после которого система считает deliver завершённым. Memory-only `seen` **не** является достаточным источником истины across session restart.

### 5.2. Outbox / delivered store

**Требование:** единый механизм для **всех** `WatchEventKind`, не только report-*.

Минимальная модель записи:

```text
DeliveryRecord {
  audienceSessionId: string
  workerName: string
  taskDir: string
  kind: WatchEventKind
  fingerprint: string   // canonical string; for one-shot kinds use constant e.g. ""
  deliveredAt: string   // ISO
  // optional: message hash / schema version
}
```

Где хранить (допустимые варианты, выбрать один и не плодить параллельные stamp-поля без необходимости):

- per-task file under exchange dir, **или**
- per-session file under `~/.pi/agent/...`, **или**
- records embedded in manifest worker entry **по единой схеме**.

**Запрещено:** для kind A — `notifiedReportMtime`, для kind B — только memory `seen`, для kind C — отдельный ad-hoc marker file без общей схемы ключей.

### 5.3. Алгоритм тика (нормативный)

На каждом tick, для каждой session с mounted watcher:

1. `snapshot = observe(control plane + result plane sensors)`  
2. `events = detect(snapshot)` — чистая функция по возможности  
3. `events = filter(events, audience = self)` — ownership §3  
4. Для каждого event вычислить `key = deliveryKey(event, self)`  
5. Если `key` уже в delivered store → skip  
6. Собрать batch из ещё не delivered  
7. Попытка `sendUserMessage(batchText)`  
8. **Только при успехе send** → append delivered records для всех key batch  
9. При неуспехе send → **не** писать delivered; next tick может повторить  

Memory `seen` допустим **только** как кэш одного процесса, восстанавливаемый из durable store при старте или всегда сверяемый со store.

### 5.4. Fingerprint rules (строгие)

Каждый kind обязан иметь документированное правило fingerprint:

| Kind | Fingerprint | Повтор при том же fingerprint |
|------|-------------|-------------------------------|
| `report-ready` | report file mtime (или content hash, если введён) | Нет |
| `report-invalid` | report mtime + validator error class (опционально) | Нет для того же mtime |
| `mailbox-question` | question file ts / content id | Нет; новый q → новый fingerprint |
| `nudge-failed` | marker ts | Нет для того же marker |
| `grill-deck` | count or last invocation id | По правилу «новый deck instance» |
| `context-critical` | one-shot per «episode» (например sessionPath + generation counter) | Один раз на эпизод |
| `worker-dead` | one-shot per death episode | Один раз на эпизод |
| `worker-stale` | `collectedAt` value | Новый collect stamp → новый key |

Запрещено: kind без правила fingerprint в DESIGN/гайдлайне.

### 5.5. Взаимодействие с `collectedAt`

- `collectedAt` означает: **collect tool** успешно принял report (product meaning).  
- Delivered store означает: **wake уже отправляли** Audience.  
- Это разные факты.  
- После collect: report-ready/invalid для этого report fingerprint не должны слаться (либо collect пишет delivered, либо detect видит collectedAt и не эмитит — **одно** правило, задокументировать).  
- Запрещено полагаться только на memory seen для «уже collect’или в прошлой session».

### 5.6. Transient FS / host errors

1. Transient ENOENT / unreachable host **не** должны стирать durable delivered keys.  
2. Transient «факт пропал на один tick» **не** должен сбрасывать in-memory state так, чтобы при том же fingerprint снова deliver.  
3. `worker-dead` не эмитить, если host statuses неизвестны (уже принятое направление — закрепить тестом).

### 5.7. Тесты delivery (обязательный минимум)

1. deliver → restart watcher/session → same key → no second deliver.  
2. send fails → no durable write → retry delivers once.  
3. report rewrite new mtime → new fingerprint → deliver again.  
4. collectedAt set → no report-ready for that report.  
5. batch of two events → one wake message → both keys committed or neither (предпочтительно all-or-nothing на batch commit).

---

## 6. Result plane: LLM-файлы как ненадёжный датчик

### 6.1. Инвариант

> Отсутствие или невалидность report/q — валидный исход worker’а с точки зрения датчика, не сбой Ownership/Outbox.

### 6.2. Обязательные наблюдаемые состояния (имена kind могут совпадать с текущими)

1. Report отсутствует после settle/death/timeout window → явный kind или явная ветка в `worker-dead` / отдельный `report-missing` (если вводите — правило fingerprint + outbox обязательно).  
2. Report есть, schema fail → `report-invalid`.  
3. Report есть, schema ok → `report-ready`.  
4. `q-*.json` валидный envelope → `mailbox-question`.  
5. Битый q-файл → audit + не маскировать под report-ready.

### 6.3. Запрет

1. Запрещено «усиливать» delivery fail-open, чтобы компенсировать ненадёжность LLM-файлов.  
2. Запрещено считать path report частью Owner.  
3. Исправления «модель забыла report» делаются в spawn prompt / schema echo / probe / retry policy (`spawn`), не в ownership filter.

### 6.4. Долгосрок (не блокер текущего гайдлайна)

Когда result signal переедет с «LLM пишет файл» на «код принял структурированный результат», control plane правила §3–§5 **сохраняются**; меняется только sensor result plane.

---

## 7. Границы модулей при реализации

### 7.1. Где живёт policy

| Concern | Модуль (layout v3, DESIGN.md §4.1) |
|---------|--------|
| Delivery key, durable delivered store, tick algorithm | `watch-detect.ts` (события + detection), `watch-store.ts` (durable `delivered-<key>.json`), `watcher.ts` (тик-цикл и доставка); `observe.ts` — только facade |
| Manifest fields Owner, collectedAt, schema paths | `manifest-store.ts` (facade `exchange.ts` сохранён для пере-экспортов) |
| Запись Owner при spawn; collectedAt при collect | `spawn.ts` (+ `manifest-store.ts`) |
| Mount/stop, role gate | канонический верdict — `watch-role.ts` (`sessionRole` + `workerAudienceMatch` + `sameSessionPath`); mount-решение — `compose.ts`; lifecycle — `watcher.ts` |
| Отображение ownership в UI | `fleet.ts` — **те же** правила Owner, без своей fail-open семантики |
| Host status / teardown | `host` / adapter — без knowledge о Audience |

### 7.2. Dependency rule (сохранить)

Tool/observe/fleet **не** импортируют herdr adapter напрямую. Transport inject из `index.ts`.

### 7.3. Каскад, который разрешён одним PR «delivery policy»

- `observe.ts`  
- поля + helpers в `exchange.ts`  
- запись Owner / согласование collectedAt в `spawn.ts`  
- mount gate в `index.ts`  
- tests: ownership, watcher delivery, legacy flag  
- README/DESIGN: ownership fail-closed, outbox, legacy  

### 7.4. Каскад, который запрещён «заодно» в том же PR

- полный разрез `spawn.ts` execute closure  
- system daemon  
- смена default `exchangeRoot`  
- изменение tool parameter schema `delegate` без необходимости  
- включение `watch.retire` default true  

---

## 8. Конфигурация

Допустимые ключи (имена могут быть согласованы с существующим `watch.*`):

```json
{
  "watch": {
    "intervalMs": 10000,
    "legacyFailOpen": false,
    "durableDelivery": true,
    "retire": false,
    "retireTtlMs": 900000
  }
}
```

Правила:

1. `legacyFailOpen` default **false** в целевом состоянии гайдлайна (с 1.17.0 — фактический default; stage A, коммит `538f9b1`).  
1a. `durableDelivery` (с 1.17.0, stage B, коммит `9b8fde5`) default **true** — durable store `delivered-<key>.json` в task dir; аварийный rollback без новой версии: `false` (не-boolean значение предупреждает один раз и остаётся true).  
2. Неизвестный ключ — ignore или warn-once; не enable опасных путей.  
3. Любой новый kind, требующий config, документируется до merge.

---

## 9. Audit и наблюдаемость

1. Routine success retire/deliver **не** обязаны спамить TUI; audit file (`delegate-watch.log` или преемник) — да.  
2. Каждый skipped deliver из-за ownership → возможен debug-level audit с Owner vs self.  
3. Каждый failed send → audit с причиной; durable not written.  
4. Запрещено единственным сигналом о баге считать «пользователь не получил follow-up» без audit trail.

---

## 10. Процесс изменения (строгий)

Любой PR, трогающий detect/ownership/dedup/mount:

1. **Классификация бага:** wrong-audience | duplicate | silent-control | silent-result | other.  
2. **Ссылка на раздел гайдлайна**, который нарушен или ужесточается.  
3. **Тест**, воспроизводящий класс (не только «похоже на инцидент»).  
4. **Запрет** чинить wrong-audience через расширение fail-open.  
5. **Запрет** чинить duplicate только memory `seen` без durable key.  
6. **Запрет** чинить silent-result усложнением router’а.  
7. Обновление fingerprint table / role table, если менялись kind или роли.  
8. CHANGELOG: user-visible behavior (legacy fail-closed!) отдельной строкой.

---

## 11. Поэтапный план внедрения (рекомендуемый порядок)

> **Статус (1.17.0):** этапы A, B и C выполнены — коммиты `538f9b1` (stage A:
> fail-closed ownership по умолчанию, единая role table, rollback
> `watch.legacyFailOpen`), `9b8fde5` (stage B: durable delivery store
> `delivered-<key>.json`, commit после успешного send), `ef33ec9` (stage C:
> явные result-plane состояния missing/invalid/ready + mount-gate identity
> fix). Остался этап D (будущее).

### Этап A — зафиксировать правила без большого storage redesign

1. Role table §3.4 в DESIGN + код mount/detect согласованы.  
2. Default fail-closed без Owner; config legacyFailOpen.  
3. Запрет deliver без self-id.  
4. Тесты §3.7.  
5. Документация: multi-session + Owner.

**Останавливает:** bystander wakes на новых spawns; сужает legacy.

### Этап B — единый durable delivery store

1. Ввести DeliveryRecord для всех kind.  
2. Алгоритм §5.3.  
3. Миграция: `notifiedReportMtime` / ad-hoc markers → читаются как legacy input в store один релиз, затем deprecate.  
4. Тесты §5.7.

**Останавливает:** duplicates after restart; разнобой stamp-схем.

### Этап C — выравнивание result-plane сигналов

1. Явные ветки missing/invalid/ready без путаницы с router failure.  
2. Усиление spawn prompt/schema (отдельные PR).  
3. Не открывать fail-open.

### Этап D (будущее, не сейчас)

1. Result signal не только LLM-file.  
2. Optional: system daemon — только после стабильных §3–§5.

---

## 12. Антипаттерны (запрещены)

1. «Потеряли wake — давайте fail-open.»  
2. «Повторы — добавим ещё одно поле mtime только для этого kind.»  
3. «Тишина — dilate interval / sleep в tool.»  
4. «Временный broadcast из первой session.»  
5. «Owner запишем позже, если session Manager оживёт.» без блокировки wakeEligible.  
6. «UI ownership отдельно от detect ownership.»  
7. «Исправим herdr tab id и заодно перепишем dedup.» в одном несвязанном PR без тестов delivery.  
8. «Модель иногда ошибается — watcher должен угадывать audience по содержимому report.»

---

## 13. Критерии готовности (definition of done для программы)

Программа исправления причин (не один hotfix) считается достигнувшей целевого состояния, когда:

1. На multi-session machine с корректными Owner **нет** deliver на Foreign в тестах и в field policy.  
2. После успешного wake + restart session **нет** повторного deliver того же Delivery key.  
3. Нет production default fail-open ownership.  
4. Все WatchEventKind перечислены в fingerprint table и пишут в один delivered store.  
5. Field report’ы классифицируются по §10; silent-result не открывает control-plane regressions.  
6. DESIGN module map и этот гайдлайн не противоречат друг другу в части ownership/delivery.

---

## 14. Краткая сводка для исполняющего агента

- **Wrong audience** → только ownership fail-closed + единая role table + обязательная запись Owner при spawn.  
- **Duplicates** → только durable Delivery key для всех kind + commit after successful send.  
- **Silent when fact existed on control plane** → не стирать keys на transient errors; не требовать memory seen; audit failed send.  
- **Silent when LLM did not write report** → result plane; не трогать fail-open; улучшать spawn/contract отдельно.  
- **Daemon / no-files** → не сейчас.  
- **Один PR = один этап A или B или C**, без смешения с большим spawn refactor.

---

*Конец гайдлайна.*
