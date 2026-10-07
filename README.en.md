# paranovell-sdk

English | [中文](README.md)

The paranovell sandbox app SDK: build a purely static HTML package that reads and writes data and starts AI rounds inside a paranovell novel. No build step, no dependencies, one `sdk.js` file.

- You write plain HTML / CSS / JS. Any framework works (or none).
- Your app runs in a sandboxed iframe next to the novel reader. The only channel to the outside is the global object `window.paranovell`.
- Upload it on the platform's "Publish app" page to make it public. The platform injects the SDK, persists the data and handles authentication for you.

Full developer guide: [docs/guide.en.md](docs/guide.en.md). Repository: <https://github.com/ljx196/paranovell-sdk>.

## Quick start

Requires Node.js 16+ (only for the local dev console and the packer; your app itself does not depend on Node).

```
git clone https://github.com/ljx196/paranovell-sdk.git
cd paranovell-sdk
npm run dev                      # start the dev console and open the browser; pick examples/hello
npm run pack examples/hello      # build dist/hello.zip
```

To write your own app:

1. Create a folder (it may live outside this repo) with two files (see "Minimal package" below): `paranovell.json` and `index.html`.
2. Put `<script src="sdk.js"></script>` in the HTML. During local debugging the dev console serves the current SDK automatically, so there is no need to copy it.
3. Run `npm run dev` and use "pick file" in the console to load your `index.html`.
4. Run `npm run pack <your app folder>` to get a zip (the zip root is the **contents** of the folder, not the folder itself).
5. Sign in to the platform, open Prompt Hub, then Publish app, drop the zip into "05 App package", fill in name, cover, synopsis and tags after validation passes, and click "Publish app".

## Repository layout

```
paranovell-sdk/
├── versions/v1/
│   ├── sdk.js              runtime, single-file ES2017, included with a plain <script>
│   ├── paranovell.d.ts     global type declarations (window.paranovell) for editor completion
│   └── sdk-version.json    current SDK version
├── dev/                    local dev console (mock host, zero dependencies); see dev/README.md
├── scripts/pack.js         packer: npm run pack <app folder>
├── examples/hello/         minimal example, ready to pack and upload
├── docs/                   developer guide (zh / en)
├── CHANGELOG.md
└── LICENSE
```

## Minimal package

`paranovell.json` (the manifest must be at the package root; every field is optional, the smallest valid content is `{}`):

```json
{ "appName": "My first sandbox app" }
```

`index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>My first sandbox app</title></head>
<body>
  <p id="count">Loading...</p>
  <button id="inc">+1 and save</button>
  <button id="ask">Ask the AI for a name</button>
  <p id="name"></p>

  <!-- Keep this exact file name and relative path; no type="module" / defer / async -->
  <script src="sdk.js"></script>
  <script>
    // 1. Declare rounds BEFORE ready(): the reply shape you expect and how to write it into data
    var askName = paranovell.defineRound('ask-name', {
      format: { name: '', reason: '' },
      notes: 'Give the hero a two-syllable name and one sentence explaining why.',
      handler: function (output) {
        paranovell.data.set('heroName', nameOf(output)); // round writes are archived with the confirmation
      }
    });

    // 2. Read and write only after the data is ready
    paranovell.ready().then(function () {
      var count = paranovell.data.get('count') || 0;
      render(count);

      document.getElementById('inc').onclick = function () {
        count += 1;
        paranovell.data.set('count', count);
        paranovell.save(); // coalesced within a 3 second window
        render(count);
      };
      document.getElementById('ask').onclick = function () {
        askName({ input: 'The hero is a young swordsman' }).then(function (res) {
          document.getElementById('name').textContent = nameOf(res.output) + ' - ' + ((res.output && res.output.reason) || '');
        });
      };
    });

    // The dev console's echo mode returns the input as the reply (a string), so stay tolerant
    function nameOf(output) { return (output && output.name) || 'Nameless'; }

    function render(n) {
      document.getElementById('count').textContent =
        'Saved count: ' + n + ' (' + (paranovell.data.get('heroName') || 'no name yet') + ')';
    }
  </script>
</body>
</html>
```

Two rules: do all reads and writes after `ready()`; register `defineRound()` / `defineHook()` before `ready()` so that, after a refresh or a device switch, the platform can pick up an unfinished round automatically.

### About `sdk.js`

