# Sandbox App Developer Guide

English | [中文](guide.zh-CN.md)

This guide is for **developers who want to get an HTML app running inside the paranovell sandbox**. Exact API signatures live in [`versions/v1/paranovell.d.ts`](../versions/v1/paranovell.d.ts); the repository overview and quick-reference tables are in the [README](../README.en.md).

Contents:

1. Concepts
2. Quick start
3. The package and `paranovell.json`
4. Data and saving
5. The AI round lifecycle
6. Hooks
7. Presentation and canvas
8. Plans
9. Languages
10. The dev console
11. Packing, uploading and versions
12. Runtime restrictions
13. Error codes
14. Compatibility promise
15. FAQ

## 1. Concepts

- **Sandbox app**: a purely static HTML package (HTML / CSS / JS / any asset files) with no build step. It runs in an `<iframe sandbox="allow-scripts">` next to the novel reader (a WebView inside the native app).
- **`window.paranovell`**: the only channel between your app and the platform. Reading and writing data, starting AI rounds, switching presentation forms, reading the language and managing plans all go through it.
- **Data**: a JSON key-value save that belongs to "this novel + this app", persisted by the platform. Reads are synchronous (from memory); writes go into a local buffer first and the SDK sends them upstream, coalesced.
- **Round**: your app hands an input to the AI, the AI replies in the JSON shape you declared, your handler writes the reply into data, and the SDK then confirms the save automatically. During a round the platform guarantees "the whole round takes effect, or the whole round is rolled back".
- **Hook**: before the story text is generated, the model decides whether to query your app, and the result informs the text.
- **The sandbox has no origin**: your app has an opaque origin, which is the root of every runtime restriction in section 12.

## 2. Quick start

A minimal package needs just two files. `paranovell.json` (every field is optional; the smallest valid content is `{}`):

```json
{}
```

`index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>My first sandbox app</title></head>
<body>
  <div id="app">Loading...</div>

  <!-- Keep this exact file name and relative path; no type="module" / defer / async -->
  <script src="sdk.js"></script>
  <script>
    paranovell.ready().then(function () {
      var count = paranovell.data.get('count') || 0;
      var el = document.getElementById('app');
      el.textContent = 'Saved count: ' + count;
      el.onclick = function () {
        count += 1;
        paranovell.data.set('count', count);
        paranovell.save();
        el.textContent = 'Saved count: ' + count;
      };
    });
  </script>
</body>
</html>
```

From the repo root run `npm run dev` to load it in the dev console and `npm run pack <app folder>` to package it. `examples/hello` in this repo is a complete example that includes an AI round.

You do not need to supply `sdk.js` yourself: when the app folder has none, the dev console serves the current version, and after upload the platform replaces the root `sdk.js` with its current build.

## 3. The package and `paranovell.json`

**The manifest file itself is required**: the package root must contain `paranovell.json`, otherwise the upload is rejected (5406). But its **fields are all optional**: an empty object `{}` is a valid manifest.

| Field | Type | Required | Description |
|---|---|---|---|
| `appName` | string | no | Display name, at most 100 characters. Falls back to the upload form title; if both are empty a default name is used and a `default_name` warning is raised |
| `entry` | string | no | Relative path of the entry, default `index.html`; may point to any `.html` in the package but must exist, otherwise it is rejected (5406) |
| `canvases` | object | no | Canvas ratio declarations, see section 7. Raw size at most 64 KB |

"Is there a manifest" and "is the `entry` field right" are two independent checks:

- No `paranovell.json` at the package root: 5406.
- The manifest exists but declares no `entry` and the package has no `index.html`: 5402 (a package-structure problem).
- The manifest exists and `entry` is declared but points to a file that is not in the package: 5406.

Any file type may go in the package (`.wasm`, audio, video and extensionless files are fine). Do not include the debug files from `dev/`, and do not let your HTML reference `mock-host` / `paranovell-dev`, otherwise the upload is rejected (5402).

## 4. Data and saving

```js
await paranovell.ready();            // read and write only after this
paranovell.data.get('hp');           // read (deep copy); undefined when missing
paranovell.data.set('hp', 10);       // write: must be JSON-serializable, not null / undefined
paranovell.data.append('log', {});   // append to an array; a missing key counts as an empty array
paranovell.data.remove('tmp');       // delete
paranovell.save();                   // plain save
```

Points to know:

