# 沙盒应用开发手册

[English](guide.en.md) | 中文

本手册面向**要把一个 HTML 应用传到 paranovell 沙盒里跑起来的开发者**。API 的精确签名以 [`versions/v1/paranovell.d.ts`](../versions/v1/paranovell.d.ts) 为准;仓库概览与速查表见 [README](../README.md)。

目录:

1. 概念
2. 快速开始
3. 应用包与 `paranovell.json`
4. 数据与存档
5. AI 回合生命周期
6. Hook
7. 展示与画布
8. Plan(方案)
9. 多语言
10. 调试台
11. 打包、上传与版本
12. 运行限制
13. 错误码
14. 兼容承诺
15. FAQ

## 1. 概念

- **沙盒应用**:一个纯静态 HTML 包(HTML / CSS / JS / 任意资源文件),零构建。它被放进小说阅读页旁边的 `<iframe sandbox="allow-scripts">` 里运行(App 内是 WebView)。
- **`window.paranovell`**:应用与平台之间唯一的通道。读写数据、发起 AI 回合、切换展示形态、读语言、管理方案,都通过它。
- **数据(data)**:一份属于「这本小说 + 这个应用」的 JSON 键值存档,由平台持久化。读是同步的(读内存),写先进本地缓冲,再由 SDK 合并上行。
- **回合(round)**:应用把一段输入交给 AI,AI 按你声明的 JSON 形状回复,你的 handler 把回复写进数据,SDK 随后自动确认存档。回合期间平台保证「要么整轮生效,要么整轮回滚」。
- **Hook**:正文生成之前,由模型判断是否需要查询你的应用,得到的结果作为正文生成的参考。
- **沙盒没有域名**:应用没有源(opaque origin),这是后面所有运行限制的根源,见第 12 节。

## 2. 快速开始

最小包只需两个文件。`paranovell.json`(字段全部可选,最小就是 `{}`):

```json
{}
```

`index.html`:

```html
<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8" /><title>我的第一个沙盒应用</title></head>
<body>
  <div id="app">加载中…</div>

  <!-- 必须是这个文件名、这个相对路径、不能加 type="module" / defer / async -->
  <script src="sdk.js"></script>
  <script>
    paranovell.ready().then(function () {
      var count = paranovell.data.get('count') || 0;
      var el = document.getElementById('app');
      el.textContent = '已保存的计数:' + count;
      el.onclick = function () {
        count += 1;
        paranovell.data.set('count', count);
        paranovell.save();
        el.textContent = '已保存的计数:' + count;
      };
    });
  </script>
</body>
</html>
```

在仓库根目录运行 `npm run dev` 打开调试台装载它,运行 `npm run pack <应用目录>` 打包。仓库里的 `examples/hello` 是一个带 AI 回合的完整例子。

`sdk.js` 不需要你自己提供:调试台在应用目录没有它时会自动提供当前版本;上传后平台会把包根的 `sdk.js` 换成平台当前版本。

## 3. 应用包与 `paranovell.json`

**清单文件本身必填**:包根必须有 `paranovell.json`,缺了直接拒收(5406)。但里面的**字段全部可选**:空对象 `{}` 就是合法清单。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `appName` | string | 否 | 显示名,最长 100 字。不写时用上传表单的标题兜底;两者都空则用默认名并触发 `default_name` 告警 |
| `entry` | string | 否 | 入口相对路径,默认 `index.html`;可指向包内任意 `.html`,但必须真实存在,否则拒收(5406) |
| `canvases` | object | 否 | 画布比例声明,见第 7 节。原文不超过 64 KB |

「清单在不在」与「`entry` 字段填得对不对」是两条独立判断:

- 包根没有 `paranovell.json`:5406。
- 清单存在,但没声明 `entry`、包里又没有 `index.html`:5402(包结构问题)。
- 清单存在,`entry` 写了但指向的文件不在包内:5406。

包内可以放任意文件类型(`.wasm`、音视频、无扩展名文件都行)。不要放 `dev/` 目录里的调试文件,也不要让 HTML 引用 `mock-host` / `paranovell-dev`,否则拒收(5402)。

