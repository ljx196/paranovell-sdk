/**
 * paranovell sandbox SDK —— dev 专属类型声明(mock-host.js 对外接口)。
 *
 * module 形态(顶层有 export,非全局 ambient)—— dev-only 字段刻意不并入
 * ../versions/v1/paranovell.d.ts 的全局声明,避免它们泄漏进生产代码的类型视图
 * (那份文件随生产 sdk.js 一起分发,是应用开发者实际会看到的类型面)。
 *
 * 本文件描述的是 ./mock-host.js(协议引擎,无 UI)对 dev.html(控制台 UI)暴露的契约。
 *
 * 形状以 mock-host.js 实际运行时的"并集"payload 为准(见其文件尾"对外接口装配"处的
 * 逐条注释),本文件的方向是"声明追实现"。
 */

/** 单条桥消息的方向:app-to-host = 应用发往宿主,host-to-app = 宿主发往应用。 */
export type ParanovellBridgeDirection = 'app-to-host' | 'host-to-app';

/**
 * attach() 的传输注入回调 —— mock-host.js 零 DOM,不自己碰 iframe/postMessage;
 * dev.html 负责接线实际的收发通道与重载动作,注入进来供协议引擎调用。
 */
export interface ParanovellMockHostTransport {
  /** 向被装载的应用(iframe 内的沙盒)下发一条桥消息文本。 */
  postToApp(text: string): void;
  /** 注册"收到应用上行消息"的回调;收到消息时用消息原始文本调用它。 */
  onFromApp(register: (text: string) => void): void;
  /** 请求重载被装载的应用(crash() 与"重载应用"按钮的落地方式)。 */
  requestReload(): void;
  /**
   * 应用隔离键,规范化后用作 localStorage 键前缀的一部分;省略时退化为
   * 'default'。dev.html 实际用法:attach 时按 ?app 参数算出的短 hash 传入。
   */
  appKey?: string;
}

/**
 * 桥方法全集,与真桥同名。
 * ui.present/ui.setCanvas 是 mock-host.js 独立平行实现的简化版(不做端能力/
 * 画布裁决,只做白名单/取值域校验 + 原样应用),详见 mock-host.js 对应 handler 注释。
 * ui.pointerEnter:B 主路径悬停放大探测上报,dev mock 只如实
 * 响应 ok,不做真实悬停状态机(那是宿主组件层的职责),详见 mock-host.js
 * handleUiPointerEnter 注释。
 * plan.list/plan.create/plan.restart:plan(方案)管理三方法,
 * dev mock 独立平行实现(内存 plan 列表 + 单 processing 不变量),不模拟宿主授权框
 * (那是宿主组件层的职责,与协议引擎无关),详见 mock-host.js 对应 handler 注释。
 */
export type ParanovellBridgeMethod =
  | 'round.hookOffer'
  | 'sys.ping'
  | 'data.pull'
  | 'data.submit'
  | 'data.save'
  | 'data.rollback'
  | 'ui.present'
  | 'ui.setCanvas'
  | 'ui.pointerEnter'
  | 'plan.list'
  | 'plan.create'
  | 'plan.restart';

/**
 * 桥错误码全集,信封结构与真桥一致。
 * 新增 INVALID_PARAM:ui.present 的 form 不在白名单 / ui.setCanvas 的画布集
 * 比例或 bleed 越界时返回。
 * 新增 PLAN_IN_PROGRESS / PLAN_NOT_DISCARD / PLAN_NOT_FOUND:
 * plan.create/plan.restart 命中单 processing 不变量 / 目标非 discard / 目标不存在时
 * 返回,详见 mock-host.js plan.* handler 注释与桥错误码映射。
 *
 * ⚠ **USER_REJECTED 是 dev mock 永远不会发、但生产必然存在的码**:
 * 生产宿主在 plan.create/plan.restart 前会弹授权框,用户点拒绝、或授权框因面板关闭 /
 * 会话切换被结算时,桥回这个码;dev mock-host 不弹框、直接放行,所以本地怎么调都碰不到它。
 * 仍把它列进本类型,是为了让**照着 dev 类型写代码的应用作者**知道这条分支必须处理 ——
 * 上线后第一次被用户拒绝就会走到,漏处理就是一个只在生产复现的 unhandled rejection。
 * 同理 RATE_LIMITED 在 dev 下也发不出来(mock 不限速),但线上有按用户维度的限速。
 *
 * ⚠ **ROUND_DISCARDED 同样是 dev mock 永远不会发、但生产必然存在的码**:真宿主在
 * `data.save` 撞 `sandbox_round_mismatch`(该轮已被判死、`round.discard` 已同步发出)
 * 时抛出这个码,应用不要重发同一个 save。
 */
