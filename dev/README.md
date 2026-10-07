# 调试台 / Dev console

本地模拟宿主,零依赖。在仓库根目录运行:

```
npm run dev                    # 等价于 node dev/serve.js,端口 4173,自动打开浏览器
node dev/serve.js --port 5000  # 指定端口(被占用时自动 +1)
node dev/serve.js --no-open    # 只起服务,不打开浏览器
```

A local mock host, zero dependencies. From the repo root run `npm run dev` (same as `node dev/serve.js`; port 4173, opens the browser). Use `--port` to pick a port (auto +1 if taken) and `--no-open` to skip opening the browser.

服务器只绑 127.0.0.1,静态根目录是仓库根(URL 前缀 `/sandbox-sdk/`)。调试台地址:`http://localhost:4173/sandbox-sdk/dev/dev.html`。
The server binds to 127.0.0.1 only; the static root is the repo root, mounted under `/sandbox-sdk/`.

## 能做什么 / What it does

- 装载应用:从列表选(仓库里除 `dev/`、`versions/` 外的所有 `.html`,如 `examples/hello`),或用「选择文件」从磁盘任意位置挑一个 HTML。/ Load an app from the list or pick any HTML file on disk.
- 数据:浏览 / 编辑当前数据,存在本机浏览器里。/ Browse and edit data, stored in your browser.
- AI 回复三模式:`echo`(把 input 原样当作回复,所以 handler 收到的是字符串)、`fixed`(固定 JSON)、`manual`(每次手动填)。需要对象回复时用 fixed / manual。/ Three AI reply modes: echo (the input string is returned as-is, so the handler receives a string), fixed (a fixed JSON) and manual (type each reply). Use fixed or manual when you need an object reply.
- 故障注入:存档失败、数据冲突、限流、回合超时、应用崩溃重载。/ Fault injection: save failure, conflict, rate limit, round timeout, crash reload.
- 语言切换、请求日志。/ Language switch and request log.
- 应用里写 `<script src="sdk.js">` 即可:包内没有 `sdk.js` 时调试台自动提供当前版本。/ `<script src="sdk.js">` works even if the app folder has no `sdk.js`; the console serves the current version.

可选:URL 带 `?fixture=` 时会尝试加载 `dev/detective-fixture.js` 预置数据;本仓库不带该文件,忽略即可。
Optional: `?fixture=` tries to load `dev/detective-fixture.js`; it is not shipped here and is simply ignored.

## 文件 / Files

| 文件 | 说明 |
|---|---|
| `serve.js` | 静态服务器 + 应用列表接口 + 文件选择 / static server, app list API, file picker |
| `dev.html` | 调试台界面 / console UI |
| `mock-host.js` | 模拟宿主引擎 / mock host engine |
| `paranovell-dev.d.ts` | 模拟宿主对外接口的类型 / types of the mock host interface |

注意:调试文件**不要**打进上传包,引用了 `mock-host` / `paranovell-dev` 的包会被平台拒收。
Do not put these files in an upload package; packages referencing `mock-host` / `paranovell-dev` are rejected.