## 4. 数据与存档

```js
await paranovell.ready();            // 之后才能读写
paranovell.data.get('hp');           // 读(深拷贝);不存在返回 undefined
paranovell.data.set('hp', 10);       // 写:值必须可 JSON 序列化,不能是 null / undefined
paranovell.data.append('log', {});   // 数组尾插;key 不存在视为空数组
paranovell.data.remove('tmp');       // 删除
paranovell.save();                   // 纯存档
```

要点:

- **写是同步生效的**:`set` / `remove` / `append` 调用后,`get` 立即读到新值;只是上行(落到平台)要等 `save()` 或回合确认。
- **`save()` 的节流**:调用即快照缓冲区,3 秒窗口内的多次调用合并为一次上行。页面隐藏 / 失焦时 SDK 也会兜底 flush。它返回的 Promise 在这次快照最终确认上行后 resolve。
- **`null` / `undefined` 不能写**:想删除用 `remove()`。`append` 的目标 key 已存在且不是数组会抛 TypeError。
- **操作日志语义**:缓冲区是有序操作日志(`set` / `remove` / `append`),顺序即语义;`data.pending()` 可以看到尚未上行的部分。
- **冲突**:同一份存档被另一处写入(例如另一个标签页)时,`save()` 会以 `DATA_CONFLICT` reject。服务端胜:SDK 已经用权威数据覆盖了内存并清空缓冲,你应当基于新数据重新渲染。
- **只读会话**:查看他人存档时写入不会上行,`save()` 以 `READONLY` reject。

## 5. AI 回合生命周期

声明一类回合:

```js
var askName = paranovell.defineRound('ask-name', {
  format: { name: '', reason: '' },              // 期望模型回复的 JSON 形状
  notes: '给主角起一个两字中文名,并用一句话说明理由', // 给模型的说明(可选)
  example: { name: '云舟', reason: '少年漂泊' },   // 示例(可选)
  handler: function (output) {                   // 唯一的回合写入点,可返回 Promise
    paranovell.data.set('heroName', output.name);
  }
});
var res = await askName({ input: '主角是一名少年剑客' }); // res.output 即模型回复
```

- `format`:普通对象 / 数组。key 加 `?` 后缀表示可选字段,值为 `null` 表示类型不限。它在 `defineRound` 那一刻被快照,之后原地修改对象不影响已发出的内容。
- `notes` / `example`:给模型看的说明与示例。SDK 会按当前语言拼好引导语。
- **同名重定义即覆盖**,旧的发起函数与新的完全等价(按名字现取当前定义)。
- 同一时刻只能有一轮在进行,第二次发起会以 `SUBMIT_IN_FLIGHT` reject。

一轮的过程:

1. `sender({ input })` 开出一轮,平台生成正文与你声明形状的 JSON 回复。
2. SDK 把回复交给 handler;handler(可以是异步的)把结果写进 `data`。
3. handler 结束后,SDK 自动把这一轮写入与此前未上行的快照一起**确认存档**,然后 `sender` 的 Promise resolve `{ output }`。

失败与回滚:

- handler 抛错:SDK 不确认存档,主动回滚这一轮,`sender` reject。
- 确认存档遇网络 / 超时 / 5xx:SDK 自动退避重试(从 1 秒起指数增长,上限 30 秒);平台明确拒绝时立即停止并按回滚收尾。
- `DATA_CONFLICT`:服务端数据胜出,本地被覆盖,这一轮不再生效。
- 回合期间 `save()` 不单独上行,回合确认时会一并吸收当时未上行的快照。

**刷新与换设备恢复**:玩家发送后立刻刷新或换设备打开,上一轮可能还在生成。平台会在后台把这一轮接回来,等正文生成完后**自动重放你注册的同名 `defineRound` handler 并确认存档**,你不需要写任何代码。因此:

- **必须在 `ready()` 之前**完成全部 `defineRound` / `defineHook` 注册,恢复到达时再补注册已经来不及(没有对应注册的轮次会被平台放弃并回滚)。
- **handler 的写入只能依赖 `data` 与本轮 `output`**。不要依赖只活在 JS 闭包里的中间状态:刷新后那些状态已经丢失,重放会静默算错且不报错。
- 想在恢复期间显示自己的「生成中」界面,在 `ready()` 之前订阅:

  ```js
  paranovell.onRoundPending(function (p) { showLoading(p.pending); });
  await paranovell.ready(); // 换设备时会一直等到正文生成完才返回,期间 pending 已经是 true
  ```

  `pending: false` 表示这一轮已结束(成功或被放弃)。不订阅不影响恢复本身。
- 想自己决定怎么接,可以订阅 `onRoundRecovery(cb)`:收到 `{ name, output, commit(), discard() }`。你自己把数据写进 `data` 后 `commit()` 确认,或 `discard()` 放弃。订阅后平台**不再**自动重放。不订阅不等于放弃这一轮。

## 6. Hook

Hook 让模型在**生成正文之前**按一个自然语言条件判断是否要问你的应用:

```js
paranovell.defineHook('inventory-check', {
  trigger: '当剧情涉及主角翻找或使用随身物品时',
  input: function () { return JSON.stringify(paranovell.data.get('inventory') || []); },
  format: { found: true, note: '' },
  notes: '根据背包内容回答主角是否持有该物品',
  handler: function (output) { /* 与 defineRound 的 handler 同样的约束 */ }
});
```

- `trigger`:触发条件,由模型判断,写成自然语言。
- `input()`:每次查询时现算,返回字符串(缺省空串),**不得返回 Promise**。
- `format` / `notes` / `example` / `handler`:与 `defineRound` 一致。
- 每个应用**最多一个** hook,重复定义覆盖;名字先去首尾空白,不得与任何 `defineRound` 重名;必须在 `ready()` 之前注册,这样刷新后才能恢复。

## 7. 展示与画布

**形态**:应用可以请求切换展示形态,共六种:`'split'`(分栏)、`'float'`(浮窗)、`'full'`(全屏)、`'mfull'`(手机全屏)、`'mland'`(手机横屏)、`'mdrawer'`(手机抽屉)。

```js
var r = await paranovell.ui.present('full');
// r = { applied, degraded, reason? }  宿主可能降级,以 applied 为准
paranovell.ui.getPresentation();          // 同步读本地快照 { form, canvas, scale },不发请求
var off = paranovell.ui.onPresentationChange(function (p) { /* 含宿主侧发起的变化 */ });
```

**画布**:只约束比例,不约束像素。三套 key:`portrait` / `landscape` / `compact`。

```js
await paranovell.ui.setCanvas({
  portrait: { safe: '9:16' },
  landscape: { safe: '16:9', bleed: { w: 1.2, h: 1.2 } }
});
```

`safe` 是 `"w:h"` 字符串,比例需在 0.05 到 20 之间;`bleed` 是背景外扩倍数,可选,`w` / `h` 都要在 1 到 3 之间。也可以直接写在清单的 `canvases` 里。非法取值以 `INVALID_PARAM` reject。`getPresentation()` 在 `ready()` 完成、收到第一次变化事件之前,`form` / `canvas` 为 `null`。

## 8. Plan(方案)

Plan 是小说里的「方案」实体,四种状态:`processing`(生成中 / 待确认)、`running`(已生效)、`complete`(已完结)、`discard`(已废弃,仅这一态可被重启)。

```js
var plans = await paranovell.plan.list();               // 按创建时间降序,含 content 全文
var ref = await paranovell.plan.create({ title: '...', content: '...' });
await paranovell.plan.restart(planId);                   // 只能重启已废弃的
```

`create` 与 `restart` 是写操作:**宿主会先弹一个授权框**,应用无法跳过、无法预检查是否会弹框、也无法改动框里的文字。用户拒绝时 reject `USER_REJECTED`,此时没有任何网络请求发生。因为要等用户响应,这两个调用耗时可能明显长于普通请求,SDK 对它们不设超时。`list()` 是纯读,不弹框。

