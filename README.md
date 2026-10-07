# paranovell-sdk

[English](README.en.md) | 中文

paranovell 沙盒应用 SDK:用一个纯静态的 HTML 包,在 paranovell 的小说里读写数据、发起 AI 回合。零构建、零依赖、一个 `sdk.js` 文件。

- 你写的是普通 HTML / CSS / JS,任何框架都行(也可以不用)。
- 应用跑在小说阅读页旁边的沙盒 iframe 里,唯一的对外通道是全局对象 `window.paranovell`。
- 上传到平台的「发布应用」页即可公开;平台替你注入 SDK、持久化数据、处理鉴权。

完整开发手册:[docs/guide.zh-CN.md](docs/guide.zh-CN.md)。仓库地址:<https://github.com/ljx196/paranovell-sdk>。

## 快速开始

需要 Node.js 16+(只用于本地调试台与打包脚本,应用本身不依赖 Node)。

```
git clone https://github.com/ljx196/paranovell-sdk.git
cd paranovell-sdk
npm run dev                      # 起调试台并打开浏览器,在列表里选 examples/hello
npm run pack examples/hello      # 打成 dist/hello.zip
```

写自己的应用:

1. 新建一个目录(可以放在仓库外),放两个文件(见下方「最小可运行包」):`paranovell.json` 和 `index.html`。
2. HTML 里写 `<script src="sdk.js"></script>`。本地调试时调试台会自动提供当前版本的 SDK,不必复制。
3. `npm run dev`,在调试台里「选择文件」装载你的 `index.html`。
4. `npm run pack <你的应用目录>`,得到 zip(包根就是应用目录的**内容**,不是外层文件夹)。
5. 登录平台 → Prompt Hub → 发布应用,在「05 应用包」拖入 zip,通过校验后填好名称、封面、简介、标签,点「发布应用」。

## 仓库目录

```
paranovell-sdk/
├── versions/v1/
│   ├── sdk.js              运行时,单文件 ES2017,<script> 直接引入
│   ├── paranovell.d.ts     全局类型声明(window.paranovell),放进项目即有编辑器补全
│   └── sdk-version.json    当前 SDK 版本号
├── dev/                    本地调试台(模拟宿主,零依赖),说明见 dev/README.md
├── scripts/pack.js         打包脚本:npm run pack <应用目录>
├── examples/hello/         最小示例,可直接打包上传
├── docs/                   开发手册(中 / 英)
├── CHANGELOG.md
└── LICENSE
```

## 最小可运行包

`paranovell.json`(清单文件必须在包根;字段全部可选,最小合法内容就是 `{}`):

```json
{ "appName": "我的第一个沙盒应用" }
```

`index.html`:

```html
<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8" /><title>我的第一个沙盒应用</title></head>
<body>
  <p id="count">加载中…</p>
  <button id="inc">+1 并存档</button>
  <button id="ask">让 AI 起个名字</button>
  <p id="name"></p>

  <!-- 必须是这个文件名、这个相对路径;不要加 type="module" / defer / async -->
  <script src="sdk.js"></script>
  <script>
    // 1. 在 ready() 之前声明回合:期望模型回什么形状,收到后怎么写数据
    var askName = paranovell.defineRound('ask-name', {
      format: { name: '', reason: '' },
      notes: '给主角起一个两字中文名,并用一句话说明理由',
      handler: function (output) {
        paranovell.data.set('heroName', nameOf(output)); // 回合写入会随确认一起存档
      }
    });

    // 2. 等数据就绪再读写
    paranovell.ready().then(function () {
      var count = paranovell.data.get('count') || 0;
      render(count);

      document.getElementById('inc').onclick = function () {
        count += 1;
        paranovell.data.set('count', count);
        paranovell.save(); // 3 秒窗口内合并上行
        render(count);
      };
      document.getElementById('ask').onclick = function () {
        askName({ input: '主角是一名少年剑客' }).then(function (res) {
          document.getElementById('name').textContent = nameOf(res.output) + ' — ' + ((res.output && res.output.reason) || '');
        });
      };
    });

    // 调试台的 echo 模式把 input 原样当作回复(output 是字符串),这里做兼容
    function nameOf(output) { return (output && output.name) || '无名'; }

    function render(n) {
      document.getElementById('count').textContent =
        '已保存的计数:' + n + '(' + (paranovell.data.get('heroName') || '还没起名') + ')';
    }
  </script>
</body>
</html>
```

两条规则:所有读写都在 `ready()` 之后;`defineRound()` / `defineHook()` 在 `ready()` 之前注册,这样刷新或换设备回来时,平台才能自动把上一轮未完成的回合接回来。

### 关于 `sdk.js`