export type ParanovellBridgeErrorCode =
  | 'SUBMIT_IN_FLIGHT'
  | 'SUBMIT_FAILED'
  | 'DATA_CONFLICT'
  | 'RATE_LIMITED'
  | 'READONLY'
  | 'TIMEOUT'
  | 'INVALID_PARAM'
  | 'INTERNAL'
  | 'USER_REJECTED'
  | 'PLAN_IN_PROGRESS'
  | 'PLAN_NOT_DISCARD'
  | 'PLAN_NOT_FOUND'
  | 'ROUND_DISCARDED';

/** onLog 事件下发的单条请求/响应日志。 */
export interface ParanovellMockHostLogEntry {
  /** 与桥消息 id 一致,用于请求-响应配对。 */
  id: string;
  /** 消息方向。 */
  direction: ParanovellBridgeDirection;
  /** 桥方法名。 */
  method: ParanovellBridgeMethod;
  /** 请求参数(仅 direction = app-to-host 的请求日志有值)。 */
  params?: unknown;
  /** 成功响应的数据(与 error 互斥)。 */
  result?: unknown;
  /** 失败响应的错误信息(与 result 互斥)。 */
  error?: { code: ParanovellBridgeErrorCode; message: string; payload?: unknown };
  /** 记录时刻(epoch ms)。 */
  timestamp: number;
  /** 请求到响应的耗时(毫秒);仅响应日志有值,由 mock-host 统一计算。 */
  durationMs?: number;
  /**
   * submit-timeout 故障下,mock 已主动结算 TIMEOUT 后又迟到的成功响应——
   * 这条日志单独标记 late,不参与请求-响应配对的耗时计算(该 id 已被结算过一次)。
   */
  late?: boolean;
}

/** AI 返回三模式:echo(原样,默认)/ fixed(固定 JSON + 模拟耗时)/ manual(手动响应)。 */
export type ParanovellMockMode = 'echo' | 'fixed' | 'manual';

/**
 * 恢复交还的自动化模式——'auto'(默认)= data.pull
 * 见到 pendingRound 后延迟自动 emit round.handback,镜像真实宿主 宿主桥 的
 * checkAndRecoverSandboxRound 自动触发行为;'manual' = 关掉自动 emit,只能手工调
 * simulateRoundHandback()/simulateRoundDiscard() 做故障演练。见 mock-host.js
 * recoveryMode 声明处的完整论证。
 */
export type ParanovellRecoveryMode = 'auto' | 'manual';

/** setRecoveryMode() 的可选配置。 */
export interface ParanovellSetRecoveryModeOptions {
  /** 'auto' 模式下的交还延迟(毫秒),覆盖默认值(1500ms)。仅在 mode === 'auto' 时有意义。 */
  delayMs?: number;
}

/** setMockMode() 的可选配置。 */
export interface ParanovellSetMockModeOptions {
  /** fixed 模式下作为响应返回的固定 JSON。 */
  json?: unknown;
  /** 模拟 AI 耗时(毫秒),延迟作用于 data.submit 的响应时机。 */
  delayMs?: number;
}

/** manual 模式下,等待人工放行(respond)或拒绝(rejectRequest)的一条挂起请求。 */
export interface ParanovellPendingRequest {
  /** 与对应 data.submit 请求的桥消息 id 一致。 */
  id: string;
  /** 触发该请求的 handler 名。 */
  handler: string;
  /** 应用侧 submit() 传入的 input。 */
  input: unknown;
  /** 应用侧 submit() 传入的 outputFormat(给模型看的纯格式,JSON 样例字符串)。 */
  outputFormat: string;
  /** 应用侧 submit() 传入的 outputNotes(给模型看的回复说明);未传时为 undefined。 */
  outputNotes?: string;
  /** 本次挂起对应的回合号。 */
  round: number;
  /** 收到该请求的时刻(epoch ms);dev.html"已等待 N 秒"展示用。 */
  receivedAt: number;
}

/** 故障演练四种可配置项(setFault 覆盖);"一键崩溃"走独立的 crash() API,不在此列。 */
export type ParanovellFaultKind = 'save-fail' | 'conflict' | 'rate-limit' | 'submit-timeout';

/** setFault() 的可选配置。 */
export interface ParanovellSetFaultOptions {
  /** 仅触发一次,触发后自动关闭该故障开关。 */
  once?: boolean;
  /** rate-limit 专用:RATE_LIMITED 错误携带的 retryAfter(秒)。 */
  retryAfter?: number;
  /** submit-timeout 专用:mock 挂起多久后主动回 TIMEOUT(毫秒),默认 10000。 */
  timeoutMs?: number;
}