## 9. 多语言

SDK 知道当前用户语言,取值 `'zh'` 或 `'en'`:

```js
paranovell.getLanguage();                   // ready() 之前调用也安全,默认跟随宿主
paranovell.onLanguageChange(function (lang) { /* 切换界面文案 */ });
paranovell.setLanguage('en');               // 显式覆盖并锁定,此后忽略宿主推送
```

- 语言经 `ready()` 的数据拉取与宿主推送两条路径更新,你不需要主动查询。
- `defineRound` 拼给模型的引导语会随语言切换,在每次发起时取值,不需要重新 `defineRound`。
- `onLanguageChange` 只在生效值确有变化时触发。
- `setLanguage` 非法值同步抛 TypeError。

## 10. 调试台

`npm run dev` 起本机调试台(只绑 127.0.0.1)。它模拟宿主:

- **应用装载**:列出仓库里的 `.html`,或「选择文件」从磁盘任意位置挑一个。
- **数据**:浏览 / 编辑,存在本机浏览器,刷新即模拟「宿主重启」。
- **AI 回复三模式**:`echo`(原样回显)、`fixed`(固定文本)、`manual`(每次手动填);可以按回合名分别设置,并「填入格式示例」。
- **故障注入**:存档失败、数据冲突、限流、回合超时、应用崩溃重载。
- **语言切换**、**请求日志**。

调试台里的应用写 `<script src="sdk.js">` 即可,没有自带 `sdk.js` 时会得到当前版本。端口、`--no-open` 等选项见 [dev/README.md](../dev/README.md)。调试文件不要进上传包。

## 11. 打包、上传与版本

打包:`npm run pack <应用目录>`,产出 `dist/<目录名>.zip`,包根是应用目录的**内容**。脚本会在打包前自检(清单、入口、SDK 引用写法、调试文件引用、限额),硬错误非零退出。

上传:登录平台 → Prompt Hub → 发布应用,在「05 应用包」拖入 zip。平台先建一个私有应用并校验;通过后填名称、封面(16:9)、简介、标签(1 到 5 个),点「发布应用」公开。

版本:

- 同一个应用可以持续上传新版本,最多保留 **7** 个未删除的版本;已满时上传会被拒(5439),先在版本管理里删掉不用的(默认版本和唯一的版本删不了)。
- 公开发布的是你指定的**默认版本**。已挂载该应用的小说不会被动切换版本,玩家可以自行选择。
- 只有原作者能升级、发布(5409)。

限额:

| 项 | 限额 |
|---|---|
| zip 原始体积 | 50 MB |
| 解压后总体积 | 150 MB |
| 包内文件数 | 1000 |
| `appName` 长度 | 100 字 |
| `canvases` 原文体积 | 64 KB |
| 每个应用的版本数 | 7 |

## 12. 运行限制

应用跑在 `<iframe sandbox="allow-scripts">`(不带 `allow-same-origin`)里,浏览器给它一个 opaque origin:**不是另一个域名,而是没有域名**。所有限制都从这一点推出来。

能做:

- 任意文件类型,包括 `.wasm`、音视频、无扩展名文件。
- `fetch` 自己包里的文件(含 `Range` 分片请求)。
- WebAssembly:`WebAssembly.instantiate` / `instantiateStreaming`。
- Worker,但要 blob 形式:`new Worker(URL.createObjectURL(blob))`。
- `canvas.toBlob()` 之后 `<img src="blob:...">` / `fetch(blobURL)`;`data:` / `blob:` 资源放开。
- `<iframe src="./sub.html">` 套自己包里的页面,子页面同样受同一套限制。
- 你自己的脚本可以用 `<script type="module">`(SDK 那个标签除外)。

不能做:

- **连任何外部地址**(`fetch` / XHR / `<img>` 信标 / 表单提交 / 自导航 / 外链 `<iframe>`)。应用拿到的是用户的小说数据,不能有一条路把它送出去。外部 CDN 的脚本、样式、字体会**静默失效**——页面照样渲染,不报错。把资源打进包里。
- **`localStorage` / `sessionStorage` / `indexedDB`**:没有源就没有存储分区,取属性就抛 `SecurityError`。持久化只走 `data.*` + `save()`。
- **同源 classic Worker**(`new Worker('./w.js')`):报 `cannot be accessed from origin 'null'`,改用 blob worker。
- **`eval()` / `new Function()`**:不允许 `unsafe-eval`(只为 WASM 编译留了窄口子)。
- **WebRTC**(`RTCPeerConnection` 等):上传期直接拒收,不允许有第二条出网路径。
- **SDK 那个 `<script src="sdk.js">` 加 `type="module"` / `defer` / `async`**:SDK 必须在你的脚本之前同步就绪,这三个属性会打破顺序。不会拒收,降级成告警,但功能大概率是坏的。

几个由「没有域名」带来的现象:`fetch` 自己包里的文件在浏览器眼里也是跨源请求(平台已经配好许可);`<script type="module">` 以 CORS 模式加载(平台同样已配好)。你不需要处理这些。

**滚动条**:SDK 加载后默认隐藏文档级(`html` / `body`)滚动条,整页内容超出窗口时仍可滚动(触摸、滚轮、键盘照常),只是不显示滚动条;你自己容器里的滚动条不受影响。需要可见滚动条时,让内容在自己的容器里滚动:

```css
html, body { height: 100%; margin: 0; }
.list { height: 100%; overflow-y: auto; } /* 滚动条正常显示 */
```

## 13. 错误码

### SDK 运行时(Promise 拒绝的 `error.code`)

| code | 含义 |
|---|---|
| `SUBMIT_IN_FLIGHT` | 已有一轮回合在进行,同时只能有一轮 |
| `DATA_CONFLICT` | 存档锚点与服务端不一致,SDK 已用服务端数据覆盖本地 |
| `RATE_LIMITED` | 请求过于频繁 |
| `READONLY` | 当前会话只读,写入不会上行 |
| `TIMEOUT` | 请求超时 |
| `INVALID_PARAM` | 入参非法(不支持的 form、画布比例越界等) |
| `USER_REJECTED` | 用户在授权框里拒绝 |
| `INTERNAL` | 其它内部错误 |

### 上传被拒

响应体统一为 `{ "code": <错误码>, "message": "..." }`。

| 错误码 | HTTP | 原因 | 怎么修 |
|---|---|---|---|
| 5401 | 400 | 包内路径不安全:条目名含反斜杠或 NUL、以 `/` 开头的绝对路径或 Windows 盘符、任一段为 `..`、条目是符号链接 | 用标准 zip 工具重新打包 |
| 5402 | 400 | 包结构不合规:不是有效 zip;包为空(只剩系统垃圾文件);条目损坏或重复(大小写冲突);HTML 无法解析;清单没声明 `entry` 且包内没有 `index.html`;用了 WebRTC;HTML 引用了 `mock-host` / `paranovell-dev` | 按提示信息定位;最常见的是入口缺失与引用了调试文件 |
| 5403 | 413 | zip 超 50 MB,或解压后超 150 MB | 压缩媒体、去掉无用资源 |
| 5404 | 400 | 文件数超过 1000(目录条目与系统垃圾文件不计) | 合并零散小文件 |
| 5406 | 400 | 包根没有 `paranovell.json`;或清单不是合法 JSON、`appName` 超 100 字、`entry` 不是 `.html` 或指向的文件不存在、`canvases` 超 64 KB 或取值非法 | 缺文件就补一份 `{}`;写错了按第 3、7 节修正 |
| 5409 | 403 | 不是这个应用的作者 | 用原作者账号,或作为新应用上传 |
| 5410 | 409 | 同一个幂等键对应了不同的上传参数、你已有另一个应用包正在校验中,或这次上传已被取消 | 等当前校验结束(或先取消)后重试;换了包请用新的幂等键;上传已被取消则重新发起上传 |
| 5439 | 409 | 该应用已有 7 个未删除的版本 | 在版本管理里删掉不用的旧版本再传 |