- **Writes take effect synchronously**: after `set` / `remove` / `append`, `get` immediately sees the new value; only the upstream send (persisting on the platform) waits for `save()` or a round confirmation.
- **`save()` throttling**: a call snapshots the buffer, and several calls within a 3 second window are coalesced into one upstream send. The SDK also flushes as a fallback when the page is hidden or loses focus. The returned Promise resolves once that snapshot is confirmed upstream.
- **`null` / `undefined` cannot be written**: use `remove()` to delete. `append` throws TypeError if the target key exists and is not an array.
- **Operation-log semantics**: the buffer is an ordered operation log (`set` / `remove` / `append`) and the order is the meaning; `data.pending()` shows what has not been sent yet.
- **Conflicts**: when the same save is written from elsewhere (for example another tab), `save()` rejects with `DATA_CONFLICT`. The server wins: the SDK has already overwritten memory with the authoritative data and cleared the buffer, so re-render from the new data.
- **Read-only sessions**: when viewing someone else's save, writes are not sent and `save()` rejects with `READONLY`.

## 5. The AI round lifecycle

Declare a kind of round:

```js
var askName = paranovell.defineRound('ask-name', {
  format: { name: '', reason: '' },                  // JSON shape expected from the model
  notes: 'Give the hero a two-syllable name and one sentence of reasoning', // instructions (optional)
  example: { name: 'Yun', reason: 'a wandering youth' },                    // sample (optional)
  handler: function (output) {                       // the single write point; may return a Promise
    paranovell.data.set('heroName', output.name);
  }
});
var res = await askName({ input: 'The hero is a young swordsman' }); // res.output is the model's reply
```

- `format`: a plain object or array. A `?` key suffix marks an optional field and a `null` value means any type. It is snapshotted at the moment of `defineRound`; mutating the object afterwards does not change what was sent.
- `notes` / `example`: instructions and a sample for the model. The SDK composes the lead-in in the current language.
- **Redefining the same name overrides it**, and old and new senders are equivalent (the current definition is looked up by name).
- Only one round can be in progress at a time; a second start rejects with `SUBMIT_IN_FLIGHT`.

How a round proceeds:

1. `sender({ input })` opens a round; the platform generates the story text and a JSON reply in your declared shape.
2. The SDK passes the reply to your handler; the handler (possibly async) writes the result into `data`.
3. After the handler finishes, the SDK **confirms the save** automatically, together with any snapshots not yet sent, and then the `sender` Promise resolves with `{ output }`.

Failure and rollback:

- If the handler throws, the SDK does not confirm the save, rolls the round back, and `sender` rejects.
- If the confirming save hits a network error, timeout or 5xx, the SDK retries with backoff (exponential from 1 second, capped at 30 seconds); when the platform explicitly refuses, it stops at once and finishes as a rollback.
- `DATA_CONFLICT`: the server data wins, local data is overwritten and the round does not take effect.
- `save()` does not send on its own during a round; the confirmation absorbs any snapshots not yet sent.

**Recovery after a refresh or device switch**: if a player sends and immediately refreshes or opens another device, the previous round may still be generating. The platform picks the round up in the background and, once the story text is done, **replays your registered `defineRound` handler of the same name and confirms the save automatically**. You do not need to write any code. Therefore:

- **Register every `defineRound` / `defineHook` before `ready()`**. Registering when the recovery arrives is too late (a round without a matching registration is abandoned and rolled back by the platform).
- **A handler's writes may depend only on `data` and this round's `output`.** Do not rely on intermediate state that lives only in a JS closure: it is gone after a refresh and the replay would silently compute the wrong thing without any error.
- To show your own "generating" UI during recovery, subscribe before `ready()`:

  ```js
  paranovell.onRoundPending(function (p) { showLoading(p.pending); });
  await paranovell.ready(); // on a new device this waits until the text is generated; pending is already true meanwhile
  ```

  `pending: false` means the round has ended (succeeded or abandoned). Not subscribing does not affect recovery itself.
- To decide how to recover yourself, subscribe with `onRoundRecovery(cb)`: you receive `{ name, output, commit(), discard() }`. Write the data into `data` yourself and call `commit()` to confirm, or `discard()` to abandon. Once subscribed the platform **no longer** replays automatically. Not subscribing does not mean giving up the round.

## 6. Hooks

A hook lets the model decide, **before generating the story text**, whether to ask your app, based on a natural-language condition:

```js
paranovell.defineHook('inventory-check', {
  trigger: 'when the story has the hero rummaging through or using carried items',
  input: function () { return JSON.stringify(paranovell.data.get('inventory') || []); },
  format: { found: true, note: '' },
  notes: 'Answer from the inventory whether the hero holds the item',
  handler: function (output) { /* same constraints as a defineRound handler */ }
});
```