/** 当前正在进行、尚未确认的回合详情(onState.pendingRound 的元素类型)。 */
export interface ParanovellMockHostPendingRoundSnapshot {
  /** 回合号。 */
  round: number;
  /** 触发该轮的 handler 名。 */
  handler: string;
  /** AI 已返回、等待应用确认 save 的输出。 */
  output: unknown;
  /** 该轮开出的时刻(epoch ms)。 */
  startedAt: number;
}

/**
 * setMockMode 配置 + 自动登记形态的落地形状(onState.handlers
 * 的 value 类型)。
 *
 * 自动登记机制出现前:未在此结构中出现的 handler 名一律视为 echo(默认),
 * echo 不占配置项。
 * 自动登记机制出现后:mock-host.js 的 data.submit 首次见到某个 handler 名即自动登记一条默认
 * `{ mode: 'echo' }` 配置(不占配置项的旧语义只对"从未被 submit 过"的 handler 名
 * 成立)——因此 mode 新增 'echo' 取值,handlers 里可能出现 mode 显式为 'echo' 的条目。
 */
export interface ParanovellMockHandlerConfig {
  /** 该 handler 当前的 AI 返回模式;未在此结构中出现的 handler 名(从未被 submit 过)一律视为 echo(默认)。 */
  mode: 'echo' | 'fixed' | 'manual';
  /** fixed 模式下每次返回的固定 JSON。 */
  fixedJson?: unknown;
  /** fixed 模式下模拟的 AI 耗时(毫秒)。 */
  delayMs?: number;
  /**
   * 该 handler 最近一轮 data.submit
   * 请求随带的 outputFormat(给模型看的纯格式,期待回复的 JSON 样例字符串,逐轮
   * 覆盖式更新,不追加历史);格式示例(dev.html「填入格式示例」按钮,直接
   * JSON.parse,失败时降级平衡扫描提取)的唯一数据来源。从未收到过请求时不存在此字段。
   */
  lastFormat?: string;
  /**
   * 该 handler 最近一轮 data.submit 请求随带的 outputNotes(给模型看的
   * 回复说明,逐轮覆盖式更新,与 lastFormat 同生命周期);本轮未传 outputNotes 时
   * 不存在此字段(不是"存在但为 undefined")。
   */
  lastNotes?: string;
}

/** 故障开关的落地状态(onState.faults 的 value 类型,与 setFault 对称)。 */
export interface ParanovellFaultState {
  /** 是否已启用。 */
  enabled: boolean;
  /** 是否仅生效一次(命中后自动关闭)。 */
  once: boolean;
  /** rate-limit 专用。 */
  retryAfter?: number;
  /** submit-timeout 专用。 */
  timeoutMs?: number;
}

/** onState 下发的数据/回合状态快照。 */
export interface ParanovellMockHostState {
  /** 当前确认态数据(深拷贝)。 */
  data: Record<string, unknown>;
  /** 当前存档版本号(乐观锁);回合确认 save 与纯存档 save 均会推进它,只有回合确认才
   *  额外推进 confirmed_round。 */
  revision: number;
  /** 回合状态:idle = 无在途回合,in-flight = 有一轮正在进行。 */
  roundState: 'idle' | 'in-flight';
  /** 只读态开关(与 setReadonly 对应)。 */
  readonly: boolean;
  /**
   * 连接态:sys.ping 桥请求或 ping() 补充 API 触发后置 true;attach()/crash()
   * 重置为 false。dev.html 顶栏连接灯的数据来源。
   */
  connected: boolean;
  /** 当前在途回合的详情;无在途回合时为 null。数据页"没完成的回合"卡片用。 */
  pendingRound: ParanovellMockHostPendingRoundSnapshot | null;
  /** 各 handler 的 AI 返回模式配置;echo(默认)不占键。AI 返回设置页数据来源。 */
  handlers: Record<string, ParanovellMockHandlerConfig>;
  /** 故障演练四种开关的当前状态。故障演练页开关渲染数据来源。 */
  faults: Record<ParanovellFaultKind, ParanovellFaultState>;
  /**
   * 手动接管总开关:开启时所有 data.submit 一律派 manual(不改写任何
   * 单个 handler 的已存配置),关闭后各 handler 恢复原配置。dev.html 简单模式头部与
   * 请求记录工具条两处开关的渲染数据来源(与 setManualTakeover 对称)。
   */
  manualTakeover: boolean;
  /**
   * 恢复交还的当前自动化模式,见
   * ParanovellRecoveryMode 文档;与 locale/readonly/manualTakeover 同一读回路径。
   */
  recoveryMode: ParanovellRecoveryMode;
}

/** 事件订阅的取消函数;调用即取消对应订阅。 */
export type ParanovellUnsubscribe = () => void;