另外,没有提供 `package` 文件、`title` / `synopsis` / `cover_url` 不是合法 UTF-8、公开发布时缺标题 / 封面 / 简介、标签数量不在 1 到 5 个之间等,会以通用的 400 拒收,按提示信息修正表单即可。

### 上传告警(不拦,但多半运行不对)

响应的 `warnings` 字段带 `{ kind, path, line }`:

| kind | 触发条件 | 说明 |
|---|---|---|
| `local_storage` | 脚本里出现 `localStorage` / `sessionStorage` / `indexedDB` | 运行时抛 `SecurityError`,改用 `paranovell.data.*` |
| `web_worker` | `new Worker(...)` / `new SharedWorker(...)` 且同文件没有 `createObjectURL` | 大概率是同源 worker,起不来 |
| `external_resource` | `<link>` / `<script>` / `<img>` / `<iframe>` 等标签或 CSS 的 `@import` / `url()` 指向外部地址 | 被静默拦截,把资源打进包里 |
| `dev_artifact` | 文件被识别为本地调试脚手架 | 多半不该出现在发布包里 |
| `sdk_reference` | 指向 `sdk.js` 的 `<script>` 带了 `defer` / `async` / `type="module"` | SDK 可能未就绪就被引用 |
| `default_name` | 清单 `appName` 和表单标题都为空 | 已用默认名兜底,建议补标题 |

## 14. 兼容承诺

- 当前 SDK 大版本 **v1**,版本号见 `versions/v1/sdk-version.json`,变更见 [CHANGELOG](../CHANGELOG.md)。
- v1 的公开 API **只增不改**:只新增方法,或给既有方法加**可选**参数;不改既有方法的入参个数与顺序、返回值结构、必填项;不改运行时校验的强度(既不收紧也不放松);不改调用时序语义(例如 `ready()` 之前能否调 `data.*`、回合并发时的拒绝行为)。
- 破坏性变更一律走新的大版本(`versions/v2/`),v1 继续可用。
- 平台维护你包根的 `sdk.js`:同一大版本内的修复你自动获得,无需重新上传。
- 双下划线前缀的字段(`__onEvent` 等)是内部接口,不在承诺内,应用代码不要调用。

## 15. FAQ

**我的应用在调试台好用,上传后白屏 / 样式丢了?**
先看上传响应里的 `warnings`。最常见的是外部 CDN 的脚本、样式、字体被静默拦截(`external_resource`),把它们打进包里。

**可以用 React / Vue / 打包工具吗?**
可以,只要产出是纯静态文件,且 SDK 的 `<script src="sdk.js">` 保持普通脚本标签(不要被打包工具改成 module)。把构建产物目录当作应用目录来打包。

**怎么存大对象 / 图片?**
`data` 适合结构化 JSON 状态。图片、音视频等资源直接放进包里用相对路径引用,不要塞进 data。

**为什么 `data.set(key, null)` 报错?**
`null` / `undefined` 不是合法值,删除用 `remove(key)`。

**刷新后我的回合 handler 被执行了一次,是 bug 吗?**
不是,这是恢复:上一轮没完成,平台在正文生成完后自动重放你的 handler 并确认存档。保证 handler 只依赖 `data` 与 `output` 即可,见第 5 节。

**`ready()` 一直不返回?**
换设备或清过缓存时,若上一轮正文还在生成,`ready()` 会等它生成完才带数据返回;可以在 `ready()` 前用 `onRoundPending` 显示「生成中」。

**我能同时跑两个回合吗?**
不能,第二个会以 `SUBMIT_IN_FLIGHT` reject。需要排队就在应用里自己串行。

**`plan.create` 很久不返回?**
它在等用户在授权框里点选择,不是卡死,SDK 对它不设超时。

**为什么 `localStorage` 直接抛错而不是返回空?**
应用没有源,浏览器没有分区可给,所以取属性就抛 `SecurityError`。用 `paranovell.data.*`。
