# Changelog

SDK 大版本为 v1(`versions/v1/`)。v1 的公开 API 只增不改;破坏性变更只会出现在新的大版本里。
版本号以 `versions/v1/sdk-version.json` 为准。未单独列出的版本是内部修复与宿主适配,公开 API 的变化以 `versions/v1/paranovell.d.ts` 为准。

The SDK major version is v1 (`versions/v1/`). The v1 public API is additive only; breaking changes only ship in a new major version.
The version number lives in `versions/v1/sdk-version.json`. Versions not listed below are internal fixes and host adaptations; see `versions/v1/paranovell.d.ts` for public API changes.

## 1.11.0

- 新增:SDK 加载后默认隐藏文档级(`html` / `body`)滚动条,整页仍可滚动;应用可在自己的样式中覆盖,容器内部的滚动条不受影响。
- Added: the SDK hides document-level (`html` / `body`) scrollbars by default; the page still scrolls and apps can override it in their own styles. Scrollbars inside your own containers are unaffected.

## 1.9.0

- 新增:`onRoundPending(cb)`。刷新 / 换设备后若上一轮正文仍在生成,先收到 `{ pending: true, round }`,结束时收到 `{ pending: false }`。
- Added: `onRoundPending(cb)`. After a refresh or device switch, if the previous round is still generating you first receive `{ pending: true, round }`, then `{ pending: false }` when it ends.

## 1.5.0

- 变更:刷新 / 崩溃后恢复上一轮时,默认自动重放已注册的 `defineRound` handler 并确认存档;`onRoundRecovery()` 降级为可选的覆盖钩子。handler 的写入必须只依赖 `data` 与本轮 `output`。
- Changed: when a round is recovered after a refresh or crash, the registered `defineRound` handler is replayed and confirmed automatically by default; `onRoundRecovery()` is now an optional override hook. A handler's writes must depend only on `data` and the round's `output`.

## 1.4.0

- 新增:`onRoundRecovery(cb)`,收到 `{ name, output, commit(), discard() }`。
- Added: `onRoundRecovery(cb)`, which receives `{ name, output, commit(), discard() }`.

## 1.2.0

- 变更:`on()` + `submit()` 合并为 `defineRound(name, { format, notes, example, handler })`,返回发起函数。
- Changed: `on()` + `submit()` are replaced by `defineRound(name, { format, notes, example, handler })`, which returns a sender function.

## 1.1.0

- 新增:`plan.list()` / `plan.create()` / `plan.restart()`。
- Added: `plan.list()` / `plan.create()` / `plan.restart()`.

## 1.0.0

- 首个版本:`ready()`、`data.*`、`save()`、`ui.*`、语言 API。
- Initial release: `ready()`, `data.*`, `save()`, `ui.*`, language API.