/** mock-host.js 挂载给 dev.html 的完整对外接口(协议引擎,不含任何 DOM/UI)。 */
export interface ParanovellMockHost {
  /** 显式选择 hook 命中/未命中，走真实查询和交还协议。 */
  simulateHook(options?: { hit?: boolean; output?: unknown }): Promise<unknown>;
  /**
   * 接线传输通道(iframe 收发 + 重载回调);dev.html 初始化时调用一次。
   * 返回值不是 void——实际返回 host 自身(= window.ParanovellMockHost),
   * 兼容 `var host = ParanovellMockHost.attach(...)` 这种取返回值当 host 用的写法
   * (dev.html 的实际用法)。
   */
  attach(transport: ParanovellMockHostTransport): ParanovellMockHost;

  /**
   * 手动把 connected 置 true 并广播一次 onState——sdk.js 本身从不主动发
   * sys.ping(桥协议方法存在但应用侧从不调用),这是"连接灯"唯一真实可用的信号来源;
   * 典型用法:iframe 每次实际完成装载(首次进入/点"重载应用"/模拟崩溃触发的重载)时调用。
   */
  ping(): void;
  /**
   * 切换当前操作的应用隔离键(localStorage 键前缀的一部分),并重置引擎瞬态、
   * 广播一次 onState/onPending。dev.html 预期只在 attach() 时通过 transport.appKey 传参,
   * 不作为主路径使用,但接口上保留。
   */
  setAppKey(key: string): void;

  /** 订阅请求/响应日志流(请求记录区的数据来源)。 */
  onLog(handler: (entry: ParanovellMockHostLogEntry) => void): ParanovellUnsubscribe;
  /** 订阅 manual 模式挂起请求队列的变化。 */
  onPending(handler: (pending: ParanovellPendingRequest[]) => void): ParanovellUnsubscribe;
  /** 订阅数据/回合状态变化(数据页、顶栏存档版本与回合指示的数据来源)。 */
  onState(handler: (state: ParanovellMockHostState) => void): ParanovellUnsubscribe;

  /**
   * manual 模式:放行一条挂起请求,用 json 作为该轮 output 回填给应用侧 handler。
   * 返回是否命中:true = id 确实在挂起队列中并已处理;false = id 已不
   * 在队列(已被响应/拒绝过或从未存在)——dev.html 据此决定成功 toast 还是"该请求
   * 已不存在"提示。
   */
  respond(id: string, json: unknown): boolean;
  /**
   * manual 模式:拒绝一条挂起请求(应用侧 submit() 收到 SUBMIT_FAILED)。
   * 返回值语义同 respond()。
   */
  rejectRequest(id: string): boolean;
  /** 设置某个 handler 名下的 AI 返回模式(默认 echo)。 */
  setMockMode(handler: string, mode: ParanovellMockMode, options?: ParanovellSetMockModeOptions): void;
  /**
   * 手动接管总开关:开启后所有 data.submit 一律挂起等人工 respond()/
   * rejectRequest() 放行(不改写任何 handler 已存的 echo/fixed/manual 配置);关闭后
   * 各 handler 恢复原配置原样生效。
   */
  setManualTakeover(enabled: boolean): void;
  /** 打开一种故障注入,用于故障演练区。 */
  setFault(kind: ParanovellFaultKind, options?: ParanovellSetFaultOptions): void;
  /** 切换只读态;开启后 submit/save 一律按真桥语义拒绝 READONLY。 */
  setReadonly(readonly: boolean): void;
  /** 一键崩溃:经 attach 传入的 requestReload 回调重载被装载的应用。 */
  crash(): void;
  /** 数据页悬停编辑:直接改写已确认态里的一个 key(不经回合/纯存档通道)。 */
  editData(key: string, value: unknown): void;
  /** 纯本地作废当前 pendingRound(mock 即"服务端"删记录,数据保持上个确认态);
   * 区别于应用侧 SDK 发起的 data.rollback 通道。 */
  discardRound(): void;
  /**
   * 设置恢复交还的自动化模式,见
   * ParanovellRecoveryMode 文档。
   */
  setRecoveryMode(mode: ParanovellRecoveryMode, options?: ParanovellSetRecoveryModeOptions): void;
  /** 读取当前恢复交还模式。 */
  getRecoveryMode(): ParanovellRecoveryMode;
  /**
   * 事件下行通道:镜像 宿主桥 的 HostBridge.emit(),向被装载
   * 应用下发 `{type:'event', event:eventType, payload}`,驱动应用侧 sdk.js 内部的
   * __onEvent 订阅回调;不占频控配额、不参与回合状态机。attach() 之前调用静默丢弃。
   */
  emit(eventType: string, payload?: unknown): void;
}