- HTML 里用普通 `<script src="sdk.js"></script>` 引入,路径就是包根的 `sdk.js`。
- **不要**给这个标签加 `type="module"` / `defer` / `async`:SDK 需要在你的脚本之前同步就绪,否则 `paranovell` 还没挂上就被引用了(上传会告警,运行大概率坏)。
- 包里带不带 `sdk.js` 都可以上传。上传后平台会把包根的 `sdk.js` 替换为当前平台版本的引用,之后你会自动获得同一大版本内的修复,不需要重新上传。`npm run pack` 在包里没有 `sdk.js` 时会从 `versions/v1/` 补一份。

## 清单 `paranovell.json`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `appName` | string | 否 | 显示名,最长 100 字。不写时用上传表单的标题兜底 |
| `entry` | string | 否 | 入口文件相对路径,默认 `index.html`;可以指向包内任意 `.html`,但必须真实存在 |
| `canvases` | object | 否 | 画布比例声明,键为 `portrait` / `landscape` / `compact`;`safe` 是 `"w:h"` 比例字符串(0.05–20),`bleed` 可选,`w` / `h` 均在 1–3 之间 |

```json
{
  "appName": "我的应用",
  "entry": "game.html",
  "canvases": {
    "portrait": { "safe": "9:16" },
    "landscape": { "safe": "16:9", "bleed": { "w": 1.2, "h": 1.2 } }
  }
}
```

## API 概要

完整签名与注释以 [`versions/v1/paranovell.d.ts`](versions/v1/paranovell.d.ts) 为准。所有 API 都挂在全局 `paranovell`(即 `window.paranovell`)上。

### 生命周期

| 方法 | 说明 |
|---|---|
| `ready(): Promise<void>` | 拉取数据,就绪后再读写。重复调用返回同一个 Promise。若上一轮回合未完成,不阻塞:平台在后台接回,并自动重放你注册的同名 `defineRound` handler |
| `env.platform` | `'web'`(iframe)或 `'native'`(App 内 WebView),只读 |
| `env.appId` | 当前应用 id,只读 |

### 数据

| 方法 | 说明 |
|---|---|
| `data.get(key)` | 读当前值(深拷贝);不存在返回 `undefined` |
| `data.getAll()` | 读全部数据(深拷贝) |
| `data.set(key, value)` | 写入可 JSON 序列化的值;`value` 不能是 `null` / `undefined`(会抛 TypeError),删除请用 `remove()` |
| `data.remove(key)` | 删除一个 key |
| `data.append(key, item)` | 向数组尾插一条;key 不存在视为空数组;key 已存在且不是数组会抛 TypeError |
| `data.pending()` | 列出尚未上行的操作日志(调试用) |
| `save(): Promise<void>` | 纯存档:立即快照未提交写入,3 秒窗口合并上行。并发冲突时服务端胜,SDK 自动用权威数据覆盖内存并清空缓冲,然后 reject(`code: 'DATA_CONFLICT'`) |

### AI 回合

| 方法 | 说明 |
|---|---|
| `defineRound(name, { format, notes?, example?, handler })` | 声明一类回合,返回发起函数 `sender({ input }) => Promise<{ output }>`。`format` 是期望模型回复的 JSON 形状(普通对象 / 数组;key 加 `?` 后缀表示可选字段,值为 `null` 表示类型不限);`notes` / `example` 是给模型的说明与示例;`handler(output)` 是唯一的回合写入点,可返回 Promise。SDK 等 handler 结算后自动确认存档,再 resolve。同名重定义即覆盖 |
| `defineHook(name, { trigger, input?, format, notes?, example?, handler })` | 正文生成前,由模型按 `trigger`(自然语言触发条件)判断是否查询你的应用;`input()` 每次查询现算。每应用最多一个,须在 `ready()` 前注册,不得与 `defineRound` 重名 |
| `onRoundPending(cb)` | 可选。刷新 / 换设备后若上一轮正文还在生成,先收到 `{ pending: true, round }`,结束时收到 `{ pending: false }`。建议在 `ready()` 前订阅。返回取消订阅函数 |
| `onRoundRecovery(cb)` | 可选的覆盖钩子。订阅后,恢复时不再自动重放 handler,而是把 `{ name, output, commit(), discard() }` 交给你决定。不订阅不等于放弃 |

handler 的约束:它的写入必须只依赖 `data` 与本轮 `output`,不要依赖只活在 JS 闭包里的中间状态——刷新后平台会重放它。

### 界面