- `trigger`: the trigger condition, judged by the model, written in natural language.
- `input()`: evaluated on every query and returns a string (empty by default); it **must not return a Promise**.
- `format` / `notes` / `example` / `handler`: same as `defineRound`.
- **At most one** hook per app, redefining overrides it; the name is trimmed first and must not clash with any `defineRound`; it must be registered before `ready()` so it can be recovered after a refresh.

## 7. Presentation and canvas

**Forms**: your app can request a presentation form, six in total: `'split'`, `'float'`, `'full'`, `'mfull'` (mobile full screen), `'mland'` (mobile landscape) and `'mdrawer'` (mobile drawer).

```js
var r = await paranovell.ui.present('full');
// r = { applied, degraded, reason? }  the host may degrade; trust applied
paranovell.ui.getPresentation();          // synchronous local snapshot { form, canvas, scale }, no request
var off = paranovell.ui.onPresentationChange(function (p) { /* includes host-initiated changes */ });
```

**Canvas**: only ratios are constrained, never pixels. Three keys: `portrait` / `landscape` / `compact`.

```js
await paranovell.ui.setCanvas({
  portrait: { safe: '9:16' },
  landscape: { safe: '16:9', bleed: { w: 1.2, h: 1.2 } }
});
```

`safe` is a `"w:h"` string whose ratio must be between 0.05 and 20; `bleed` is an optional background expansion factor with `w` / `h` each between 1 and 3. You can also write it in the manifest `canvases`. Invalid values reject with `INVALID_PARAM`. Until `ready()` has completed and the first change event has arrived, `form` / `canvas` in `getPresentation()` are `null`.

## 8. Plans

A plan is the novel's "plan" entity with four states: `processing` (generating / awaiting confirmation), `running` (in effect), `complete` (finished) and `discard` (discarded; only this state can be restarted).

```js
var plans = await paranovell.plan.list();               // newest first, includes the full content
var ref = await paranovell.plan.create({ title: '...', content: '...' });
await paranovell.plan.restart(planId);                   // only discarded plans can be restarted
```

`create` and `restart` are write operations: **the host shows an authorization prompt first**. Your app cannot skip it, cannot pre-check whether it will appear, and cannot change the prompt text. If the user refuses, it rejects with `USER_REJECTED` and no network request happens. Because it waits for the user, these calls can take noticeably longer than ordinary requests, and the SDK sets no timeout on them. `list()` is a pure read and shows no prompt.

## 9. Languages

The SDK knows the user's language, either `'zh'` or `'en'`:

```js
paranovell.getLanguage();                   // safe before ready(); follows the host by default
paranovell.onLanguageChange(function (lang) { /* switch your UI text */ });
paranovell.setLanguage('en');               // explicit override and lock; host pushes are ignored afterwards
```

- The language is updated both from the data pull in `ready()` and from host pushes, so you never need to poll.
- The lead-in that `defineRound` composes for the model follows the language, evaluated on each start, so you do not need to call `defineRound` again.
- `onLanguageChange` fires only when the effective value really changes.
- `setLanguage` throws TypeError synchronously on an invalid value.

## 10. The dev console

`npm run dev` starts a local console (bound to 127.0.0.1 only). It mocks the host:

- **App loading**: lists every `.html` in the repo, or "pick file" to choose one anywhere on disk.
- **Data**: browse and edit; stored in your browser; a refresh simulates a "host restart".
- **Three AI reply modes**: `echo` (reflect the request), `fixed` (a fixed text) and `manual` (type each reply); settable per round name, with "fill in format example".
- **Fault injection**: save failure, data conflict, rate limiting, round timeout and app crash reload.
- **Language switch** and **request log**.

In the console your app just writes `<script src="sdk.js">`; if it has no `sdk.js` of its own it gets the current version. See [dev/README.md](../dev/README.md) for the port, `--no-open` and other options. Keep the debug files out of the upload package.

## 11. Packing, uploading and versions

Packing: `npm run pack <app folder>` produces `dist/<folder name>.zip` whose root is the **contents** of the app folder. The script self-checks first (manifest, entry, how the SDK is referenced, references to debug files, limits) and exits non-zero on hard errors.

Uploading: sign in to the platform, open Prompt Hub, then Publish app, and drop the zip into "05 App package". The platform first creates a private app and validates it; once it passes, fill in the name, cover (16:9), synopsis and tags (1 to 5) and click "Publish app".

Versions:

- You can keep uploading new versions of the same app, with at most **7** non-deleted versions kept; when full, the upload is rejected (5439), so delete unused ones in version management first (the default version and the only version cannot be deleted).
- The public one is the **default version** you choose. Novels that already mounted the app are never switched silently; players can choose a version themselves.
- Only the original author can upgrade or publish (5409).

Limits:

| Item | Limit |
|---|---|
| Raw zip size | 50 MB |
| Total size after extraction | 150 MB |
| Files in the package | 1000 |
| `appName` length | 100 characters |
| `canvases` raw size | 64 KB |
| Versions per app | 7 |

## 12. Runtime restrictions

Your app runs in `<iframe sandbox="allow-scripts">` (without `allow-same-origin`), so the browser gives it an opaque origin: **not another domain, but no domain at all**. Every restriction follows from that.

You can:

- Use any file type, including `.wasm`, audio, video and extensionless files.
- `fetch` files inside your own package (including `Range` requests).
- Use WebAssembly: `WebAssembly.instantiate` / `instantiateStreaming`.
- Use Workers, but in blob form: `new Worker(URL.createObjectURL(blob))`.
- Use `canvas.toBlob()` followed by `<img src="blob:...">` / `fetch(blobURL)`; `data:` and `blob:` resources are allowed.
- Nest your own pages with `<iframe src="./sub.html">`; sub-pages are under the same restrictions.
- Use `<script type="module">` for your own scripts (the SDK tag excepted).

You cannot:

- **Reach any external address** (`fetch` / XHR / `<img>` beacons / form posts / self-navigation / external `<iframe>`s). Your app handles the user's novel data and there must be no path to send it out. Scripts, styles and fonts from external CDNs **silently fail**: the page still renders and nothing reports an error. Bundle them in the package.
- **Use `localStorage` / `sessionStorage` / `indexedDB`**: without an origin there is no storage partition, so merely reading the property throws `SecurityError`. Persist only through `data.*` and `save()`.
- **Use same-origin classic Workers** (`new Worker('./w.js')`): they fail with `cannot be accessed from origin 'null'`; use a blob worker.
- **Use `eval()` / `new Function()`**: `unsafe-eval` is not allowed (only a narrow exception exists for WASM compilation).
- **Use WebRTC** (`RTCPeerConnection` and similar): rejected at upload, as there must be no second path to the outside.
- **Put `type="module"` / `defer` / `async` on the `<script src="sdk.js">` tag**: the SDK must be ready synchronously before your scripts, and these three attributes break the order. It does not reject the upload, it downgrades to a warning, but the app most likely breaks.

Two side effects of "no origin": even `fetch` of a file in your own package counts as a cross-origin request to the browser, and `<script type="module">` is loaded in CORS mode (the platform is already configured for both). You do not need to handle these.

**Scrollbars**: once loaded, the SDK hides document-level (`html` / `body`) scrollbars by default; when the page content exceeds the window it still scrolls (touch, wheel and keyboard as usual), just without a scrollbar. Scrollbars inside your own containers are unaffected. If you need a visible scrollbar, scroll inside your own container:

```css
html, body { height: 100%; margin: 0; }
.list { height: 100%; overflow-y: auto; } /* the scrollbar shows normally */
```

## 13. Error codes

### SDK runtime (`error.code` on rejected Promises)

| code | Meaning |
|---|---|
| `SUBMIT_IN_FLIGHT` | A round is already in progress; only one at a time |
| `DATA_CONFLICT` | The save anchor does not match the server; the SDK has overwritten local data with the server's |
| `RATE_LIMITED` | Too many requests |
| `READONLY` | The session is read-only; writes are not sent |
| `TIMEOUT` | The request timed out |
| `INVALID_PARAM` | Invalid argument (unsupported form, out-of-range canvas ratio and so on) |
| `USER_REJECTED` | The user refused in the authorization prompt |
| `INTERNAL` | Any other internal error |

### Upload rejections

The response body is always `{ "code": <error code>, "message": "..." }`.

