/**
 * paranovell sandbox mock 宿主引擎(dev 专用)—— 纯 JS 单文件,无构建产物,零 DOM。
 *
 * 挂载:window.ParanovellMockHost(单例,IIFE)。dev.html 调 attach() 接线实际的
 * iframe 收发与重载动作;协议引擎本身不碰 window.postMessage/iframe/DOM,收发
 * 全部经 attach() 注入的 { postToApp, onFromApp, requestReload } 三个回调完成。
 *
 * 定位:真 sdk.js(../versions/v1/sdk.js,原样运行、零改动)在"应用"一侧;本文件在"宿主+后端"
 * 一侧,实现桥协议全集(sys.ping / data.pull / data.submit / data.save /
 * data.rollback)+ per-app localStorage 存储 + 回合状态机 + AI 返回三模式(echo /
 * fixed / manual)+ 故障注入(save-fail / conflict / rate-limit / submit-timeout)+
 * 事件下行通道(api.emit() 镜像 宿主桥 的 HostBridge.emit(),
 * 下发 `{type:'event', event, payload}` 驱动被装载应用(真 sdk.js)内部的 __onEvent
 * 订阅回调;不占频控配额、不参与回合状态机)+ 语言开关(api.setLocale()/
 * api.getLocale() 镜像 宿主桥 的 getLanguage() + sys.languageChange 推送——
 * data.pull 回包与 emitState() 快照均带 locale,setLocale() 切换后广播
 * sys.languageChange,供调试台在无真实宿主的情况下也能试出双语链路)。
 *
 * 不含"恢复体检"(影子重放确定性检查器):SDK 不做运行时的 handler 确定性校验,
 * "handler 确定性"是应用自身的责任。崩溃恢复时 SDK 默认自动重放已注册的 handler,
 * onRoundRecovery 是可选的覆盖钩子。
 *
 * 语义基准(独立手写的平行实现,不复用宿主源码):
 *   - 真实宿主桥的回合状态机(互斥扩窗、round 匹配、rollback 仅 ready 期放行、
 *     纯存档节流镜像、纯存档在途占忙)。
 *   - ../versions/v1/sdk.js(信封格式 {id,type,method,params} /
 *     {id,type,ok,data|error};request()/handleIncomingRaw 的对端行为)。
 * 对外接口形状对齐 ./paranovell-dev.d.ts 与 dev.html 的运行时假设。本文件采用"并集"
 * payload,paranovell-dev.d.ts 已同步为该并集形状(见文件尾对外接口装配处的说明)。
 *
 * 崩溃语义:localStorage 持久化确认态数据 + revision、pendingRound、handler mock
 * 配置、故障开关(键前缀 paranovell-dev:<appKey>:)——刷新/重开页面即模拟宿主重启。
 * attach() 与 crash() 都会重置引擎瞬态(回合相位、
 * 节流/占忙标记、manual 挂起队列),但绝不触碰 localStorage——两者的区别只是
 * crash() 保留 dev.html 已注册的事件监听(它是"应用崩溃重载",不是"控制台自己重启"),
 * attach() 才会清空监听(它是"全新挂载一个引擎实例")。
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // 常量
  // ------------------------------------------------------------------

  var STORAGE_PREFIX = 'paranovell-dev:';
  // 纯存档节流镜像窗口——与 SDK 侧 save() 3s 合并节流同一量级(宿主桥 同名常量语义)。
  var PURE_SAVE_THROTTLE_MS = 3000;
  // RATE_LIMITED 故障未显式指定 retryAfter 时的默认值(秒)。
  var DEFAULT_RATE_LIMIT_RETRY_S = 3;
  // submit-timeout 故障未显式指定 timeoutMs 时的默认值——"AI 一直不回,mock 先结算"。
  var DEFAULT_SUBMIT_TIMEOUT_MS = 10000;

  // ------------------------------------------------------------------
  // 工具函数
  // ------------------------------------------------------------------

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 原型污染封堵:  changes[].key 命中这三个键时跳过(不落盘、不
  // 报错,继续处理其余 changes)——与真实宿主侧数据服务的
  // DANGEROUS_KEYS 同一份清单(真桥 v2 同款防御)。
  // 对象字面量里的 `'__proto__': true` 是 ECMAScript 特例语法
  // (非 computed/非 shorthand/非 method 的 __proto__ 键会被解释成"设置原型",不是
  // "创建一个名为 __proto__ 的自有属性")——赋的值 true 不是 object/null,原型设置被
  // 静默忽略,结果是 UNSAFE_KEYS 上根本没有 __proto__ 这个自有属性,hasOwn(...,'__proto__')
  // 恒为 false,对最该防的 __proto__ 反而放行(死代码)。改用 Object.create(null) + 逐个
  // 赋值:null 原型对象没有继承的 __proto__ setter 可触发,赋值就是普通自有属性写入。
  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS['__proto__'] = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;
  function isUnsafeKey(key) {
    return hasOwn(UNSAFE_KEYS, key);
  }

  // 深拷贝:与 sdk.js 同款——数据全程走 JSON 桥,JSON 往返即可满足语义。
  function deepClone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeAppKey(key) {
    return typeof key === 'string' && key ? key : 'default';
  }

  // ------------------------------------------------------------------
  // 存储层(localStorage,per-app;单 key 存整块 JSON,保证一次读写的原子性)
  // ------------------------------------------------------------------

  function storageKeyFor(appKey) {
    return STORAGE_PREFIX + appKey + ':state';
  }

  function getLocalStorage() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    } catch (e) { /* 访问受限(如隐私模式),退化为不持久化 */ }
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* 同上 */ }
    return null;
  }

  function defaultFaults() {
    return {
      'save-fail': { enabled: false, once: true },
      'conflict': { enabled: false, once: true },
      'rate-limit': { enabled: false, once: true, retryAfter: DEFAULT_RATE_LIMIT_RETRY_S },
      'submit-timeout': { enabled: false, once: true, timeoutMs: DEFAULT_SUBMIT_TIMEOUT_MS },
    };
  }

  function defaultStore() {
    return {
      confirmed: { data: {}, revision: 0 },
      readonly: false,
      pendingRound: null, // { round, output, handler, input, outputFormat, outputNotes, startedAt } | null
      handlers: {}, // handlerName -> { mode: 'fixed'|'manual', fixedJson?, delayMs? }(echo 默认,不占配置项)
      faults: defaultFaults(),
      // store 级总开关,开启时 resolveHandlerConfig 对
      // data.submit 一律派 manual(不改写任何 per-handler 配置),关掉后各 handler 原
      // 配置原样生效——见 resolveHandlerConfig() 与 api.setManualTakeover()。
      manualTakeover: false,
      // round 与 revision 两轴分叉:round 是独立自增的客户端回合序号,不再从
      // confirmed.revision 派生——revision 是服务端数据版本,纯存档也会推进它,round
      // 只在 data.submit 受理时才 +1;两者在真实后端下会分叉(纯存档、discardRound 均
      // 只影响其中一条轴)。round 号一旦发出即被"消费",作废/回滚也不回退它。
      roundSeq: 0,
      // plan(方案)列表——独立于 confirmed.data 的另一块状态,
      // 镜像真实宿主的 plan 一等实体与沙盒数据面(confirmed/
      // pendingRound/revision 等)完全解耦。planSeq 是独立自增的 id 生成计数轴,不与
      // roundSeq 混用(round 是回合序号,planId 与回合毫无关系)。
      plans: [], // { id, title, content, status, createdAt } 数组,顺序不隐含语义(list() 现算现排)
      planSeq: 0,
    };
  }

  function mergeFaults(parsedFaults) {
    var base = defaultFaults();
    for (var kind in base) {
      if (hasOwn(base, kind) && parsedFaults && hasOwn(parsedFaults, kind) && parsedFaults[kind]) {
        base[kind] = parsedFaults[kind];
      }
    }
    return base;
  }

  function normalizeStore(parsed) {
    var base = defaultStore();
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      confirmed: (parsed.confirmed && typeof parsed.confirmed === 'object')
        ? {
          data: parsed.confirmed.data || {},
          revision: typeof parsed.confirmed.revision === 'number' ? parsed.confirmed.revision : 0,
        }
        : base.confirmed,
      readonly: !!parsed.readonly,
      pendingRound: parsed.pendingRound || null,
      handlers: (parsed.handlers && typeof parsed.handlers === 'object') ? parsed.handlers : base.handlers,
      faults: mergeFaults(parsed.faults),
      manualTakeover: !!parsed.manualTakeover,
      roundSeq: typeof parsed.roundSeq === 'number' ? parsed.roundSeq : base.roundSeq,
      plans: Array.isArray(parsed.plans) ? parsed.plans : base.plans,
      planSeq: typeof parsed.planSeq === 'number' ? parsed.planSeq : base.planSeq,
    };
  }

  function loadStore(appKey) {
    var ls = getLocalStorage();
    if (!ls) return defaultStore();
    try {
      var raw = ls.getItem(storageKeyFor(appKey));
      if (!raw) return defaultStore();
      return normalizeStore(JSON.parse(raw));
    } catch (e) {
      return defaultStore();
    }
  }

  function saveStore(appKey, store) {
    var ls = getLocalStorage();
    if (!ls) return;
    try {
      ls.setItem(storageKeyFor(appKey), JSON.stringify(store));
    } catch (e) { /* 持久化失败(如配额限制):保留内存态继续运行,不中断协议流程 */ }
  }

  // changes = 操作日志(取代 key 级快照):
  //   [{op:'set',key,value} | {op:'remove',key} | {op:'append',key,value}],顺序即语义。
  // op 词汇表由 SDK 收口,超出三种的整体拒绝(见 isValidOpList,调用方在应用前把关)。
  var VALID_OPS = { set: true, remove: true, append: true };

  function isValidOpList(changes) {
    if (!Array.isArray(changes)) return false;
    for (var i = 0; i < changes.length; i++) {
      var ch = changes[i];
      if (!ch || typeof ch !== 'object' || typeof ch.key !== 'string' || !hasOwn(VALID_OPS, ch.op)) return false;
      // set/append 必须带 value——此前不校验,`{op:'set',key}`
      // 会把 value 落成 undefined(deepClone(undefined) 在 sdk.js 里就是"没有这个概念",
      // 这里却会真的写入 undefined),`{op:'append',key}` 会把 undefined 尾插成
      // `[null]`(deepClone 走 JSON 往返,undefined 序列化为 null)——两者都是应该在
      // 格式校验层面就拒绝的畸形输入,不该放过去悄悄污染数据。remove 本身不带 value,
      // 不受此约束。
      if ((ch.op === 'set' || ch.op === 'append') && ch.value === undefined) return false;
    }
    return true;
  }

  // append 目标(截至该 op 为止,changes 累积应用后的当前值)若
  // 已存在且不是数组,整体拒绝——与 sdk.js dataAppend 的 TypeError 语义对齐(见 sdk.js
  // "目标 key 若已存在且当前值不是数组,拒绝")。此前 mock 端在 applyChangesToConfirmed
  // 里静默把非数组值拍扁成 `[item]`,当 mock 确认态与 SDK 内存因 editData/冲突等路径分叉
  // 时会悄悄损坏数据。与 isValidOpList 同一层级:先于任何 store 写入、不部分应用。
  // 用一份浅拷贝的 scratch 模拟 changes 按序应用,得到"每条 append 执行时刻"的目标值——
  // 同一批 changes 里更早的 set 可能先把目标建成数组,这种情况必须放行。
  function isValidAppendTargets(confirmedData, changes) {
    var scratch = {};
    for (var key in confirmedData) {
      if (hasOwn(confirmedData, key)) scratch[key] = confirmedData[key];
    }
    for (var i = 0; i < changes.length; i++) {
      var ch = changes[i];
      if (isUnsafeKey(ch.key)) continue; // 危险 key 不参与校验,applyChangesToConfirmed 本就会跳过它
      if (ch.op === 'set') {
        scratch[ch.key] = ch.value;
      } else if (ch.op === 'remove') {
        delete scratch[ch.key];
      } else if (ch.op === 'append') {
        var current = hasOwn(scratch, ch.key) ? scratch[ch.key] : undefined;
        if (current !== undefined && !Array.isArray(current)) return false;
        scratch[ch.key] = (current === undefined ? [] : current).concat([ch.value]);
      }
    }
    return true;
  }

  // 按序应用三种 op 到确认态数据(与 sdk.js 的 dataSet/dataRemove/dataAppend 语义对齐)。
  // UNSAFE_KEYS 过滤沿用,对每条 op 的 key 单独判断——命中则跳过这一条,不报错、不中断
  // 其余 op 的应用(与整体非法 op 拒绝是两回事:前者是安全过滤,后者是格式校验)。调用方
  // 必须先经 isValidAppendTargets() 把关,这里不再重复校验 append 目标合法性。
  function applyChangesToConfirmed(store, changes) {
    for (var i = 0; i < changes.length; i++) {
      var ch = changes[i];
      if (!ch || typeof ch.key !== 'string' || isUnsafeKey(ch.key)) continue;
      if (ch.op === 'set') {
        store.confirmed.data[ch.key] = deepClone(ch.value);
      } else if (ch.op === 'remove') {
        delete store.confirmed.data[ch.key];
      } else if (ch.op === 'append') {
        var current = store.confirmed.data[ch.key];
        if (!Array.isArray(current)) current = [];
        store.confirmed.data[ch.key] = current.concat([deepClone(ch.value)]);
      }
      // 到达这里的 op 已经过 isValidOpList() 把关,恒为三者之一,无 else 分支。
    }
  }

  // ------------------------------------------------------------------
  // 故障注入:仅一次(once,默认 true)= 命中后自动关闭该开关
  // ------------------------------------------------------------------

  function disabledFaultEntry(kind, prev) {
    var base = { enabled: false, once: prev ? prev.once : true };
    if (kind === 'rate-limit') base.retryAfter = prev ? prev.retryAfter : DEFAULT_RATE_LIMIT_RETRY_S;
    if (kind === 'submit-timeout') base.timeoutMs = prev ? prev.timeoutMs : DEFAULT_SUBMIT_TIMEOUT_MS;
    return base;
  }

  // 命中即消费(mutate store.faults[kind] 并由调用方持久化);未命中返回 null。
  function consumeFault(store, kind) {
    store.faults = store.faults || defaultFaults();
    var entry = store.faults[kind];
    if (!entry || !entry.enabled) return null;
    var opts = {};
    for (var k in entry) if (hasOwn(entry, k)) opts[k] = entry[k];
    if (entry.once !== false) {
      store.faults[kind] = disabledFaultEntry(kind, entry);
    }
    return opts;
  }

  function consumeFirstOf(store, kinds) {
    for (var i = 0; i < kinds.length; i++) {
      var opts = consumeFault(store, kinds[i]);
      if (opts) return { kind: kinds[i], opts: opts };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // AI 返回三模式(echo 默认 / fixed / manual)
  // ------------------------------------------------------------------

  // manualTakeover 开启时对 data.submit 一律派 manual——直接短路返回一个合成
  // 配置对象,不读取也不改写 store.handlers[handlerName],保证关掉后各 handler 的
  // echo/fixed/manual 原配置原样生效(不是"记住旧值再恢复",是从未被动过)。
  function resolveHandlerConfig(store, handlerName) {
    if (store.manualTakeover) return { mode: 'manual' };
    var cfg = store.handlers && store.handlers[handlerName];
    return cfg || { mode: 'echo' };
  }

  function resolveOutput(cfg, input) {
    if (cfg.mode === 'fixed') return deepClone(cfg.fixedJson === undefined ? {} : cfg.fixedJson);
    return deepClone(input); // echo(默认):原样返回
  }

  // 首次见到某个 handler 名即自动登记进 store.handlers
  // (默认 echo,不改变既有行为——未登记的 handler 本就走 echo 分支),并把本轮
  // outputFormat 记为该 handler 的 lastFormat(每轮覆盖式更新,不追加历史)——
  // dev.html「填入格式示例」按钮取的就是这份 lastFormat。outputNotes 同一生命周期记为 lastNotes
  // (同样每轮覆盖式更新,可能是 undefined——不传时不写入该字段,保持"未提供"与"提供
  // 空串"的区分)。持久化 + 广播 onState 交给调用方(handleDataSubmit)与既有的故障
  // 消费合并成一次 saveStore+emitState,时序对齐 setMockMode 的"先落盘再广播"。
  // handler 名命中 UNSAFE_KEYS(__proto__/prototype/constructor)时整体跳过——不登记
  // 也不记 lastFormat/lastNotes,与 isUnsafeKey 的原型污染防线共用同一份清单。
  function registerHandlerFormat(store, handlerName, outputFormat, outputNotes) {
    if (isUnsafeKey(handlerName)) return;
    store.handlers = store.handlers || {};
    if (!hasOwn(store.handlers, handlerName)) {
      store.handlers[handlerName] = { mode: 'echo' };
    }
    store.handlers[handlerName].lastFormat = deepClone(outputFormat);
    if (outputNotes !== undefined) {
      store.handlers[handlerName].lastNotes = deepClone(outputNotes);
    } else {
      delete store.handlers[handlerName].lastNotes;
    }
  }

  // ==================================================================
  // 引擎瞬态(单例;attach()/crash() 重置,不落 localStorage —— 与真桥同语义:
  // 这些是"桥实例生命周期内"的状态,不是持久化数据)
  // ==================================================================

  // 调试台语言开关——镜像宿主侧 getLanguage()(宿主的语言状态)。**故意不放进 resetTransientState()**:
  // 真实宿主的语言是跨 session/app 的全局 UI 偏好,不随"某个沙盒桥重建/应用崩溃重载"
  // 复位——attach()/crash()/setAppKey() 都不应该把调试台已经切好的语言冲掉,与
  // appKey/postToAppFn 这类"每个引擎实例的接线状态"是两种不同性质,故单独放在这里
  // 而不进下面 resetTransientState() 覆盖的那个字段集合。
  var currentLocale = 'zh';

  // 崩溃恢复自动交还:真实宿主(宿主桥)在
  // data.pull handler 内部会自动触发 checkAndRecoverSandboxRound——pull 见到
  // pendingRound 之后,"后台取到 output、决定能不能交还"这件事不需要开发者/宿主再手动
  // 做任何事,是全自动的(对应真宿主"取 output"这段耗时,秒到分钟级)。mock-host.js 此前
  // 只在 data.pull 里 seed 状态、下发 pendingRound,从不自动 emit round.handback/
  // discard,开发者据此会得出"刷新后要手动触发交还"这个错误模型——比一个 bug 更糟,因为
  // 它会被当成"这就是设计"照抄进真实应用的心智模型里。默认改成 pull 见到 pendingRound
  // 后延迟自动 emit round.handback(与 currentLocale 同款:devtools 级调试偏好,不随
  // attach()/crash() 复位,方便"崩溃重开→照常自动交还"这条默认路径反复演练);
  // setRecoveryMode('manual') 关掉自动、保留 simulateRoundHandback()/simulateRoundDiscard()
  // 做手工故障演练(比如交还一个未注册的 handler 名复现该分支)。
  var recoveryMode = 'auto';
  var recoveryHandbackDelayMs = 1500;

  var appKey = 'default';
  var postToAppFn = null;
  var requestReloadFn = null;
  // 世代计数:  attach()/crash() 各自递增;所有 setTimeout 延迟
  // 回调经下方 scheduleTimeout() 在调度时捕获当时 epoch,执行时与当前 epoch 不符即
  // 短路(不 respond、不写 store、不发事件)——杜绝崩溃重载后陈旧定时器跨代错配
  // (sdk.js 重载后请求 id 归零复用,陈旧响应可能被新实例误认)。
  var epoch = 0;

  var connected = false; // sys.ping 收到后置 true(握手语义)
  // 回合相位三态,独立手写、语义对照 宿主桥 的 evaluateRoundGuard:
  //   idle:无在途回合;submitting:data.submit 已受理、尚未落 pendingRound;
  //   pendingSave{round}:该轮已开出(或由 pull 重新 seed),等待确认 save/rollback。
  var roundPhase = { phase: 'idle' };
  // 首次真实 data.submit 受理后置 true,标志"ready 期"结束——data.rollback 之后一律
  // 本地拒绝(与 宿主桥 的 readyPeriodOver 同语义,只在 attach()/crash() 时复位)。
  var readyPeriodOver = false;
  var lastPureSaveAt = null; // 纯存档节流镜像用的时间戳
  var pureSaveInFlight = false; // 纯存档在途占忙标记
  var manualQueue = {}; // id -> { id, handler, input, outputFormat, outputNotes, round, receivedAt }
  var pendingLogMeta = {}; // id -> { method, params, startedAt }(请求-响应配对与耗时计算)
  // ui.* 简化裁决状态——mock 不做端能力/画布可用性判断(那是宿主组件层
  // resolveForm/resolveCanvas 的职责,dev 场景没有真实 viewport/shell),只如实记录
  // "最近一次 present() 请求的形态"与"最近一次已声明的画布集里第一个 key",供协议
  // 层联调用。与其它引擎瞬态同生命周期,attach()/crash() 时重置。
  var uiPresentation = { form: null, canvas: null, scale: 1 };

  var logListeners = [];
  var pendingListeners = [];
  var stateListeners = [];

  function resetTransientState() {
    connected = false;
    roundPhase = { phase: 'idle' };
    readyPeriodOver = false;
    lastPureSaveAt = null;
    pureSaveInFlight = false;
    manualQueue = {};
    pendingLogMeta = {};
    uiPresentation = { form: null, canvas: null, scale: 1 };
  }

  // 世代计数保护——包一层 setTimeout,调度时快照 epoch,执行时不符即短路(不执行
  // fn,因此不会 respond/写 store/发事件)。本文件所有"模拟异步网络往返"的延迟回调
  // 一律经此调用,不直接用裸 setTimeout。
  function scheduleTimeout(fn, delay) {
    var callEpoch = epoch;
    return setTimeout(function () {
      if (callEpoch !== epoch) return;
      fn();
    }, delay);
  }

  // ------------------------------------------------------------------
  // 事件总线:onLog/onPending/onState 各自独立订阅数组
  // ------------------------------------------------------------------

  function subscribe(list, fn) {
    if (typeof fn !== 'function') return function () {};
    list.push(fn);
    return function () {
      var idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  function callListeners(list, payload) {
    var snapshot = list.slice(); // 防止监听器内增删订阅导致下标错位
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](payload); } catch (e) { /* 消费方回调异常不应打断引擎 */ }
    }
  }

  function emitState() {
    var store = loadStore(appKey);
    callListeners(stateListeners, {
      data: deepClone(store.confirmed.data),
      revision: store.confirmed.revision,
      readonly: !!store.readonly,
      connected: connected,
      // roundState 是 pendingRound 存在性的派生视图(与 paranovell-dev.d.ts 对齐);
      // pendingRound 字段本身携带完整详情(与 dev.html 实际渲染需要对齐,见文件尾说明)。
      roundState: roundPhase.phase !== 'idle' ? 'in-flight' : 'idle',
      pendingRound: store.pendingRound ? {
        round: store.pendingRound.round,
        handler: store.pendingRound.handler,
        output: deepClone(store.pendingRound.output),
        startedAt: store.pendingRound.startedAt,
      } : null,
      handlers: deepClone(store.handlers || {}),
      faults: deepClone(store.faults || defaultFaults()),
      manualTakeover: !!store.manualTakeover,
      // 把当前调试台语言一并广播进状态快照,与其它可控项(readonly/
      // manualTakeover 等)同一读回路径,供 dev.html 需要时核对当前值。
      locale: currentLocale,
      // 恢复交还的自动化模式同样是一个可控项(见
      // setRecoveryMode/getRecoveryMode),此前只能靠 getRecoveryMode() 单独查询,
      // 状态面板/测试若只订阅 onState 快照就看不到当前模式——与 locale/readonly/
      // manualTakeover 同一读回路径补上。
      recoveryMode: recoveryMode,
    });
  }

  function emitPending() {
    var items = [];
    for (var id in manualQueue) {
      if (hasOwn(manualQueue, id)) {
        var e = manualQueue[id];
        items.push({
          id: e.id,
          handler: e.handler,
          input: deepClone(e.input),
          outputFormat: deepClone(e.outputFormat),
          outputNotes: e.outputNotes === undefined ? undefined : deepClone(e.outputNotes),
          round: e.round,
          receivedAt: e.receivedAt,
        });
      }
    }
    callListeners(pendingListeners, items);
  }

  // ------------------------------------------------------------------
  // 信封收发:与 sdk.js 的 request()/handleIncomingRaw 逐字节对接
  //   出:{ id, type: 'request', method, params }(sdk.js request() 第 150-156 行构造)
  //   入:{ id, type: 'response', ok, data } | { id, type: 'response', ok:false, error }
  //     (sdk.js handleIncomingRaw 第 187-201 行消费)
  // ------------------------------------------------------------------

  function sendToApp(msg) {
    postToAppFn(JSON.stringify(msg));
  }

  // 请求到达时先记一条"挂起"日志(direction: app-to-host,无 result/error/durationMs);
  // 结算(respondOk/respondErr)时再补发一条"结算"日志(direction: host-to-app,带
  // result|error 与 durationMs),同 id 供 UI 合并渲染——耗时与配对全部由引擎计算。
  function dispatch(id, method, params) {
    var startedAt = Date.now();
    pendingLogMeta[id] = { method: method, startedAt: startedAt };
    callListeners(logListeners, {
      id: id,
      direction: 'app-to-host',
      method: method,
      params: params,
      timestamp: startedAt,
    });

    switch (method) {
      case 'sys.ping': handleSysPing(id); break;
      case 'sys.reportSdkVersionDrift': handleSysReportSdkVersionDrift(id, params); break;
      case 'round.hookOffer':
        if (params && hookQueries[params.queryId]) hookQueries[params.queryId](params.hook || null);
        else if (params) api.emit('hook.settled', { queryId: params.queryId, hit: false });
        respondOk(id, {});
        break;
      case 'data.pull': handleDataPull(id); break;
      case 'data.submit': handleDataSubmit(id, params); break;
      case 'data.save': handleDataSave(id, params); break;
      case 'data.rollback': handleDataRollback(id, params); break;
      case 'ui.present': handleUiPresent(id, params); break;
      case 'ui.setCanvas': handleUiSetCanvas(id, params); break;
      case 'ui.pointerEnter': handleUiPointerEnter(id); break;
      case 'ui.focusRect': handleUiFocusRect(id); break;
      case 'ui.viewportGesture': handleUiViewportGesture(id); break;
      case 'plan.list': handlePlanList(id); break;
      case 'plan.create': handlePlanCreate(id, params); break;
      case 'plan.restart': handlePlanRestart(id, params); break;
      default:
        respondErr(id, 'INTERNAL', 'no handler registered for method "' + method + '"');
    }
  }

  function finishLog(id, extra) {
    var meta = pendingLogMeta[id];
    delete pendingLogMeta[id];
    var now = Date.now();
    var entry = {
      id: id,
      direction: 'host-to-app',
      method: meta ? meta.method : undefined,
      timestamp: now,
      durationMs: meta ? (now - meta.startedAt) : undefined,
    };
    if (hasOwn(extra, 'result')) entry.result = extra.result;
    if (hasOwn(extra, 'error')) entry.error = extra.error;
    callListeners(logListeners, entry);
  }

  function respondOk(id, data) {
    finishLog(id, { result: data });
    sendToApp({ id: id, type: 'response', ok: true, data: data });
  }

  function respondErr(id, code, message, payload) {
    var error = { code: code, message: message };
    if (payload !== undefined) error.payload = payload;
    finishLog(id, { error: error });
    sendToApp({ id: id, type: 'response', ok: false, error: error });
  }

  // submit-timeout 故障:mock 先主动回 SUBMIT_FAILED,随后"迟到"的真实成功响应用
  // 这个函数单独发出——此时 pendingLogMeta[id] 早已在 SUBMIT_FAILED 结算时被清空,SDK
  // 侧也已按 id 去重丢弃(sdk.js handleIncomingRaw 第 188-191 行:未知 id 静默 return),所以这里
  // 不复用 finishLog(它会误算耗时/误配对),单独记一条 late 日志供控制台展示。
  function sendLateOk(id, method, data) {
    callListeners(logListeners, {
      id: id,
      direction: 'host-to-app',
      method: method,
      result: data,
      timestamp: Date.now(),
      durationMs: undefined,
      late: true,
    });
    sendToApp({ id: id, type: 'response', ok: true, data: data });
  }

  function handleIncomingFromApp(raw) {
    var msg = raw;
    if (typeof raw === 'string') {
      try { msg = JSON.parse(raw); } catch (e) { return; } // 畸形消息忽略,不崩桥
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'request') return; // 本引擎只处理入站 request;响应由本引擎自己产生并直接 sendToApp
    if (typeof msg.id !== 'string' || !msg.id) return; // 缺 id 静默丢弃(与真实宿主桥一致)
    if (typeof msg.method !== 'string' || !msg.method) {
      respondErr(msg.id, 'INTERNAL', 'malformed request envelope: missing method');
      return;
    }
    dispatch(msg.id, msg.method, msg.params);
  }

  // ==================================================================
  // 桥方法:sys.ping
  // ==================================================================

  function handleSysPing(id) {
    scheduleTimeout(function () {
      connected = true;
      emitState();
      respondOk(id, { pong: true, platform: 'mock' });
    }, 0);
  }

  // ==================================================================
  // 桥方法:sys.reportSdkVersionDrift(读取端)
  //
  // 平行实现 宿主桥 registerSandboxDataMethods 里的同名方法:dev 引擎跑的是
  // ../versions/v1/sdk.js 原样字节(见文件头"定位"段),没有 shim 烧录
  // __PARANOVELL_SDK_BUILT_AGAINST,正常 dev 场景下 sdk.js 自己不会发出这条上报
  // (checkSDKVersionDrift 在两者一致/未烧录时提前 return)——这里挂上是为了让
  // dev.html 日志面板下的 parity 护栏(桥方法名集合与本 switch 的 case 集合
  // 必须一致)不因新增桥方法而漏同步,以及万一有人手动在控制台设置
  // window.__PARANOVELL_SDK_BUILT_AGAINST 触发上报时,dev 环境也有确定行为
  // (回 ok,console.warn 落一条,不静默丢)。
  // ==================================================================

  function handleSysReportSdkVersionDrift(id, params) {
    var p = (params && typeof params === 'object') ? params : {};
    var builtAgainst = typeof p.builtAgainst === 'string' ? p.builtAgainst : 'unknown';
    var running = typeof p.running === 'string' ? p.running : 'unknown';
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[mock-host] SDK version drift reported: builtAgainst=' + builtAgainst + ' running=' + running);
    }
    scheduleTimeout(function () {
      respondOk(id, { acknowledged: true });
    }, 0);
  }

  // ==================================================================
  // 桥方法:data.pull —— 有真 pendingRound 就下发,否则下发当前确认态。
  // 下线记录:此前干净态(无真 pendingRound)且有审计记录时会下发
  // "影子 pendingRound"触发恢复体检的影子重放,该机制已随体检整体移除(见文件头
  // 下线记录);pull 现在只反映真实回合状态。
  // ==================================================================

  function seedRoundFromPull(round) {
    // 与 宿主桥 的 seedRoundFromPull 同语义:pull 响应带 pendingRound 就把回合
    // 相位预置为 pendingSave{round},使随后的确认 save/rollback 能被放行;否则置 idle。
    roundPhase = (typeof round === 'number' && round > 0) ? { phase: 'pendingSave', round: round } : { phase: 'idle' };
  }

  function handleDataPull(id) {
    scheduleTimeout(function () {
      var store = loadStore(appKey);
      var offered = store.pendingRound
        ? { round: store.pendingRound.round, output: store.pendingRound.output, handler: store.pendingRound.handler }
        : null;

      seedRoundFromPull(offered ? offered.round : undefined);
      emitState();

      // 镜像 宿主桥 data.pull handler——回包带 locale,现取
      // currentLocale(不额外缓存/延迟,mock 引擎没有 宿主桥 那道 5s 出网节流窗口,
      // 这里的 pull 本身就是同步的本地 store 读取,不存在"缓存命中读到陈旧值"的问题)。
      var res = {
        data: deepClone(store.confirmed.data),
        revision: store.confirmed.revision,
        readonly: !!store.readonly,
        locale: currentLocale,
      };
      if (offered) res.pendingRound = offered;
      respondOk(id, res);

      // 镜像真宿主 宿主桥 在 data.pull
      // handler 内自动触发 checkAndRecoverSandboxRound 的行为——见上方 recoveryMode
      // 声明处的完整论证。只在这次 pull 真的报了 pendingRound、且当前是默认的 'auto'
      // 模式时才排期;'manual' 模式下什么也不做,留给 simulateRoundHandback()/
      // simulateRoundDiscard() 手工触发。
      if (offered && recoveryMode === 'auto') {
        scheduleTimeout(function () {
          // 竞态防御(与 handleConfirmSave 的延迟回调同款套路):延迟这段时间里,round
          // 可能已经被 discardRound()/simulateRoundDiscard() 作废,或者 recoveryMode
          // 被切成了 'manual'——重查一遍,任何一项对不上都放弃这次自动 emit,不复活
          // 已经不该存在的回合、也不违背开发者刚切换的手动模式。
          if (recoveryMode !== 'auto') return;
          var store2 = loadStore(appKey);
          if (!store2.pendingRound || store2.pendingRound.round !== offered.round) return;
          api.emit('round.handback', {
            round: offered.round,
            name: store2.pendingRound.handler,
            output: deepClone(store2.pendingRound.output),
          });
        }, recoveryHandbackDelayMs);
      }
    }, 0);
  }

  // ==================================================================
  // 桥方法:data.submit —— 互斥扩窗、纯存档在途占忙、AI 返回三模式派单、
  // submit-timeout 故障(mock 先结算:数据落盘,响应挂起后主动 SUBMIT_FAILED)
  // ==================================================================

  // 落盘 pendingRound(未确认),回合相位推进到 pendingSave{round}——真实提交路径
  // (echo/fixed/manual 放行/submit-timeout 故障)共用这一步"确认开轮"的落地。
  function finalizeSuccess(round, handlerName, input, outputFormat, outputNotes, output) {
    var store = loadStore(appKey);
    store.pendingRound = {
      round: round,
      output: output,
      handler: handlerName,
      input: input,
      outputFormat: outputFormat,
      outputNotes: outputNotes,
      startedAt: Date.now(),
    };
    saveStore(appKey, store);
    roundPhase = { phase: 'pendingSave', round: round };
    emitState();
    return { round: round, output: output };
  }

  function handleDataSubmit(id, params) {
    if (pureSaveInFlight) {
      respondErr(id, 'SUBMIT_IN_FLIGHT', 'a pure archive save is in flight');
      return;
    }
    if (roundPhase.phase !== 'idle') {
      respondErr(id, 'SUBMIT_IN_FLIGHT', 'a round is already in flight');
      return;
    }

    var model = params && params.model;
    if (!model || typeof model.handler !== 'string' || !model.handler) {
      respondErr(id, 'INTERNAL', 'malformed data.submit params: model.handler required');
      return;
    }

    var store = loadStore(appKey);
    var handlerName = model.handler;
    var input = model.input;
    var outputFormat = model.outputFormat;
    var outputNotes = model.outputNotes;
    // round 不再从 confirmed.revision 派生——独立自增序号
    // (roundSeq),与 revision 两条轴分叉(纯存档只推 revision、discardRound 不回退
    // roundSeq),真实还原真实后端下"round≠revision"的场景。
    store.roundSeq = (store.roundSeq || 0) + 1;
    var round = store.roundSeq;
    registerHandlerFormat(store, handlerName, outputFormat, outputNotes); // 自动登记 + 记录本轮 lastFormat/lastNotes
    var dispatchCfg = resolveHandlerConfig(store, handlerName);
    var faultTimeout = consumeFault(store, 'submit-timeout');
    saveStore(appKey, store); // 持久化故障消费 + handler 登记/lastFormat(命中与否都要落盘,保证"仅一次"跨请求生效)

    roundPhase = { phase: 'submitting' };
    readyPeriodOver = true;
    emitState();

    if (faultTimeout) {
      // "AI 一直不回"语义 = mock 先结算(后端数据已落盘)、响应挂起 timeoutMs 后主动
      // 回 SUBMIT_FAILED(真实链路里宿主转发超时经真桥统一包装为
      // SUBMIT_FAILED,从不产出 TIMEOUT——TIMEOUT 专属 SDK 本地计时器场景,与这里的
      // "mock 主动结算"是两回事);迟到的真实成功响应随后单独发出,SDK 侧按 id 去重丢弃。
      var output2 = resolveOutput(dispatchCfg, input);
      finalizeSuccess(round, handlerName, input, outputFormat, outputNotes, output2);
      scheduleTimeout(function () {
        respondErr(id, 'SUBMIT_FAILED', 'submit timed out (mock settles proactively, mirrors host-first-timeout principle)');
        scheduleTimeout(function () {
          sendLateOk(id, 'data.submit', { round: round, output: output2 });
        }, 1);
      }, faultTimeout.timeoutMs || DEFAULT_SUBMIT_TIMEOUT_MS);
      return;
    }

    if (dispatchCfg.mode === 'manual') {
      // manual:输出未知,暂不落盘 pendingRound——respond()/rejectRequest() 才决定结局。
      manualQueue[id] = {
        id: id,
        handler: handlerName,
        input: input,
        outputFormat: outputFormat,
        outputNotes: outputNotes,
        round: round,
        receivedAt: Date.now(),
      };
      emitPending();
      return;
    }

    var delay = (dispatchCfg.mode === 'fixed' && typeof dispatchCfg.delayMs === 'number') ? dispatchCfg.delayMs : 0;
    scheduleTimeout(function () {
      var output = resolveOutput(dispatchCfg, input);
      var result = finalizeSuccess(round, handlerName, input, outputFormat, outputNotes, output);
      respondOk(id, result);
    }, delay);
  }

  // ==================================================================
  // 桥方法:data.save —— 带 round = 确认该轮;不带 round = 纯存档
  // (节流镜像 3s + 在途占忙 + save-fail/conflict/rate-limit 故障)
  // ==================================================================

  function handleConfirmSave(id, round, changes) {
    var store = loadStore(appKey);
    var isReal = roundPhase.phase === 'pendingSave' && roundPhase.round === round
      && store.pendingRound && store.pendingRound.round === round;

    if (!isReal) {
      // 无 seed / round 不匹配一律本地拒绝,与 宿主桥 SAVE_METHOD 分支同语义。
      respondErr(id, 'SUBMIT_FAILED', 'no matching in-flight round to confirm');
      return;
    }

    // 故障标记在请求受理(dispatch,此刻同步执行)时消费并落盘,
    // 随闭包带入延迟回调——不在回调里重查 store(避免追溯命中已在途的请求)。
    var consumedFault = consumeFirstOf(store, ['save-fail', 'conflict']);
    saveStore(appKey, store); // 落盘故障消费(命中与否都要落盘,保证"仅一次"跨请求生效)

    scheduleTimeout(function () {
      var store2 = loadStore(appKey);

      // 竞态防御(E 组测试发现):确认在途期间 pendingRound 可能已被 discardRound 作废——
      // 延迟回调必须重查,已消失则拒绝,绝不复活已丢弃的回合。(这条重查是 pendingRound
      // 存在性检查,不是故障重查——两者是两回事,这只针对故障消费时机。)
      if (!store2.pendingRound || store2.pendingRound.round !== round) {
        roundPhase = { phase: 'idle' };
        emitState();
        respondErr(id, 'SUBMIT_FAILED', 'round was discarded while confirm was in flight');
        return;
      }

      if (consumedFault && consumedFault.kind === 'save-fail') {
        // 失败但非冲突:回合保持在途(stuck),pendingRound/相位均不动——
        // 真相以下次 ready() 的回滚为准(取消重放,与 sdk.js performRoundConfirmSave 同语义)。
        respondErr(id, 'SUBMIT_FAILED', 'simulated round-confirm save failure');
        return;
      }
      if (consumedFault && consumedFault.kind === 'conflict') {
        // 冲突:后端胜、全量替换(mock 无第二写入者,直接回当前确认态)——
        // 回合状态收敛回 idle,pendingRound 作废(该轮从未真正应用)。
        store2.pendingRound = null;
        saveStore(appKey, store2);
        roundPhase = { phase: 'idle' };
        emitState();
        respondErr(id, 'DATA_CONFLICT', 'simulated data conflict', {
          data: deepClone(store2.confirmed.data),
          revision: store2.confirmed.revision,
        });
        return;
      }

      // append 目标合法性必须在真正写入前校验,失败整体拒绝、
      // 不部分应用(与 isValidOpList 的格式校验同一层级,只是这一层需要当前确认态才能
      // 判断,不能在 dispatch 时提前做——store 可能在 dispatch 之后、这个延迟回调之前
      // 被别的请求改写)。
      if (!isValidAppendTargets(store2.confirmed.data, changes)) {
        roundPhase = { phase: 'idle' };
        emitState();
        respondErr(id, 'INTERNAL', 'malformed data.save changes: append target holds a non-array value');
        return;
      }

      // 正常确认:合并 changes、清 pendingRound。
      // revision 不再赋值成 round(两条轴已分叉,round 可能落后于
      // 纯存档推进过的 revision)——与纯存档同款,每次确认写入都是 revision+1。
      var prevRevision = store2.confirmed.revision;
      applyChangesToConfirmed(store2, changes);
      store2.confirmed.revision = prevRevision + 1;
      store2.pendingRound = null;
      saveStore(appKey, store2);
      roundPhase = { phase: 'idle' };
      emitState();
      respondOk(id, { revision: store2.confirmed.revision });
    }, 0);
  }

  function handleDataSave(id, params) {
    var round = (params && typeof params.round === 'number') ? params.round : undefined;
    // 纯存档锚点 = revision 乐观锁;未携带 anchor
    // (如手工绕过 SDK 直发的裸协议消息)视为不做锚点校验,保持宽松兼容。
    var anchor = (params && typeof params.anchor === 'number') ? params.anchor : undefined;
    var rawChanges = (params && params.changes !== undefined) ? params.changes : [];

    // op 词汇表由 SDK 收口,超出 set/remove/append 三种的整体拒绝,不部分应用——
    // 校验先于任何分支(round 确认 / 纯存档)、先于任何 store 读写,同步本地拒绝不出网延迟。
    if (!isValidOpList(rawChanges)) {
      respondErr(id, 'INTERNAL', 'malformed data.save changes: each entry must be { op: "set"|"remove"|"append", key, value? }');
      return;
    }
    var changes = rawChanges;

    if (round !== undefined) {
      handleConfirmSave(id, round, changes);
      return;
    }

    // 纯存档(不带 round):在途回合内一律拒绝,否则走节流镜像 + 故障注入。
    if (roundPhase.phase !== 'idle') {
      respondErr(id, 'SUBMIT_IN_FLIGHT', 'a round is in flight, pure archive save is rejected');
      return;
    }
    var now = Date.now();
    if (lastPureSaveAt !== null && now - lastPureSaveAt < PURE_SAVE_THROTTLE_MS) {
      var retryAfter = Math.ceil((PURE_SAVE_THROTTLE_MS - (now - lastPureSaveAt)) / 1000);
      respondErr(id, 'RATE_LIMITED', 'pure archive save throttled (mirrors SDK 3s merge window)', { retryAfter: retryAfter });
      return;
    }

    lastPureSaveAt = now;
    pureSaveInFlight = true; // 同步置位:制造一个可被并发 data.submit 观察到的"在途"窗口
    emitState();

    // 故障标记在请求受理(dispatch,此刻同步执行)时消费并落盘,
    // 随闭包带入延迟回调——不在回调里重查 store。
    var pureStore = loadStore(appKey);
    var pureFault = consumeFirstOf(pureStore, ['save-fail', 'conflict', 'rate-limit']);
    saveStore(appKey, pureStore); // 落盘故障消费(命中与否都要落盘,保证"仅一次"跨请求生效)

    scheduleTimeout(function () {
      var store = loadStore(appKey);
      pureSaveInFlight = false;

      if (pureFault) {
        emitState();
        if (pureFault.kind === 'save-fail') {
          respondErr(id, 'SUBMIT_FAILED', 'simulated pure archive save failure');
          return;
        }
        if (pureFault.kind === 'conflict') {
          respondErr(id, 'DATA_CONFLICT', 'simulated data conflict', {
            data: deepClone(store.confirmed.data),
            revision: store.confirmed.revision,
          });
          return;
        }
        // rate-limit
        respondErr(id, 'RATE_LIMITED', 'simulated rate limit', {
          retryAfter: pureFault.opts.retryAfter || DEFAULT_RATE_LIMIT_RETRY_S,
        });
        return;
      }

      // anchor 与当前确认态 revision 不匹配 → 409 DATA_CONFLICT + 当前确认态全量
      // (与回合确认冲突走同一套机制,SDK 侧收到后全量替换内存、清 buffer)。
      if (anchor !== undefined && anchor !== store.confirmed.revision) {
        emitState();
        respondErr(id, 'DATA_CONFLICT', 'stale anchor: pure archive save anchor does not match current revision', {
          data: deepClone(store.confirmed.data),
          revision: store.confirmed.revision,
        });
        return;
      }

      // 空 changes 是真正的空写——不应用、不推进 revision,否则
      // 会无意义地作废其它并发方持有的旧 anchor。anchor 校验(上面)仍然照做:调用方
      // 可能只是想确认锚点仍然有效。
      if (changes.length > 0) {
        // append 目标合法性必须在真正写入前校验,失败整体拒绝、
        // 不部分应用、不推进 revision(与回合确认路径同款,见 handleConfirmSave)。
        if (!isValidAppendTargets(store.confirmed.data, changes)) {
          emitState();
          respondErr(id, 'INTERNAL', 'malformed data.save changes: append target holds a non-array value');
          return;
        }
        // 纯存档不开轮、不发号(confirmed_round 不动),但 anchor 匹配即按序应用 changes
        // 并 revision+1(纯存档与回合确认都推进 revision,只是纯存档不产生新的
        // 已确认轮次)。
        applyChangesToConfirmed(store, changes);
        store.confirmed.revision = store.confirmed.revision + 1;
        saveStore(appKey, store);
      }
      emitState();
      respondOk(id, { revision: store.confirmed.revision });
    }, 0);
  }

  // ==================================================================
  // 桥方法:data.rollback —— 崩溃恢复(取代原"仅 ready 期"
  // 限制):放行条件改为"roundPhase 确实处于 pendingSave 且 round 匹配 + 真 pendingRound
  // 同一 round",不再要求"未真实 submit 过"——与 宿主桥 ROLLBACK_METHOD 同步收紧
  // 改宽,理由见 宿主桥 该守卫的文档(放宽不引入新攻击面,因为 roundPhase 只能由
  // 本文件受控赋值,不是应用能伪造的状态)。
  // ==================================================================

  function handleDataRollback(id, params) {
    var round = (params && typeof params.round === 'number') ? params.round : undefined;
    var store = loadStore(appKey);
    var pendingMatches = roundPhase.phase === 'pendingSave' && round !== undefined && roundPhase.round === round
      && store.pendingRound && store.pendingRound.round === round;

    if (!pendingMatches) {
      // 无 seed / round 不匹配一律本地拒绝,与 宿主桥 ROLLBACK_METHOD 同语义。
      respondErr(id, 'SUBMIT_FAILED', 'data.rollback rejected: no matching pending round');
      return;
    }

    scheduleTimeout(function () {
      var store2 = loadStore(appKey);
      // 废弃该 pending 数据轮,数据回到上个确认态。
      store2.pendingRound = null;
      saveStore(appKey, store2);
      roundPhase = { phase: 'idle' };
      emitState();
      respondOk(id, { data: deepClone(store2.confirmed.data), revision: store2.confirmed.revision });
    }, 0);
  }

  // ==================================================================
  // 桥方法:ui.present / ui.setCanvas —— 独立平行实现,语义基准为
  // 真实宿主桥的 ui 方法注册(不复用其源码,见文件头注释)。dev mock 没有真实 viewport/shell,不做端能力/画布
  // 可用性裁决,只做与真桥同款的白名单/取值域校验 + 如实应用 + 下发
  // ui.presentationChange 事件,足够联调协议层("请求非法 form/画布 → INVALID_PARAM"
  // "present 成功 → 恰好一次事件"这类契约行为)。
  // ==================================================================

  var UI_FORM_WHITELIST = ['split', 'float', 'full', 'mfull', 'mland', 'mdrawer'];
  var UI_CANVAS_KEYS = ['portrait', 'landscape', 'compact'];
  var UI_CANVAS_RATIO_MIN = 0.05;
  var UI_CANVAS_RATIO_MAX = 20;
  var UI_CANVAS_BLEED_MIN = 1;
  var UI_CANVAS_BLEED_MAX = 3;

  function parseUiCanvasRatio(safe) {
    if (typeof safe !== 'string') return null;
    var match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(safe.trim());
    if (!match) return null;
    var w = Number(match[1]);
    var h = Number(match[2]);
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
    var ratio = w / h;
    return isFinite(ratio) && ratio > 0 ? ratio : null;
  }

  function isValidUiBleedComponent(value) {
    return typeof value === 'number' && isFinite(value) && value >= UI_CANVAS_BLEED_MIN && value <= UI_CANVAS_BLEED_MAX;
  }

  function isValidUiCanvasSpec(value) {
    if (!value || typeof value !== 'object') return false;
    var ratio = parseUiCanvasRatio(value.safe);
    if (ratio === null || ratio < UI_CANVAS_RATIO_MIN || ratio > UI_CANVAS_RATIO_MAX) return false;
    if (value.bleed !== undefined) {
      if (!value.bleed || typeof value.bleed !== 'object') return false;
      if (!isValidUiBleedComponent(value.bleed.w) || !isValidUiBleedComponent(value.bleed.h)) return false;
    }
    return true;
  }

  // 校验整个 CanvasSet:未知 key 忽略、空 set 视为未声明(返回空对象,不是 null);
  // 任一已声明 key 非法 → 整体返回 null(INVALID_PARAM),不部分应用,不污染既有画布集。
  function validateUiCanvasSet(params) {
    if (!params || typeof params !== 'object') return null;
    var result = {};
    for (var key in params) {
      if (!hasOwn(params, key)) continue;
      if (UI_CANVAS_KEYS.indexOf(key) === -1) continue; // 未知 key 忽略
      var spec = params[key];
      if (!isValidUiCanvasSpec(spec)) return null;
      result[key] = spec;
    }
    return result;
  }

  function handleUiPresent(id, params) {
    var form = params && params.form;
    if (typeof form !== 'string' || UI_FORM_WHITELIST.indexOf(form) === -1) {
      // 非法 form key ≠ 平台不支持:这里是白名单错误,INVALID_PARAM,不触发形态变更。
      respondErr(id, 'INVALID_PARAM', 'unsupported form: ' + String(form));
      return;
    }
    scheduleTimeout(function () {
      // dev mock 简化裁决:没有真实端能力判断,如实应用(dev 场景足够联调协议层)。
      uiPresentation.form = form;
      var result = { applied: form, degraded: false };
      respondOk(id, result);
      // present() 无论是否降级都恰好下发一次 presentationChange。
      api.emit('ui.presentationChange', {
        form: form,
        requested: form,
        degraded: false,
        reason: undefined,
        canvas: uiPresentation.canvas,
        scale: uiPresentation.scale,
      });
    }, 0);
  }

  function handleUiSetCanvas(id, params) {
    var validated = validateUiCanvasSet(params);
    if (validated === null) {
      respondErr(id, 'INVALID_PARAM', 'invalid canvas set: ratio/bleed out of range or malformed');
      return;
    }
    scheduleTimeout(function () {
      var declaredKeys = [];
      for (var key in validated) {
        if (hasOwn(validated, key)) declaredKeys.push(key);
      }
      // dev mock 简化:取第一个已声明的画布 key 视为"生效画布"(没有真实 resolveCanvas
      // 裁决),供协议层联调 getPresentation().canvas 是否随 setCanvas 同步。
      respondOk(id, undefined);
      if (declaredKeys.length > 0) {
        uiPresentation.canvas = declaredKeys[0];
        // dev mock 把"画布集被接受"一律视为一次呈现变化(没有真实 resolveCanvas 去判断
        // 是否真的影响当前裁决),下发一次 ui.presentationChange,供联调
        // getPresentation() 随 setCanvas 同步(B-9)。
        api.emit('ui.presentationChange', {
          form: uiPresentation.form,
          requested: uiPresentation.form,
          degraded: false,
          reason: undefined,
          canvas: uiPresentation.canvas,
          scale: uiPresentation.scale,
        });
      }
    }, 0);
  }

  function handleUiPointerEnter(id) {
    // 主路径:dev mock 没有真实悬停状态机(那是宿主组件层的职责),
    // 只如实响应即可,足够联调协议层("SDK 上报 pointer-enter → 桥能收到并回 ok")。
    scheduleTimeout(function () {
      respondOk(id, undefined);
    }, 0);
  }

  function handleUiViewportGesture(id) {
    // 双指缩放上报:dev mock 不做真实缩放(那是宿主组件层的事),只如实
    // 回 ok —— 与 handleUiFocusRect / handleUiPointerEnter 同一先例,够联调协议层。
    scheduleTimeout(function () {
      respondOk(id, undefined);
    }, 0);
  }

  function handleUiFocusRect(id) {
    // dev mock 没有真实的冻结几何/
    // 心跳状态机(那是宿主组件层的职责),只如实响应即可,足够联调
    // 协议层("SDK 上报 focusRect → 桥能收到并回 ok",与 handleUiPointerEnter 同一先例)。
    scheduleTimeout(function () {
      respondOk(id, undefined);
    }, 0);
  }

  // ==================================================================
  // 桥方法:plan.list / plan.create / plan.restart
  //
  // 独立平行实现(语义基准同 ui.* 一段:只读源码,不复用宿主实现,见文件头"语义
  // 基准"段落)。dev mock 站在"桥已经放行、正在打真实后端"这一步,直接产出 SDK 期望
  // 的最终 BridgeError 码(PLAN_IN_PROGRESS / PLAN_NOT_DISCARD / PLAN_NOT_FOUND,
  // 错误码映射终点),不模拟中间的 409/404 HTTP 语义与服务端限速——那些是真实
  // 后端链路的职责,dev 场景不需要,足够联调协议层与状态机就够了。
  //
  // 授权框同样不在这一层模拟——那是宿主组件层(宿主桥与面板)的
  // 职责,与 mock-host.js 协议引擎无关(sdk.js 对确认框全程不可见,详见 sdk.js 文件头
  // "plan.* API" 段)。
  //
  // 单 processing 不变量(create/restart 共用准入判据):同一 appKey 下
  // 同时只能有一条 status='processing' 的 plan。判据顺序对 restart 有讲究——必须先判
  // 目标是否存在/是否 discard,再查全局是否已有另一条 processing 记录:若倒过来,
  // "对一条自身已是 processing 的记录发起 restart"会被误判成"撞见别的 processing
  // 记录"(报 PLAN_IN_PROGRESS 指向它自己),但正确语义应该是 PLAN_NOT_DISCARD(这条
  // 记录本就不是 discard 状态,压根不该被 restart)。create 没有"目标"概念,判据只有
  // 全局 processing 检查一步。
  // ==================================================================

  function findProcessingPlan(store) {
    for (var i = 0; i < store.plans.length; i++) {
      if (store.plans[i].status === 'processing') return store.plans[i];
    }
    return null;
  }

  function findPlanById(store, planId) {
    for (var i = 0; i < store.plans.length; i++) {
      if (store.plans[i].id === planId) return store.plans[i];
    }
    return null;
  }

  // create()/restart() 的返回值不含 content(见 ParanovellPlanRef)——调用方
  // 刚发上去的内容不原样回吐,只有 list() 才带 content 全文快照。
  function planRefOf(plan) {
    return { id: plan.id, title: plan.title, status: plan.status, createdAt: plan.createdAt };
  }

  function handlePlanList(id) {
    scheduleTimeout(function () {
      var store = loadStore(appKey);
      // createdAt 降序;list() 现算现排,不依赖数组本身的存储顺序。
      var items = store.plans.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
      respondOk(id, deepClone(items));
    }, 0);
  }

  function handlePlanCreate(id, params) {
    var p = (params && typeof params === 'object') ? params : {};
    if (typeof p.title !== 'string' || !p.title || typeof p.content !== 'string' || !p.content) {
      respondErr(id, 'INTERNAL', 'malformed plan.create params: title/content required');
      return;
    }
    scheduleTimeout(function () {
      var store = loadStore(appKey);
      var conflict = findProcessingPlan(store);
      if (conflict) {
        respondErr(id, 'PLAN_IN_PROGRESS', 'a plan is already in progress', { planId: conflict.id, status: conflict.status });
        return;
      }
      store.planSeq = (store.planSeq || 0) + 1;
      var plan = {
        id: 'mock-plan-' + store.planSeq,
        title: p.title,
        content: p.content,
        status: 'processing',
        createdAt: Math.floor(Date.now() / 1000), // unix 秒(见 ParanovellPlanItem.createdAt)
      };
      store.plans.push(plan);
      saveStore(appKey, store);
      respondOk(id, planRefOf(plan));
    }, 0);
  }

  function handlePlanRestart(id, params) {
    var p = (params && typeof params === 'object') ? params : {};
    if (typeof p.planId !== 'string' || !p.planId) {
      respondErr(id, 'INTERNAL', 'malformed plan.restart params: planId required');
      return;
    }
    scheduleTimeout(function () {
      var store = loadStore(appKey);
      var target = findPlanById(store, p.planId);
      if (!target) {
        respondErr(id, 'PLAN_NOT_FOUND', 'plan not found');
        return;
      }
      if (target.status !== 'discard') {
        respondErr(id, 'PLAN_NOT_DISCARD', 'target plan is not discard', { planId: target.id, status: target.status });
        return;
      }
      // target 已确认是 discard,不可能就是下面查到的 processing 记录本身——这里排查的
      // 是"另有一条别的 plan 正在 processing"(见函数组注释的判据顺序说明)。
      var conflict = findProcessingPlan(store);
      if (conflict) {
        respondErr(id, 'PLAN_IN_PROGRESS', 'a plan is already in progress', { planId: conflict.id, status: conflict.status });
        return;
      }
      target.status = 'processing';
      target.createdAt = Math.floor(Date.now() / 1000); // restart 会把 createdAt 刷成当前时间(见 ParanovellPlanItem)
      saveStore(appKey, store);
      respondOk(id, planRefOf(target));
    }, 0);
  }

  // ==================================================================
  // 对外接口装配(window.ParanovellMockHost)
  //
  // 形状对齐说明:本文件与 paranovell-dev.d.ts 最初并行编写,
  // 落地后曾有若干字段出入——本文件当时按"并集" payload 实现(attach() 返回值/appKey
  // 入参、onState 的 connected/pendingRound/handlers/faults、onPending 元素的
  // receivedAt、ping()/setAppKey() 两个补充 API)。这些字段已逐条同步进
  // paranovell-dev.d.ts(声明追实现的方向,本文件的超集是定稿形状),两份文件现已一致,
  // 不再有已知差异。以下列的是本文件对错误码/事件订阅方式的设计取舍,供后续维护参考:
  //   - onLog/onPending/onState 是 attach 返回对象上的订阅方法(不是
  //     `.on('log', fn)` 泛型总线)。
  //   - 错误码只用 d.ts 声明的 7 种(ParanovellBridgeErrorCode);未知方法回 INTERNAL,
  //     不额外发明 METHOD_NOT_FOUND(sdk.js 实际只会发出 5 种已实现方法,属防御分支)。
  // ==================================================================

  var api = {};

  api.attach = function (transport) {
    transport = transport || {};
    if (typeof transport.postToApp !== 'function') {
      throw new TypeError('ParanovellMockHost.attach: transport.postToApp must be a function');
    }
    if (typeof transport.onFromApp !== 'function') {
      throw new TypeError('ParanovellMockHost.attach: transport.onFromApp must be a function');
    }
    if (typeof transport.requestReload !== 'function') {
      throw new TypeError('ParanovellMockHost.attach: transport.requestReload must be a function');
    }

    epoch += 1; // 全新挂载一个引擎实例,晚于此刻结算的旧世代定时器一律作废

    appKey = normalizeAppKey(transport.appKey);
    postToAppFn = transport.postToApp;
    requestReloadFn = transport.requestReload;

    resetTransientState();
    // attach() = 挂载一个全新引擎实例(区别于 crash()):事件订阅一并清空,
    // 供 dev.html/测试重新订阅——与"重建 SDK+mock-host"的测试方法论对齐。
    logListeners = [];
    pendingListeners = [];
    stateListeners = [];

    transport.onFromApp(handleIncomingFromApp);

    return api;
  };

  api.setAppKey = function (key) {
    appKey = normalizeAppKey(key);
    resetTransientState();
    emitState();
    emitPending();
  };

  api.onLog = function (fn) { return subscribe(logListeners, fn); };
  api.onPending = function (fn) { return subscribe(pendingListeners, fn); };
  api.onState = function (fn) { return subscribe(stateListeners, fn); };

  // 两方法返回命中布尔(true=确实命中一条挂起请求并已处理,
  // false=id 已不在队列——已被响应/拒绝过或从未存在);dev.html 据此决定成功 toast
  // 还是"该请求已不存在"提示。
  api.respond = function (id, json) {
    var entry = manualQueue[id];
    if (!entry) return false;
    delete manualQueue[id];
    emitPending();
    var result = finalizeSuccess(entry.round, entry.handler, entry.input, entry.outputFormat, entry.outputNotes, json);
    respondOk(id, result);
    return true;
  };

  api.rejectRequest = function (id) {
    var entry = manualQueue[id];
    if (!entry) return false;
    delete manualQueue[id];
    emitPending();
    roundPhase = { phase: 'idle' };
    emitState();
    respondErr(id, 'SUBMIT_FAILED', 'submit rejected via mock host manual queue');
    return true;
  };

  api.setMockMode = function (handlerName, mode, options) {
    if (typeof handlerName !== 'string' || !handlerName) return;
    options = options || {};
    var store = loadStore(appKey);
    store.handlers = store.handlers || {};
    // 切模式(尤其是 echo→fixed,dev.html「填入格式示例」按钮的典型触发路径)
    // 不该丢失该 handler 已由 data.submit 记录的 lastFormat——下面整体替换配置对象前
    // 先取出来,fixed/manual 落地后再原样带回;echo 分支维持原语义(不占配置项,连
    // lastFormat 一并让位给下一次 data.submit 重新登记)。lastNotes 与 lastFormat
    // 同生命周期,同样需要在切模式时保留。
    var prevLastFormat = (store.handlers[handlerName] && hasOwn(store.handlers[handlerName], 'lastFormat'))
      ? store.handlers[handlerName].lastFormat
      : undefined;
    var prevLastNotes = (store.handlers[handlerName] && hasOwn(store.handlers[handlerName], 'lastNotes'))
      ? store.handlers[handlerName].lastNotes
      : undefined;
    if (mode === 'fixed') {
      store.handlers[handlerName] = {
        mode: 'fixed',
        fixedJson: options.json !== undefined ? options.json : {},
        delayMs: typeof options.delayMs === 'number' ? options.delayMs : 0,
      };
      if (prevLastFormat !== undefined) store.handlers[handlerName].lastFormat = prevLastFormat;
      if (prevLastNotes !== undefined) store.handlers[handlerName].lastNotes = prevLastNotes;
    } else if (mode === 'manual') {
      store.handlers[handlerName] = { mode: 'manual' };
      if (prevLastFormat !== undefined) store.handlers[handlerName].lastFormat = prevLastFormat;
      if (prevLastNotes !== undefined) store.handlers[handlerName].lastNotes = prevLastNotes;
    } else {
      delete store.handlers[handlerName]; // echo(默认):不占配置项
    }
    saveStore(appKey, store);
    emitState();
  };

  api.setFault = function (kind, options) {
    options = options || {};
    var store = loadStore(appKey);
    store.faults = store.faults || defaultFaults();
    if (options.enabled === false) {
      store.faults[kind] = disabledFaultEntry(kind, store.faults[kind]);
    } else {
      var once = options.once !== false; // 默认「仅一次」
      var entry = { enabled: true, once: once };
      if (kind === 'rate-limit') {
        entry.retryAfter = typeof options.retryAfter === 'number' ? options.retryAfter : DEFAULT_RATE_LIMIT_RETRY_S;
      }
      if (kind === 'submit-timeout') {
        entry.timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_SUBMIT_TIMEOUT_MS;
      }
      store.faults[kind] = entry;
    }
    saveStore(appKey, store);
    emitState();
  };

  api.setReadonly = function (readonly) {
    // 真桥不在 data.submit/data.save 处专门拒绝 READONLY——readonly 完全是 SDK
    // 本地字段(pull 响应回填 state.readonly 后,submit()/save() 在 SDK 内同步拒绝、
    // 请求根本不出网),这里只需如实在下次 data.pull 里回填即可,协议里"submit/save
    // 拒绝语义与真桥一致"因此天然成立,不需要在桥方法里再加一层拒绝逻辑
    // (sdk.test.ts 第 189-190 行印证:READONLY 由 sdk.js 自身抛出)。
    var store = loadStore(appKey);
    store.readonly = !!readonly;
    saveStore(appKey, store);
    emitState();
  };

  // 调试台语言开关——dev.html 的语言切换按钮调这个方法。
  // 语义镜像真宿主(真实宿主桥):
  //   - 白名单:非 'zh'/'en' 静默忽略,不抛错(与真桥/SDK 同策略,不信任外部值)。
  //   - 只在确有变化时才广播 sys.languageChange(与 ui.presentationChange 的
  //     "只在确有变化时发" 同款,避免应用侧订阅者收到空变化的噪音事件)。
  //   - 落 currentLocale 后先 emitState() 让状态面板读到新值,再 api.emit() 广播给
  //     被装载的应用——与 setMockMode/setFault 等既有方法"先落盘再广播"同一时序。
  api.setLocale = function (locale) {
    if (locale !== 'zh' && locale !== 'en') return;
    if (locale === currentLocale) return;
    currentLocale = locale;
    emitState();
    api.emit('sys.languageChange', { locale: currentLocale });
  };

  api.getLocale = function () {
    return currentLocale;
  };

  // 崩溃恢复自动交还:见 recoveryMode 声明处的
  // 完整论证——默认 'auto',data.pull 见到 pendingRound 后延迟(默认
  // recoveryHandbackDelayMs = 1500ms)自动 emit round.handback,镜像真实宿主
  // 宿主桥 在 data.pull handler 内自动触发 checkAndRecoverSandboxRound 的行为。
  // 传 'manual' 关掉自动 emit,回到"只能手工调 simulateRoundHandback()/
  // simulateRoundDiscard() 演练"的旧行为,用于需要精确控制交还时机的故障演练场景。
  // options.delayMs 可选,覆盖默认延迟(仅在 mode === 'auto' 时有意义)。
  api.setRecoveryMode = function (mode, options) {
    if (mode !== 'auto' && mode !== 'manual') {
      throw new TypeError('[mock-host] setRecoveryMode: mode must be "auto" or "manual"');
    }
    recoveryMode = mode;
    if (options && typeof options.delayMs === 'number' && options.delayMs >= 0) {
      recoveryHandbackDelayMs = options.delayMs;
    }
    emitState();
  };

  api.getRecoveryMode = function () {
    return recoveryMode;
  };

  // store 级手动接管总开关。开启时 resolveHandlerConfig 对 data.submit 一律派
  // manual(见上方注释),不改写任何 store.handlers[name] 配置;关闭后各 handler 恢复
  // 原配置。持久化 + 广播时序对齐 setMockMode/setFault(先落盘再 emitState)。
  api.setManualTakeover = function (enabled) {
    var store = loadStore(appKey);
    store.manualTakeover = !!enabled;
    saveStore(appKey, store);
    emitState();
  };

  api.crash = function () {
    // 模拟"应用被杀并重开":引擎瞬态清空(与全新 attach() 等价的相位复位),
    // localStorage 不动;事件订阅保留(dev.html 自己没有崩溃,不该失去监听)。
    epoch += 1; // 晚于此刻结算的旧世代定时器一律作废
    resetTransientState();
    emitPending();
    requestReloadFn();
  };

  // 数据页悬停编辑/清空一个字段:绕过回合/存档通道,直接改写已确认态的一个 key。
  api.editData = function (key, value) {
    var store = loadStore(appKey);
    if (value === undefined) delete store.confirmed.data[key];
    else store.confirmed.data[key] = deepClone(value);
    saveStore(appKey, store);
    emitState();
  };

  api.discardRound = function () {
    var store = loadStore(appKey);
    store.pendingRound = null;
    saveStore(appKey, store);
    roundPhase = { phase: 'idle' };
    emitState();
  };

  // ==================================================================
  // 控制台手工触发工具:round.handback /
  // round.discard 两个下行事件在协议层早已跑通(单元测试里直接调
  // host.emit('round.handback', {...}) 验证过),但那两条用例的 payload 是测试代码
  // 自己经 readStore() 读 localStorage 拼出来的——浏览器 devtools 里打开 dev.html
  // 只看得到 window.ParanovellMockHost 这个 api 对象,没有这份内部 store 的访问权,
  // 拼不出同样的 payload。这里补两个便捷方法,直接读引擎自己持有的 store.pendingRound
  // 拼好 payload 再 emit,免得手工翻 localStorage JSON,让"刷新后交还"这条路径不花
  // 一分钱模型调用就能在本地点一遍。
  //
  // 用法(浏览器 devtools console,dev.html 已加载某个用 defineRound 开回合的应用):
  //   1. 在应用里点一次会触发 defineRound sender 的按钮,不必等它 resolve;
  //   2. 调 ParanovellMockHost.crash() 模拟应用被杀重开(localStorage 不动,
  //      pendingRound 仍在)——重开后应用重新走 ready(),这一轮进入"恢复中"、等宿主交还;
  //   3. 默认(recoveryMode = 'auto')到这一步**不需要再手动做任何事**——data.pull
  //      见到 pendingRound 之后,mock-host 会在 recoveryHandbackDelayMs(默认 1500ms)
  //      后自动 emit round.handback。⚠ round.handback
  //      到达后 SDK 的默认动作是**自动重放**该轮已注册的 defineRound handler 并确认
  //      save,不再要求应用注册 onRoundRecovery——应用没接这个回调也会正常恢复。只有
  //      接了 onRoundRecovery 的应用才会改成把决定权交还给应用的回调,由它决定
  //      commit()/discard()。
  //      只有需要精确控制交还时机(比如下面的故障演练)才需要手动接管:先调
  //      ParanovellMockHost.setRecoveryMode('manual') 关掉自动交还,再手工调:
  //   3a. ParanovellMockHost.simulateRoundHandback() 模拟"宿主后台取到 output 并
  //       确认可以交还"——不传参数就原样把当前 pendingRound 交还给应用:没注册
  //       onRoundRecovery 时 SDK 直接自动重放 handler 并确认 save;注册了则改为通知
  //       onRoundRecovery 回调,由应用决定 commit()/discard();
  //   3b. 或调 ParanovellMockHost.simulateRoundDiscard() 模拟"宿主自己判定这一轮不可
  //       恢复并已经完成 rollback"——应用不会收到任何自动重放或
  //       onRoundRecovery 回调,SDK 只是解除本地"恢复中"的卡住状态。
  //   ⚠本节曾经写"crash() 后直接手动调
  //   simulateRoundHandback()"当作默认剧本——这在默认的 'auto' 模式下会撞上竞态:
  //   自动交还已经在 recoveryHandbackDelayMs 之后把 pendingRound 清空并交还给应用,
  //   此时再手动调用只会拿到 "no pendingRound to hand back" 报错。手动路径必须先
  //   `setRecoveryMode('manual')`,否则就等自动交还,不要再手动补一句。
  // ==================================================================

  // simulateRoundHandback([overrides]):把当前 store.pendingRound 原样交还给应用。
  // overrides 允许在控制台手工改写 round/name/output,用于故障演练——比如把 name 改
  // 成一个应用没有 defineRound() 注册过的值,复现该分支"SDK 自主放弃"。
  var hookQueries = {};
  var hookQuerySeq = 0;
  // 本地显式选择命中结果，不模拟模型判断 trigger。与真实宿主共享查询/交还协议。
  api.simulateHook = function (options) {
    options = options || {};
    var queryId = 'mock-hook-' + (++hookQuerySeq);
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        delete hookQueries[queryId];
        api.emit('hook.settled', { queryId: queryId, hit: false });
        resolve(null);
      }, 1500);
      hookQueries[queryId] = function (hook) {
        clearTimeout(timer);
        delete hookQueries[queryId];
        if (!hook || !options.hit || roundPhase.phase !== 'idle' || pureSaveInFlight) {
          api.emit('hook.settled', { queryId: queryId, hit: false });
          resolve({ hit: false, hook: hook });
          return;
        }
        var store = loadStore(appKey);
        store.roundSeq = (store.roundSeq || 0) + 1;
        var round = store.roundSeq;
        registerHandlerFormat(store, hook.name, hook.outputFormat, hook.outputNotes);
        var output = hasOwn(options, 'output') ? options.output : resolveOutput(resolveHandlerConfig(store, hook.name), hook.input);
        saveStore(appKey, store);
        readyPeriodOver = true;
        finalizeSuccess(round, hook.name, hook.input, hook.outputFormat, hook.outputNotes, output);
        api.emit('round.handback', { round: round, name: hook.name, output: output });
        resolve({ hit: true, hook: hook, round: round });
      };
      api.emit('hook.query', { queryId: queryId });
    });
  };

  api.simulateRoundHandback = function (overrides) {
    var store = loadStore(appKey);
    if (!store.pendingRound) {
      throw new Error('[mock-host] simulateRoundHandback: no pendingRound to hand back');
    }
    // 真实宿主只在"这次 pull 是 SDK 自己发出的那一次,
    // 响应即将回传给 SDK"这个前提下才可能交还——SDK 收到响应后的下一个微任务才会把
    // roundInFlight 置真。这里镜像同一前提:roundPhase 必须已经是这个 round 的
    // pendingSave(即 data.pull 已经跑过一轮、把它 seed 好了)。crash() 之后如果应用
    // 的 iframe 还没重新加载完、还没走到 ready()→data.pull,roundPhase 仍是 idle——
    // 此时调用会让事件发给一个还没监听的/还没把 roundInFlight 置真的应用,静默落空
    // (真实宿主不会有这个窗口,它的触发点天然绑在 pull 响应上)。明确报错,不静默卡住。
    if (roundPhase.phase !== 'pendingSave' || roundPhase.round !== store.pendingRound.round) {
      throw new Error(
        '[mock-host] simulateRoundHandback: app has not seeded this round via data.pull yet '
        + '(roundPhase=' + roundPhase.phase + '); wait for the app to call ready() again after crash() '
        + 'before simulating a handback, otherwise the event lands on a listener that is not ready yet',
      );
    }
    var round = (overrides && typeof overrides.round === 'number') ? overrides.round : store.pendingRound.round;
    var name = (overrides && typeof overrides.name === 'string') ? overrides.name : store.pendingRound.handler;
    var output = (overrides && hasOwn(overrides, 'output'))
      ? overrides.output
      : deepClone(store.pendingRound.output);
    api.emit('round.handback', { round: round, name: name, output: output });
  };

  // simulateRoundPending([round]):模拟"刷新 / 换设备回来时这一轮正文还在生成"
  // (SDK 1.9.0)——向应用发一次
  // round.pending,订阅了 onRoundPending 的应用会收到 {pending:true, round}。真实宿主
  // 会周期性重发它作为心跳并挂起 data.pull;这里只发一次,用于在本地看应用的 loading
  // 态。round 缺省取当前 pendingRound,没有则为 1。
  api.simulateRoundPending = function (round) {
    var store = loadStore(appKey);
    var r = typeof round === 'number' ? round : (store.pendingRound ? store.pendingRound.round : 1);
    api.emit('round.pending', { round: r });
  };

  // simulateRoundDiscard():模拟"宿主已经判定这一轮不可恢复并自行完成 rollback"
  // ——真实宿主发这条事件前已经把 pendingRound 回滚掉了,
  // 这里同步做同一件事(不能只发事件不清 pendingRound,否则下一次 data.pull 还会把
  // 同一个 pendingRound 报回去,与真宿主行为不一致)。
  //
  // 与既有 api.discardRound() 的区别:discardRound() 是"控制台强行作废一个卡住的
  // 回合,不通知应用"(语义不能改),这里模拟的是宿主**主动
  // 交还**一个 discard 决定——必须让应用侧 SDK 也收到 round.discard 事件才能解除
  // "恢复中"的状态,否则应用会永远卡在等待交还上。
  api.simulateRoundDiscard = function () {
    var store = loadStore(appKey);
    if (!store.pendingRound) {
      throw new Error('[mock-host] simulateRoundDiscard: no pendingRound to discard');
    }
    var round = store.pendingRound.round;
    store.pendingRound = null;
    saveStore(appKey, store);
    roundPhase = { phase: 'idle' };
    emitState();
    api.emit('round.discard', { round: round });
  };

  api.ping = function () {
    connected = true;
    emitState();
  };

  // 事件下行通道 —— 镜像 宿主桥 的 HostBridge.emit(),直接经
  // postToAppFn 下发 `{id, type:'event', event, payload}`,不经 dispatch()/请求-响应
  // 信封,因此不占频控配额、不参与回合状态机(与真桥语义一致)。id 自增生成,与
  // 宿主桥 的 emit() 同用途——供真 sdk.js 端对"同一条消息同时向 window+document
  // 派发"做去重(dev.html/测试的 attach() 传输同样是双派发,见 sdk.js 对应注释)。
  // eventType 非法(非字符串/空)静默丢弃,不抛错、不影响调用方。
  var nextEventId = 0;
  api.emit = function (eventType, payload) {
    if (typeof eventType !== 'string' || !eventType) return;
    if (typeof postToAppFn !== 'function') return; // 尚未 attach(),无下行通道,静默丢弃
    nextEventId += 1;
    sendToApp({ id: 'mock-evt-' + nextEventId, type: 'event', event: eventType, payload: payload });
  };

  window.ParanovellMockHost = api;
})();