| 方法 | 说明 |
|---|---|
| `ui.present(form)` | 请求切换形态:`'split' \| 'float' \| 'full' \| 'mfull' \| 'mland' \| 'mdrawer'`。宿主可能降级,以返回的 `{ applied, degraded, reason? }` 为准 |
| `ui.setCanvas(set)` | 声明一套或多套画布(只约束比例,不约束像素),与清单的 `canvases` 同结构 |
| `ui.getPresentation()` | 同步读本地快照 `{ form, canvas, scale }`,不发请求 |
| `ui.onPresentationChange(cb)` | 订阅形态 / 画布 / 缩放变化(含宿主侧发起的)。返回取消订阅函数 |

### 语言

| 方法 | 说明 |
|---|---|
| `getLanguage()` | `'zh'` 或 `'en'`,默认跟随宿主;`ready()` 前调用也安全 |
| `setLanguage(lang)` | 显式覆盖并锁定,此后忽略宿主推送 |
| `onLanguageChange(cb)` | 只在生效值确有变化时触发。返回取消订阅函数 |

### 方案(plan)

| 方法 | 说明 |
|---|---|
| `plan.list()` | 列出小说全部方案,按创建时间降序 |
| `plan.create({ title, content })` | 下发一个新方案。会先由宿主弹授权框,用户拒绝时 reject(`code: 'USER_REJECTED'`) |
| `plan.restart(planId)` | 重启一条已废弃方案,同样先经授权框 |

### 错误码

所有 Promise 拒绝的错误对象都带 `code` 字段:

| code | 含义 |
|---|---|
| `SUBMIT_IN_FLIGHT` | 已有一轮回合在进行,同时只能有一轮 |
| `DATA_CONFLICT` | 存档锚点与服务端不一致,SDK 已用服务端数据覆盖本地 |
| `RATE_LIMITED` | 请求过于频繁 |
| `READONLY` | 当前会话只读(例如查看他人存档),写入不会上行 |
| `TIMEOUT` | 请求超时 |
| `INVALID_PARAM` | 入参非法(如不支持的 form、画布比例越界) |
| `USER_REJECTED` | 用户在授权框里拒绝 |
| `INTERNAL` | 其它内部错误 |

以 `__` 开头的字段(如 `__onEvent`)是内部接口,不在兼容承诺内,应用代码不要调用。

## 本地调试

```
npm run dev                    # 默认端口 4173,自动打开浏览器
node dev/serve.js --port 5000  # 指定端口(被占用时自动 +1)
node dev/serve.js --no-open    # 不自动打开浏览器
```

调试台会在本机起一个静态服务器(只绑 127.0.0.1)并打开 `dev/dev.html`。在调试台里选择应用(仓库内的 `.html` 会列出来),也可以从磁盘挑一个 HTML 文件(应用目录在仓库外也可以)。

调试台能做的事:

- **数据**:浏览 / 编辑当前数据,存在本机浏览器里,刷新即模拟「宿主重启」。
- **AI 回复**:`echo`(原样回显)、`fixed`(固定文本)、`manual`(每次手动填回复),用来验证 `defineRound` 的 handler。
- **故障注入**:存档失败、数据冲突、限流、回合超时、应用崩溃重载,逐个验证你的错误处理。
- **语言切换**:试双语文案。
- **请求日志**:看应用发了什么、宿主回了什么。

注意:`dev/` 目录下的文件只用于调试,**不要**打进上传包;HTML 里引用了 `mock-host.js` 或 `paranovell-dev` 的包会被拒收。

## 打包与上传

1. 确认包根有 `paranovell.json`,入口是 `index.html`(或清单里声明的 `entry`)。
2. `npm run pack <应用目录>`:自检后写出 `dist/<目录名>.zip`。也可以用任何标准 zip 工具,压缩应用目录的**内容**,不要保留符号链接或绝对路径。
3. 在平台「Prompt Hub → 发布应用」的「05 应用包」拖入 zip。上传后会先建一个私有应用并跑校验;通过后再填名称、封面(16:9)、简介、标签(1–5 个),点「发布应用」公开到广场。
4. 版本:同一个应用可以持续上传新版本,最多保留 7 个;公开发布的是你指定的**默认版本**。已挂载的小说不会被动切换版本,玩家可自行选择。

限额:

| 项 | 限额 |
|---|---|
| zip 原始体积 | 50 MB |
| 解压后总体积 | 150 MB |
| 包内文件数 | 1000 |
| `appName` 长度 | 100 字 |
| `canvases` 原文体积 | 64 KB |
| 每个应用的版本数 | 7 |

## 运行限制

你的应用跑在 `<iframe sandbox="allow-scripts">` 里,没有域名(opaque origin)。下面每一条都从这一点推出来。

能做:

- 打包任意文件类型(`.wasm`、音视频、无扩展名文件)。
- `fetch` 自己包里的文件(含 `Range` 分片)。
- WebAssembly:`WebAssembly.instantiate` / `instantiateStreaming`。
- Worker,但要用 blob 形式:`new Worker(URL.createObjectURL(blob))`。
- `canvas.toBlob()` 之后 `<img src="blob:...">` / `fetch(blobURL)`;`data:` / `blob:` 资源都放开。
- `<iframe src="./sub.html">` 套自己包里的页面(多页应用)。
- 你自己的脚本可以用 `<script type="module">`(SDK 那个标签除外)。

不能做:

- **连任何外部地址**:`fetch` / XHR / `<img>` 信标 / 表单提交 / 外链 `<iframe>` 全部拦截。外部 CDN 的脚本、样式、字体会**静默失效**——把资源打进包里。
- **`localStorage` / `sessionStorage` / `indexedDB`**:取属性就抛 `SecurityError`。持久化只走 `paranovell.data.*` + `save()`。
- **同源 classic Worker**(`new Worker('./w.js')`):起不来,改 blob worker。
- **`eval()` / `new Function()`**:CSP 没放开 `unsafe-eval`(WASM 编译例外)。
- **WebRTC**:上传期直接拒收。
- **SDK 标签加 `type="module"` / `defer` / `async`**:会告警,功能大概率坏。

默认行为提示:SDK 加载后会隐藏文档级(`html` / `body`)滚动条,整页仍可滚动;需要可见滚动条时,让内容在自己的容器里滚动(固定高度 + `overflow: auto`),或在自己的样式里覆盖。

## 上传被拒

响应体统一为 `{ "code": <错误码>, "message": "..." }`。

| 错误码 | 原因 | 怎么修 |
|---|---|---|
| 5401 | 包内路径不安全:含 `..`、绝对路径、反斜杠、符号链接 | 用标准 zip 工具重新打包 |
| 5402 | 包结构不合规:不是有效 zip / 包为空 / 条目损坏或重复(大小写冲突)/ HTML 无法解析 / 清单没声明 `entry` 且包内没有 `index.html` / 用了 WebRTC / HTML 引用了 `mock-host` / `paranovell-dev` | 按提示信息定位;最常见的是入口缺失与引用了调试文件 |
| 5403 | zip 超 50 MB,或解压后超 150 MB | 压缩媒体、去掉无用资源 |
| 5404 | 文件数超过 1000 | 合并零散小文件 |
| 5406 | 包根没有 `paranovell.json`;或清单不是合法 JSON、`appName` 超 100 字、`entry` 不是 `.html` 或指向的文件不存在、`canvases` 超 64 KB 或取值非法 | 缺文件就补一份 `{}`;写错了按上表修正字段 |
| 5409 | 不是这个应用的作者 | 用原作者账号,或作为新应用上传 |
| 5410 | 同一个幂等键对应了不同的上传参数,或你已有一个上传正在校验中 | 稍后重试 |
| 5439 | 该应用已有 7 个版本 | 在版本管理里删掉旧版本再传 |

上传成功但带**告警**的情况不会拦你,但多半意味着运行时不按预期工作:

| 告警 | 触发 | 说明 |
|---|---|---|
| `local_storage` | 脚本里出现 `localStorage` / `sessionStorage` / `indexedDB` | 运行时会抛 `SecurityError`,改用 `paranovell.data.*` |
| `web_worker` | `new Worker(...)` 且同文件没有 `createObjectURL` | 大概率是同源 worker,起不来 |
| `external_resource` | 标签或 CSS 指向外部地址 | 会被静默拦截,把资源打进包 |
| `dev_artifact` | 文件被识别为调试脚手架 | 多半不该出现在发布包里 |
| `sdk_reference` | SDK 标签带了 `defer` / `async` / `type="module"` | SDK 可能未就绪就被引用 |
| `default_name` | 清单 `appName` 与表单标题都为空 | 已用默认名兜底,建议补标题 |

## 版本与兼容承诺

- 当前 SDK 大版本 **v1**,具体版本号见 `versions/v1/sdk-version.json`,变更记录见 [CHANGELOG.md](CHANGELOG.md)。
- v1 的公开 API **只增不改**:只新增方法,或给既有方法加可选参数;不改既有方法的入参、返回值、必填项、运行时校验强度与调用时序语义。
- 需要破坏性变更时走新的大版本(v2),v1 继续可用。
- 上传后包根的 `sdk.js` 由平台维护,你会自动获得同一大版本内的修复,无需重新上传。
- 双下划线前缀(`__onEvent` 等)的内部字段不在承诺范围内。

## 许可证与商标

代码以 [MIT 许可证](LICENSE) 发布。

paranovell 的名称与标识(logo)不在该授权范围内:你可以在说明兼容性时如实提及名称,但不得以此暗示官方认可、赞助或隶属关系,也不得将其用作自己的产品名或标识。