| Code | HTTP | Cause | How to fix |
|---|---|---|---|
| 5401 | 400 | Unsafe path in the package: an entry name with a backslash or NUL, an absolute path starting with `/` or a Windows drive letter, any segment equal to `..`, or an entry that is a symlink | Repack with a standard zip tool |
| 5402 | 400 | Invalid package structure: not a valid zip; empty package (only system junk files left); corrupt or duplicate entries (case collision); unparsable HTML; the manifest declares no `entry` and the package has no `index.html`; WebRTC used; HTML references `mock-host` / `paranovell-dev` | Use the message to locate it; the most common causes are a missing entry and references to debug files |
| 5403 | 413 | Zip over 50 MB, or over 150 MB after extraction | Compress media, drop unused assets |
| 5404 | 400 | More than 1000 files (directory entries and system junk files are not counted) | Merge small files |
| 5406 | 400 | No `paranovell.json` at the package root; or the manifest is not valid JSON, `appName` exceeds 100 characters, `entry` is not `.html` or points to a missing file, `canvases` exceeds 64 KB or has invalid values | Add `{}` if the file is missing; otherwise fix the fields per sections 3 and 7 |
| 5409 | 403 | You are not the author of this app | Use the original author account, or upload as a new app |
| 5410 | 409 | The same idempotency key was used with different upload parameters, you already have another package being validated, or this upload was cancelled | Retry after the current validation finishes (or cancel it first); use a new idempotency key if you changed the package; start a new upload if it was cancelled |
| 5439 | 409 | The app already has 7 non-deleted versions | Delete an unused old version in version management, then upload |

In addition, a missing `package` file, a `title` / `synopsis` / `cover_url` that is not valid UTF-8, a missing title / cover / synopsis when publishing, or a tag count outside 1 to 5 are rejected with a generic 400; fix the form according to the message.

### Upload warnings (not blocking, but it usually will not run right)

The response's `warnings` field carries `{ kind, path, line }`:

| kind | Trigger | Notes |
|---|---|---|
| `local_storage` | A script mentions `localStorage` / `sessionStorage` / `indexedDB` | It throws `SecurityError` at runtime; use `paranovell.data.*` |
| `web_worker` | `new Worker(...)` / `new SharedWorker(...)` with no `createObjectURL` in the same file | Probably a same-origin worker, which cannot start |
| `external_resource` | A tag such as `<link>` / `<script>` / `<img>` / `<iframe>`, or CSS `@import` / `url()`, points to an external address | It is silently blocked; bundle the asset |
| `dev_artifact` | A file looks like local debug scaffolding | It most likely does not belong in a published package |
| `sdk_reference` | The `<script>` pointing at `sdk.js` has `defer` / `async` / `type="module"` | The SDK may not be ready when referenced |
| `default_name` | Both the manifest `appName` and the form title are empty | A default name was used; add a title |

## 14. Compatibility promise

- The current SDK major version is **v1**; the version is in `versions/v1/sdk-version.json` and changes are in the [CHANGELOG](../CHANGELOG.md).
- The v1 public API is **additive only**: new methods, or **optional** parameters on existing methods; the number and order of existing parameters, return shapes and required fields do not change; the strictness of runtime validation does not change (neither tightened nor loosened); call-order semantics do not change (for example whether `data.*` may be called before `ready()`, or the rejection behavior when rounds overlap).
- Breaking changes always go into a new major version (`versions/v2/`); v1 keeps working.
- The platform maintains the `sdk.js` at your package root: fixes within the same major version reach you automatically without re-uploading.
- Fields with a double-underscore prefix (`__onEvent` and similar) are internal, outside the promise, and must not be called from app code.

## 15. FAQ

**It works in the dev console but shows a blank page or lost styles after upload?**
Check the `warnings` in the upload response first. The most common cause is scripts, styles or fonts from an external CDN being silently blocked (`external_resource`); bundle them into the package.

**Can I use React / Vue / a bundler?**
Yes, as long as the output is purely static files and the SDK's `<script src="sdk.js">` stays a plain script tag (do not let the bundler turn it into a module). Pack the build output folder as the app folder.

**How do I store large objects or images?**
`data` suits structured JSON state. Put images, audio and video in the package and reference them by relative path; do not stuff them into data.

**Why does `data.set(key, null)` throw?**
`null` / `undefined` are not valid values; delete with `remove(key)`.

**My round handler ran once after a refresh; is that a bug?**
No, that is recovery: the previous round had not finished, and once the story text was done the platform replayed your handler and confirmed the save. Just make sure the handler depends only on `data` and `output`; see section 5.

**`ready()` never returns?**
On a new device or after clearing caches, if the previous round's text is still generating, `ready()` waits until it is done before returning with data; you can show a "generating" UI with `onRoundPending` before `ready()`.

**Can I run two rounds at once?**
No, the second rejects with `SUBMIT_IN_FLIGHT`. Serialize them yourself in the app if you need a queue.

**`plan.create` takes forever to return?**
It is waiting for the user to choose in the authorization prompt; it is not stuck, and the SDK sets no timeout on it.

**Why does `localStorage` throw instead of returning empty?**
Your app has no origin, so the browser has no partition to give; merely reading the property throws `SecurityError`. Use `paranovell.data.*`.