- Include it with a plain `<script src="sdk.js"></script>`; the path is `sdk.js` at the package root.
- **Do not** add `type="module"`, `defer` or `async` to that tag: the SDK must be ready synchronously before your scripts run, otherwise `paranovell` is referenced before it exists (the upload warns and the app most likely breaks).
- You may upload with or without `sdk.js` in the package. After upload the platform points the root `sdk.js` at its current SDK build, so you automatically get fixes within the same major version without re-uploading. `npm run pack` adds a copy from `versions/v1/` when the package has none.

## Manifest `paranovell.json`

| Field | Type | Required | Description |
|---|---|---|---|
| `appName` | string | no | Display name, at most 100 characters. Falls back to the upload form title when omitted |
| `entry` | string | no | Relative path of the entry file, default `index.html`; may point to any `.html` in the package but it must exist |
| `canvases` | object | no | Canvas ratio declarations, keys `portrait` / `landscape` / `compact`; `safe` is a `"w:h"` ratio string (0.05 to 20), `bleed` is optional with `w` / `h` each between 1 and 3 |

```json
{
  "appName": "My app",
  "entry": "game.html",
  "canvases": {
    "portrait": { "safe": "9:16" },
    "landscape": { "safe": "16:9", "bleed": { "w": 1.2, "h": 1.2 } }
  }
}
```

## API overview

The full signatures and comments live in [`versions/v1/paranovell.d.ts`](versions/v1/paranovell.d.ts). Every API hangs off the global `paranovell` (that is, `window.paranovell`).

### Lifecycle

| Method | Description |
|---|---|
| `ready(): Promise<void>` | Pulls the data; read and write only after it resolves. Repeated calls return the same Promise. If the previous round is unfinished it does not block: the platform recovers it in the background and automatically replays your registered `defineRound` handler of the same name |
| `env.platform` | `'web'` (iframe) or `'native'` (in-app WebView), read-only |
| `env.appId` | Current app id, read-only |

### Data

| Method | Description |
|---|---|
| `data.get(key)` | Reads the current value (deep copy); returns `undefined` when missing |
| `data.getAll()` | Reads all data (deep copy) |
| `data.set(key, value)` | Writes a JSON-serializable value; `value` must not be `null` / `undefined` (throws TypeError), use `remove()` to delete |
| `data.remove(key)` | Deletes a key |
| `data.append(key, item)` | Appends one item to an array; a missing key counts as an empty array; throws TypeError if the key holds a non-array |
| `data.pending()` | Lists operations not yet sent upstream (for debugging) |
| `save(): Promise<void>` | Plain save: snapshots uncommitted writes now and sends them coalesced within a 3 second window. On a concurrent conflict the server wins: the SDK overwrites memory with the authoritative data, clears the buffer, then rejects (`code: 'DATA_CONFLICT'`) |

### AI rounds

| Method | Description |
|---|---|
| `defineRound(name, { format, notes?, example?, handler })` | Declares a kind of round and returns a sender `sender({ input }) => Promise<{ output }>`. `format` is the JSON shape you expect from the model (plain object / array; a `?` key suffix marks an optional field, a `null` value means any type); `notes` / `example` are instructions and a sample for the model; `handler(output)` is the single place a round writes data and may return a Promise. The SDK waits for the handler, confirms the save automatically, then resolves. Redefining the same name overrides it |
| `defineHook(name, { trigger, input?, format, notes?, example?, handler })` | Before the story text is generated, the model decides from `trigger` (a natural-language condition) whether to query your app; `input()` is evaluated on every query. At most one per app, must be registered before `ready()`, and must not share a name with a `defineRound` |
| `onRoundPending(cb)` | Optional. After a refresh or device switch, if the previous round is still generating you first get `{ pending: true, round }`, then `{ pending: false }` when it ends. Subscribe before `ready()`. Returns an unsubscribe function |
| `onRoundRecovery(cb)` | Optional override hook. Once subscribed, recovery no longer replays the handler automatically; it hands `{ name, output, commit(), discard() }` to you. Not subscribing does not mean giving up the round |

Handler constraint: its writes must depend only on `data` and this round's `output`. Do not rely on intermediate state that lives only in a JS closure, because the platform replays the handler after a refresh.

### UI

| Method | Description |
|---|---|
| `ui.present(form)` | Requests a presentation form: `'split' \| 'float' \| 'full' \| 'mfull' \| 'mland' \| 'mdrawer'`. The host may degrade it; trust the returned `{ applied, degraded, reason? }` |
| `ui.setCanvas(set)` | Declares one or more canvases (ratio only, no pixels); same shape as `canvases` in the manifest |
| `ui.getPresentation()` | Synchronously reads the local snapshot `{ form, canvas, scale }`, sends no request |
| `ui.onPresentationChange(cb)` | Subscribes to form / canvas / scale changes (including host-initiated ones). Returns an unsubscribe function |

### Language

| Method | Description |
|---|---|
| `getLanguage()` | `'zh'` or `'en'`, follows the host by default; safe to call before `ready()` |
| `setLanguage(lang)` | Overrides and locks the language; host pushes are ignored afterwards |
| `onLanguageChange(cb)` | Fires only when the effective value really changes. Returns an unsubscribe function |

### Plans

| Method | Description |
|---|---|
| `plan.list()` | Lists all plans of the novel, newest first |
| `plan.create({ title, content })` | Creates a new plan. The host shows an authorization prompt first; if the user refuses, it rejects (`code: 'USER_REJECTED'`) |
| `plan.restart(planId)` | Restarts a discarded plan, again through the authorization prompt |

### Error codes

Every rejected Promise carries a `code` field:

| code | Meaning |
|---|---|
| `SUBMIT_IN_FLIGHT` | A round is already in progress; only one at a time |
| `DATA_CONFLICT` | The save anchor does not match the server; the SDK has overwritten local data with the server's |
| `RATE_LIMITED` | Too many requests |
| `READONLY` | The session is read-only (for example viewing someone else's save); writes are not sent |
| `TIMEOUT` | The request timed out |
| `INVALID_PARAM` | Invalid argument (for example an unsupported form or an out-of-range canvas ratio) |
| `USER_REJECTED` | The user refused in the authorization prompt |
| `INTERNAL` | Any other internal error |

Fields starting with `__` (such as `__onEvent`) are internal and outside the compatibility promise; do not call them from app code.

## Local debugging

```
npm run dev                    # default port 4173, opens the browser
node dev/serve.js --port 5000  # pick a port (auto +1 if taken)
node dev/serve.js --no-open    # do not open the browser
```

The console starts a static server on your machine (bound to 127.0.0.1 only) and opens `dev/dev.html`. Pick an app in the console (every `.html` in the repo is listed), or choose an HTML file from disk (the app folder may live outside the repo).

What the console can do:

- **Data**: browse and edit the current data, stored in your browser; a refresh simulates a "host restart".
- **AI replies**: `echo` (reflect the request), `fixed` (a fixed text) and `manual` (type each reply), to exercise your `defineRound` handlers.
- **Fault injection**: save failure, data conflict, rate limiting, round timeout and app crash reload, so you can verify your error handling one by one.
- **Language switch**: try both languages.
- **Request log**: see what the app sent and what the host replied.

Note: files in `dev/` are for debugging only and must **not** go into an upload package; a package whose HTML references `mock-host.js` or `paranovell-dev` is rejected.

## Packing and uploading

1. Make sure the package root has `paranovell.json` and the entry is `index.html` (or the `entry` declared in the manifest).
2. Run `npm run pack <app folder>`: it self-checks, then writes `dist/<folder name>.zip`. Any standard zip tool also works: zip the **contents** of the app folder, with no symlinks or absolute paths.
3. On the platform, open Prompt Hub, then Publish app, and drop the zip into "05 App package". The upload first creates a private app and runs validation; once it passes, fill in the name, cover (16:9), synopsis and tags (1 to 5), and click "Publish app" to make it public in the plaza.
4. Versions: you can keep uploading new versions of the same app, up to 7 are kept; the public one is the **default version** you choose. Novels that already mounted the app are never switched silently; players can choose a version themselves.

Limits:

| Item | Limit |
|---|---|
| Raw zip size | 50 MB |
| Total size after extraction | 150 MB |
| Files in the package | 1000 |
| `appName` length | 100 characters |
| `canvases` raw size | 64 KB |
| Versions per app | 7 |

## Runtime restrictions

Your app runs in `<iframe sandbox="allow-scripts">` and has no origin (an opaque origin). Every rule below follows from that.

You can:

- Bundle any file type (`.wasm`, audio, video, files without an extension).
- `fetch` files inside your own package (including `Range` requests).
- Use WebAssembly: `WebAssembly.instantiate` / `instantiateStreaming`.
- Use Workers, but in blob form: `new Worker(URL.createObjectURL(blob))`.
- Use `canvas.toBlob()` followed by `<img src="blob:...">` / `fetch(blobURL)`; `data:` and `blob:` resources are allowed.
- Nest your own pages with `<iframe src="./sub.html">` (multi-page apps).
- Use `<script type="module">` for your own scripts (the SDK tag excepted).

You cannot:

- **Reach any external address**: `fetch` / XHR / `<img>` beacons / form posts / external `<iframe>`s are all blocked. Scripts, styles and fonts from external CDNs **silently fail**; bundle the assets in the package.
- **Use `localStorage` / `sessionStorage` / `indexedDB`**: merely reading the property throws `SecurityError`. Persist only through `paranovell.data.*` and `save()`.
- **Use same-origin classic Workers** (`new Worker('./w.js')`): they cannot start; use a blob worker.
- **Use `eval()` / `new Function()`**: the CSP does not allow `unsafe-eval` (WASM compilation is the exception).
- **Use WebRTC**: rejected at upload.
- **Put `type="module"` / `defer` / `async` on the SDK tag**: it warns and most likely breaks.

Default behavior note: once loaded, the SDK hides document-level (`html` / `body`) scrollbars while the page still scrolls. If you need a visible scrollbar, scroll inside your own container (fixed height plus `overflow: auto`) or override it in your own styles.

## Upload rejections

The response body is always `{ "code": <error code>, "message": "..." }`.

| Code | Cause | How to fix |
|---|---|---|
| 5401 | Unsafe path in the package: contains `..`, an absolute path, a backslash or a symlink | Repack with a standard zip tool |
| 5402 | Invalid package structure: not a valid zip / empty package / corrupt or duplicate entries (case collision) / unparsable HTML / manifest declares no `entry` and the package has no `index.html` / WebRTC used / HTML references `mock-host` / `paranovell-dev` | Use the message to locate it; the most common causes are a missing entry and references to debug files |
| 5403 | Zip over 50 MB, or over 150 MB after extraction | Compress media, drop unused assets |
| 5404 | More than 1000 files | Merge small files |
| 5406 | No `paranovell.json` at the package root; or the manifest is not valid JSON, `appName` exceeds 100 characters, `entry` is not `.html` or points to a missing file, `canvases` exceeds 64 KB or has invalid values | Add `{}` if the file is missing; otherwise fix the fields as listed above |
| 5409 | You are not the author of this app | Use the original author account, or upload as a new app |
| 5410 | The same idempotency key was used with different upload parameters, or you already have an upload being validated | Retry later |
| 5439 | The app already has 7 versions | Delete an old version in version management, then upload |

Uploads that succeed with **warnings** are not blocked, but they usually mean the app will not behave as expected at runtime:

| Warning | Trigger | Notes |
|---|---|---|
| `local_storage` | A script mentions `localStorage` / `sessionStorage` / `indexedDB` | It throws `SecurityError` at runtime; use `paranovell.data.*` |
| `web_worker` | `new Worker(...)` with no `createObjectURL` in the same file | Probably a same-origin worker, which cannot start |
| `external_resource` | A tag or CSS points to an external address | It is silently blocked; bundle the asset |
| `dev_artifact` | A file looks like debug scaffolding | It most likely does not belong in a published package |
| `sdk_reference` | The SDK tag has `defer` / `async` / `type="module"` | The SDK may not be ready when referenced |
| `default_name` | Both the manifest `appName` and the form title are empty | A default name was used; add a title |

## Versioning and compatibility

- The current SDK major version is **v1**; the exact version is in `versions/v1/sdk-version.json` and changes are listed in [CHANGELOG.md](CHANGELOG.md).
- The v1 public API is **additive only**: new methods, or optional parameters on existing methods; existing parameters, return values, required fields, runtime validation strictness and call-order semantics do not change.
- Breaking changes go into a new major version (v2); v1 keeps working.
- After upload the platform maintains the root `sdk.js`, so you automatically get fixes within the same major version without re-uploading.
- Internal fields with a double-underscore prefix (`__onEvent` and similar) are outside the promise.

## License and trademark

The code is released under the [MIT License](LICENSE).

The name "paranovell" and its logos are not covered by that license: you may mention the name truthfully to describe compatibility, but you may not use it to imply endorsement, sponsorship or affiliation, nor as the name or logo of your own product.
