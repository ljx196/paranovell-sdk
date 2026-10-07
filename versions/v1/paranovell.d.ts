/**
 * paranovell sandbox SDK(v3)—— 全局环境类型声明。
 *
 * sdk.js(同目录 sdk.js,零构建纯 JS)运行时把 SDK 挂载到 window.paranovell;本文件是
 * 它的类型对照,覆盖 window.paranovell 挂载的全部 API,让应用代码里裸写 `paranovell.xxx`
 * 时有类型提示与编译期校验。类型约束严格对齐 sdk.js 的运行时校验逻辑(defineRound 的
 * 必填项校验、handler 必须是函数、data.set 拒绝 null/undefined 等),目的是把部分运行时
 * TypeError 前移到编译期。
 *
 * 本文件是全局脚本(顶层无 import/export)—— 不要添加 import/export,一旦引入会让
 * TypeScript 把它当模块处理,以下声明就不再自动进入全局作用域。把它纳入 tsconfig 的
 * 编译范围即可(例如放进 include 或用 `/// <reference path>` 引用),必须保持零错误。
 *
 * dev 专属扩展(mock-host.js 对外接口)不在这里 —— 见同目录 dev/paranovell-dev.d.ts,
 * 那份是 module 形态,避免 dev-only 字段泄漏进生产代码的类型视图。
 *
 * 事件下行通道内部接线点 `__onEvent` 同样声明在这里
 * (它确实挂在运行时 window.paranovell 上,类型必须如实反映),但双下划线前缀 + 接口
 * 内联注释标记它是"非稳定内部契约"——应用代码不应直接调用。
 *
 * `ui.*` 形态/画布语义化 API 的类型声明,在 __onEvent
 * 之上包一层。六种形态 key / 三套画布 key 的字面量与宿主侧(独立维护同一份
 * 白名单/取值域,权威校验在宿主那边)保持同值,
 * 但本文件是全局脚本,类型层不跨文件复用。
 *
 * 兼容性承诺(中心分发 SDK 起):本文件声明的公开 API 是永久契约,只增不改——
 * 中心分发意味着平台替作者承担了「不打挂存量应用」的责任(作者可能早已不维护,平台又
 * 无法逐个回归测试第三方应用)。具体约束:
 *   1. 新增能力只加新方法,或给既有方法加新的**可选**参数;不改既有方法的入参个数/
 *      顺序、返回值结构、必填项。
 *   2. 不收紧也不放松既有方法的运行时校验强度(如 defineRound() 的必填项、data.set
 *      拒绝 null/undefined)——那是与本文件类型声明对齐的行为契约的一部分,收紧会让
 *      曾经能跑的调用当场抛错,放松会让类型层的编译期校验形同虚设。
 *   3. 不改既有方法的调用时序语义(如 ready() 之前能不能调 data.*、回合并发时的
 *      拒绝行为)。
 *   4. `__onEvent` 等双下划线前缀的内部字段不受本条约束,仍可自由变更。
 * 需要做以上任一件事,一律走新 major(`versions/v2/`),不得在 v1 内直接改。
 * 本文件的公开签名有快照测试固化,任何破坏性改动都会让它转红,逼改动者显式面对「这是
 * breaking change」。
 *
 * **冻结的起点**:上面「只增不改」保护的是「该 major 下的
 * **存量应用**」——冻结自**首个第三方应用上线**起生效,在此之前 v1 仍可收敛。
 * v1 发布前没有生产环境,也没有任何第三方应用,保护对象
 * 不存在,冻结尚未开始。变更记录(此前均属"发布前收敛",不构成对任何人的破坏):
 *   - `on()` + `submit()` → `defineRound()`(SDK_VERSION 1.1.0 → 1.2.0)。
 *   - 新增 `onRoundRecovery()` +
 *     `ParanovellRoundRecoveryPayload`(纯增量)(SDK_VERSION 1.3.0 → 1.4.0)。
 *   - 崩溃/刷新后的默认恢复行为
 *     从"零订阅者 → 自动 rollback"反转为"零订阅者 → 自动重放已注册的 `defineRound`
 *     handler 并确认 save"。`onRoundRecovery()` 签名不变,但角色从"唯一恢复路径"降级
 *     成可选的覆盖钩子(SDK_VERSION 1.4.0 → 1.5.0)。
 *   - 刷新后在途回合:新增 `onRoundPending()` + `ParanovellRoundPendingPayload`
 *     (纯增量)(SDK_VERSION 1.8.2 → 1.9.0)。
 */

/**
 * 运行环境探测结果:SDK 初始化时即确定的只读常量。
 * platform 区分宿主传输通道(native = React Native WebView,web = iframe);
 * appId 从 URL query 的 `appId` 参数解析而来,未提供时为空字符串。
 */
interface ParanovellEnv {
  /** 当前宿主平台。 */
  platform: 'native' | 'web';
  /** 应用标识,从 URL query `appId` 解析,未提供时为空字符串。 */
  appId: string;
}

/**
 * SDK 当前支持的语言取值—— 与宿主应用的语言取值范围完全一致
 * (只收敛到这两个值,没有 `'system'` / `'zh-CN'`)。
 *
 * 不塞进 `ParanovellEnv`:`env` 的契约是"SDK 初始化时即确定的只读常量",语言是会变的,
 * 塞进去就要推翻那句话。照 `ui.presentation` 的先例(同样是宿主持有、会变、要推给
 * 应用的状态,走的是 `getPresentation()` + `onPresentationChange()` 这一对方法,不是
 * `env`)——`env` 一个字段都不加。
 */
type ParanovellLanguage = 'zh' | 'en';

/** JSON 基础值:string / number / boolean。 */
type ParanovellJsonPrimitive = string | number | boolean;

/**
 * data 层允许写入的值类型 —— sdk.js 全程走 JSON 桥(内部用
 * `JSON.parse(JSON.stringify(value))` 深拷贝),因此值必须是可 JSON 序列化的结构;
 * 顶层显式排除 null/undefined(remove() 才是"删除"的正确表达),与 sdk.js
 * `data.set` 的运行时 TypeError 对齐。
 */
type ParanovellJsonValue =
  | ParanovellJsonPrimitive
  | ParanovellJsonValue[]
  | { [key: string]: ParanovellJsonValue };

/**
 * data.pending() 返回的单条未提交(未上行)操作日志条目(
 * changes = 操作日志,取代原 key 级快照)。op 判别三种取值,顺序即语义——buffer 是
 * 一个有序数组,同一个 key 可能出现多条(首版不做同 key 折叠压缩)。
 */
type ParanovellPendingOp =
  | { op: 'set'; key: string; value: ParanovellJsonValue }
  | { op: 'remove'; key: string }
  | { op: 'append'; key: string; value: ParanovellJsonValue };

/**
 * 数据层 API:读内存、写 buffer(有序操作日志),真正上行(纯存档节流 / 回合确认)的
 * 时机由 SDK 内部逻辑决定,这里的方法都只是同步操作本地状态。
 */
interface ParanovellDataAPI {
  /** 读取一个 key 的当前值(深拷贝),key 不存在时返回 undefined。 */
  get<T = unknown>(key: string): T | undefined;
  /** 读取全部当前数据(深拷贝)。 */
  getAll(): Record<string, ParanovellJsonValue>;
  /**
   * 写入一个 key。value 不允许是 null/undefined —— 想删除一个 key 请用 remove(),
   * 传 null/undefined 会在运行时抛 TypeError,这里在类型层前移该约束。
   */
  set(key: string, value: ParanovellJsonValue): void;
  /** 删除一个 key。 */
  remove(key: string): void;
  /**
   * 对 key 下的数组尾插一条;key 不存在时视为空数组。item 不允许是 undefined;
   * 若该 key 当前已存在且持有非数组值,运行时会抛 TypeError(防止把结构不明的既有值
   * 悄悄拍扁成数组)。调用即同步应用到内存 —— get(key) 立即得到追加后的数组。
   */
  append(key: string, item: ParanovellJsonValue): void;
  /** 列出当前所有未提交(未上行)的操作日志,便于 UI/调试展示。 */
  pending(): ParanovellPendingOp[];
}

/**
 * defineRound() 的 format / example 允许的值。
 *
 * 不复用 `ParanovellJsonValue`:那个类型顶层显式排除了 `null`(data 层用 remove()
 * 表达删除),而样例驱动协议里 **null 恰恰有意义** —— 值为 null 表示该字段类型不限。
 * 也不写成 `unknown`:d.ts 的自我定位就是把运行时 TypeError 前移到编译期(见文件头
 * 注释与 data.set 拒 null 的先例),`unknown` 等于放弃全部编译期约束。
 */
type ParanovellRoundFormatValue =
  | ParanovellJsonPrimitive
  | null
  | ParanovellRoundFormatValue[]
  | { [key: string]: ParanovellRoundFormatValue };

/** 正文发出前按需查询的 hook；每个应用最多一个，重复定义覆盖。 */
interface ParanovellHookDefinition extends ParanovellRoundDefinition {
  /** 由模型判断的自然语言触发条件。 */
  trigger: string;
  /** 每次查询现算；缺省空串。不得返回 Promise。 */
  input?: () => string;
}

/**
 * defineRound(name, def) 的第二个入参 —— 把「期望回复格式 + 说明与例子 + 处理函数」
 * 一次性声明(取代早期的 on() + submit())。
 */
interface ParanovellRoundDefinition {
  /** 期望模型回复的 JSON 形状。普通 JS 对象/数组,SDK JSON.stringify 后作为
   *  outputFormat 上行。key 后缀 `?` = 可选字段(与后端样例驱动协议逐字一致,SDK 不做
   *  任何转换)。求值时机固定在 define 那一刻(快照):define 之后再改这个
   *  对象,不影响已上行的字节。 */
  format: ParanovellRoundFormatValue;
  /** 给模型的自然语言说明,可选。空字符串视同未提供(见 outputNotes 拼装规则)。 */
  notes?: string;
  /** 真实回复示例,可选。SDK 拼到 notes 尾部,拼装规则:notes 与 example 都有时
   *  为 notes + 换行 + 引导语 + JSON.stringify(example);只有一项时只用那一项。与 format 不同,example 在 **send 时**才 JSON.stringify。 */
  example?: ParanovellRoundFormatValue;
  /** 收到模型回复后的处理函数 —— 唯一的回合写入点。
   *  直接复用既有的 `ParanovellRoundHandler`(`(output: object) => void | Promise<void>`):
   *  SDK 是真的会 await 异步 handler 之后才发确认存档(runRoundHandler 里的
   *  `Promise.resolve().then`),这个语义必须在类型上看得见。 */
  /** handler 必须能仅凭 pull 的权威 data 与本轮 output 重建写入；刷新恢复会重放。
   *  确认 save 遇网络/超时/5xx 将从 1s 开始指数退避，无限重试且上限 30s；
   *  明确拒绝 (5424/5437/5438) 立即停止，按既有 rollback 规则收尾。 */
  handler: ParanovellRoundHandler;
}

/**
 * defineRound() 返回的发起函数 —— 只闭包了 name,不闭包 format/notes/example/handler
 * (否则重定义后旧发起函数会拿旧 format 配新 handler)。每次调用按 name 现取
 * 当前定义,拼好 outputFormat/outputNotes 转交内部回合状态机。
 */
type ParanovellRoundSender = (opts: { input: string }) => Promise<ParanovellRoundResult>;

/** defineRound() 返回的发起函数成功结算后的值。 */
interface ParanovellRoundResult {
  /** handler 处理完成、回合确认存档之后的输出内容(与 handler 收到的 output 同一份)。 */
  output: unknown;
}

/**
 * defineRound() 里 `handler` 字段的类型:收到桥下发的 output 后会调用它,可以是同步
 * 函数,也可以返回 Promise 做异步处理(SDK 会等待它结算后再发起回合确认 save)。
 */
type ParanovellRoundHandler = (output: object) => void | Promise<void>;

/**
 * 回合恢复:
 * `onRoundRecovery()` 回调收到的载荷——刷新/重进应用后,若上一轮沙盒回合已经 submit
 * 但还没确认(段 2/3 悬着),宿主在后台异步取到 output 后经这个载荷把决定权交还给应用。
 *
 * ⚠ **不注册 `onRoundRecovery()` 不等于放弃这一轮**——只要 `name` 已经通过
 * `defineRound()` 注册,SDK 默认会自动调用同一个 handler 重放这一轮并确认 save,应用
 * 不用写任何代码(见 `ready()` 文档)。这个回调因此是**可选的覆盖钩子**:只有注册了,
 * SDK 才会把决定权交还给应用而不是自动重放。commit()/discard() 的语义本身没有变化。
 *
 * 自动重放的前提是契约性的、SDK 不会在运行时替你检查:这一轮 handler 的权威写入必须
 * 完全能从 `data` 重建——不能依赖只活在 JS 闭包里的中间状态(那种状态刷新后已经丢失,
 * 重放会静默算错且不报错)。参照 `ParanovellPresentationChangePayload` 的命名与文档惯例。
 */
/**
 * 刷新后在途回合:`onRoundPending()` 回调收到的载荷。
 *
 * 刷新 / 换设备重进应用时,若上一轮回合的正文**还在生成**,宿主会先告诉应用"这一轮在
 * 进行中"(`pending: true`),生成完、这一轮在 SDK 侧结束(自动重放并确认 save、回滚、
 * 被宿主放弃)时再发 `pending: false`。应用可据此显示自己的 loading;不订阅也不影响
 * 恢复本身(见 `ready()` / `onRoundRecovery()`)。
 *
 * 本地没有可用数据时(换设备 / 清过缓存),`pending: true` 会在 `ready()` resolve
 * **之前**到达——此时 `data.*` 还是空的,`ready()` 会一直等到正文生成完才带数据返回。
 */
interface ParanovellRoundPendingPayload {
  /** true = 这一轮进行中;false = 已结束(成功或放弃)。只在状态翻转时触发。 */
  pending: boolean;
  /** 回合号,与这一轮的确认 / 回滚是同一个。 */
  round: number;
}

interface ParanovellRoundRecoveryPayload {
  /** 与 `defineRound()` 注册时的 `name` 一致,供应用识别这是哪一类回合。 */
  name: string;
  /** 模型这一轮的产出(与 handler 平时收到的 output 同一份)。 */
  output: unknown;
  /**
   * 应用决定"接"——已经自己把这一轮的数据变更写进 `data.*`(是否复用原来的处理
   * 逻辑由应用自己决定),调用它按回合确认语义上行,等价于 `data.save{round, changes}`。
   * **不会替应用调用任何 handler**——SDK 不提供"一键接受并跑已注册 handler"的捷径
   * (这条约束在覆盖路径上保持不变)。resolve 表示确认成功;拒绝时错误带 code
   * (DATA_CONFLICT / RATE_LIMITED / TIMEOUT / INTERNAL 等,与 `defineRound()` 发起
   * 函数同一套错误码)。
   */
  commit(): Promise<void>;
  /** 应用决定"弃"——放弃这一轮,转 rollback。resolve 表示回滚成功;拒绝时错误带 code。 */
  discard(): Promise<void>;
}

/** 六种沙盒形态 key,与宿主侧白名单同值。 */
type ParanovellFormKey = 'split' | 'float' | 'full' | 'mfull' | 'mland' | 'mdrawer';

/** 三套画布 key。 */
type ParanovellCanvasKey = 'portrait' | 'landscape' | 'compact';

/**
 * 开发者声明的单套画布:只有比例,没有像素("只约束比例,不约束像素")。safe 是
 * 'w:h' 形式的比例字符串(如 '9:16');bleed 是背景外扩倍数,省略时用宿主内置默认值。
 * 取值域(桥独立校验,SDK 侧同款校验只是 UX):比例为有限正数且 0.05 ≤ r ≤ 20,
 * bleed 的 w/h 分量均须 ∈ [1, 3]。
 */
interface ParanovellCanvasSpec {
  safe: string;
  bleed?: { w: number; h: number };
}

/** ui.setCanvas() 的入参:三套画布都可选,空对象视为未声明(用宿主默认 portrait 9:16)。 */
type ParanovellCanvasSet = Partial<Record<ParanovellCanvasKey, ParanovellCanvasSpec>>;

/** ui.present() 成功后的返回值。 */
interface ParanovellPresentResult {
  /** 端能力/画布可用性裁决后实际生效的形态,可能与请求的 form 不同(降级)。 */
  applied: ParanovellFormKey;
  /** 是否发生了降级(平台不支持该形态,或声明的画布均不可用)。 */
  degraded: boolean;
  /** 降级原因,仅 degraded 为 true 时可能出现('platform' | 'readability' 等)。 */
  reason?: string;
}

/**
 * onPresentationChange() 回调收到的载荷 —— 比 present() 的返回值多 requested(本次
 * 触发变化前应用侧/宿主侧请求的形态)、canvas(画布轴裁决结果)、scale(渲染缩放系数)。
 */
interface ParanovellPresentationChangePayload {
  form: ParanovellFormKey;
  requested: ParanovellFormKey;
  degraded: boolean;
  reason?: string;
  canvas: ParanovellCanvasKey | null;
  scale: number;
}

/** getPresentation() 的返回值 —— 纯本地读缓存,不发请求。首次 ready()
 *  完成前 / 首个 ui.presentationChange 事件到达前,form/canvas 恒为 null。 */
interface ParanovellPresentationSnapshot {
  form: ParanovellFormKey | null;
  canvas: ParanovellCanvasKey | null;
  scale: number;
}

/**
 * 形态/画布语义化 API,内部基于事件下行通道(__onEvent 订阅
 * ui.presentationChange)实现。present/setCanvas 走桥请求;getPresentation 纯本地读;
 * onPresentationChange 任何形态变化都回调,不只是降级。
 */
interface ParanovellUiAPI {
  /**
   * 请求切换到某个形态。resolve 时携带端能力/画布裁决后的最终结果(可能已降级);
   * 拒绝时错误带 code(INVALID_PARAM = 非法 form key / RATE_LIMITED 等)。
   */
  present(form: ParanovellFormKey): Promise<ParanovellPresentResult>;
  /**
   * 声明一套或多套画布(只约束比例,不约束像素)。resolve 表示已被宿主接受;拒绝时
   * 错误带 code(INVALID_PARAM = 比例/bleed 越界或结构非法),已有画布集不受影响。
   */
  setCanvas(set: ParanovellCanvasSet): Promise<void>;
  /** 读取当前形态/画布/缩放的本地缓存快照,同步返回,绝不发请求。 */
  getPresentation(): ParanovellPresentationSnapshot;
  /** 订阅形态变化(含宿主侧发起的变化,如 resize/旋转导致的重裁决)。返回取消订阅函数。 */
  onPresentationChange(cb: (payload: ParanovellPresentationChangePayload) => void): () => void;
}

/** plan(方案)四态:processing = 生成中/待确认,running = 已生效,complete = 已完结,
 *  discard = 已废弃(仅这一态可被 restart)。 */
type ParanovellPlanStatus = 'processing' | 'running' | 'complete' | 'discard';

/**
 * plan.list() 返回的单条记录 —— 只有列表接口带 content 全文快照(创建/重启的返回值
 * 不含 content,见 ParanovellPlanRef 注释)。
 */
interface ParanovellPlanItem {
  id: string;
  title: string;
  status: ParanovellPlanStatus;
  content: string;
  /** unix 秒;restart 会把它刷成当前时间。 */
  createdAt: number;
}

/**
 * create() / restart() 的返回值 —— 不含 content(调用方刚发上去,不原样回吐)。
 */
interface ParanovellPlanRef {
  id: string;
  title: string;
  status: ParanovellPlanStatus;
  createdAt: number;
}

/** create() 的入参 —— title / content 均为必填非空字符串。 */
interface ParanovellPlanCreateOptions {
  /** 必填非空。 */
  title: string;
  /** 必填非空。 */
  content: string;
}

/**
 * plan(方案)管理 API—— 沙盒应用读写小说的 plan 实体:列出
 * 全部 plan、直接下发新 plan、重启一条 discard plan。
 *
 * **写操作(create/restart)会先由宿主弹出一个轻量授权框**:内容只有"哪个应用想做什么事"+ 接受/拒绝,应用无法跳过、也无法篡改框里展示
 * 的操作名(操作名由宿主从被调用的方法推导,不接受应用传入)。
 *
 * **确认框对应用是不可见、不可控的**(行为契约的一部分):本
 * 接口不暴露任何"跳过确认""预检查是否会弹框"的参数或方法——一旦暴露,应用就能据此
 * 做时序攻击(比如挑用户注意力不在时才调用)。应用能观察到的只有最终的 resolve/
 * reject;等待时长可能明显长于普通网络请求(取决于用户何时响应确认框),这不代表
 * 请求卡死。
 */
interface ParanovellPlanAPI {
  /** 列出全部方案,createdAt 降序。纯读,不弹确认框。 */
  list(): Promise<ParanovellPlanItem[]>;
  /**
   * 下发一个新方案。**会先由宿主弹出确认框**(应用无法跳过/篡改);用户取消时
   * reject 且 code 为 USER_REJECTED,此时不产生任何网络请求。
   */
  create(opts: ParanovellPlanCreateOptions): Promise<ParanovellPlanRef>;
  /** 重启一条 discard 方案。同 create,先经宿主确认框。 */
  restart(planId: string): Promise<ParanovellPlanRef>;
}

/** paranovell sandbox SDK 挂载在 window.paranovell 上的全量 API。 */
interface ParanovellSDK {
  /** 环境探测信息(platform / appId),SDK 初始化时即确定的只读常量。 */
  env: ParanovellEnv;
  /** 数据层 API(get / getAll / set / remove / append / pending)。 */
  data: ParanovellDataAPI;
  /**
   * 完成一次数据拉取(桥方法 data.pull);若发现有未确认的回合(pendingRound),**不会
   * 阻塞**(不再是早期的"一律
   * 回滚到上一个确认态")——`ready()` 立即成功返回,恢复在后台异步进行,期间新一轮
   * `defineRound()` 发起函数与 `save()` 均本地拒绝/挂起。宿主取到 output 后:
   *   - 默认**自动重放**该轮已注册的 `defineRound` handler 并
   *     确认 save,应用不用写任何代码——前提是 handler 的权威写入完全能从 `data` 重建
   *     (见 `ParanovellRoundRecoveryPayload` 文档)。
   *   - 若应用注册了 `onRoundRecovery()`,则改为把决定权交还给应用,不自动重放。
   * 应用启动时应先 await 它,拿到数据就绪后再读写 data。重复调用返回同一个 Promise。
   */
  ready(): Promise<void>;
  /**
   * 一次性定义一个回合:形状(format)、说明(notes)、示例(example)、处理函数
    * (handler)(取代早期的 on() + submit(),不做兼容)。SDK 把
   * format 用 JSON.stringify 转成上行 outputFormat(定死在 define 时的快照,之后原地
   * 改 format 对象不影响已上行字节);notes/example 拼成 outputNotes(拼装规则见
   * sdk.js defineRound 实现注释,LEAD_IN 随当前语言在 send 时取值,见 getLanguage)。
   * 返回值是一个只闭包了 name 的发起函数 —— 同名重定义后,旧发起函数与新发起函数
   * 完全等价,永远按 name 现取当前定义,不会出现"旧发起函数配旧 format 新 handler"
   * 的 drift。发起函数 resolve 时回合已确认存档;拒绝时错误带 code
   * (SUBMIT_IN_FLIGHT / DATA_CONFLICT / RATE_LIMITED / READONLY / TIMEOUT / INTERNAL 等)。
   */
  defineRound(name: string, def: ParanovellRoundDefinition): ParanovellRoundSender;
  /** name 先去首尾空白，再校验且不得与 defineRound 重名；须在 ready() 前注册，确保刷新可恢复。 */
  defineHook(name: string, def: ParanovellHookDefinition): void;
  /**
   * 纯存档:立即把当前未提交的写入快照下来,按节流窗口(3s)合并上行,不开启回合。
   * 多次调用共享同一条节流通道,resolve 表示这次快照最终确认上行成功。
   * 锚点 = revision 乐观锁:上行携带当前本地 revision 作锚点,匹配则
   * 按序应用并推进 revision(不产生新的已确认回合),不匹配则服务端以 409 DATA_CONFLICT
   * 回当前确认态全量,SDK 自动全量替换内存并清空 buffer 后 reject。
   */
  save(): Promise<void>;
  /**
   * 读取当前语言,默认 `'zh'`;`ready()` 之前调用也安全,不抛错。传播路径两条,
   * 应用侧零主动查询:启动时随 `ready()` 的 data.pull 回包(locale 字段)写入;运行期
   * 随宿主推送的语言变化事件更新。`defineRound` 拼给模型的 LEAD_IN 引导语随它切换,
   * 在每次发起(send)时取值,不需要重新 `defineRound`。
   */
  getLanguage(): ParanovellLanguage;
  /**
   * 显式覆盖当前语言,并**锁定**——此后忽略宿主推送的语言变更(不可撤销)。非法值
   * (不在 `'zh'`/`'en'` 内)同步抛 TypeError,与 SDK 既有校验风格一致。
   */
  setLanguage(lang: ParanovellLanguage): void;
  /**
   * 订阅语言变化。只在生效值**确有变化**时触发(经 setLanguage() 造成的变化也触发,
   * 订阅者可能不是调用方)。返回取消订阅函数。
   */
  onLanguageChange(cb: (lang: ParanovellLanguage) => void): () => void;
  /**
    * 可选覆盖钩子:订阅"有一轮待应用决定"的显式交还事件——见 `ready()` 与
   * `ParanovellRoundRecoveryPayload` 文档。**不订阅不等于放弃**:默认行为是自动重放
   * 已注册的 handler 并确认 save;订阅了才由这里的回调接管决定权。
   * 仅在 `defineRound()` 已经注册了对应 `name` 时才会收到回调;未注册时 SDK 自主放弃并
   * 转 rollback,不会触达这里(这条边界始终成立)——因此 `defineRound()`
   * 必须在 `ready()` 之前完成全部注册,交还事件到达时补注册已经来不及。返回取消订阅
   * 函数。
   */
  onRoundRecovery(cb: (recovery: ParanovellRoundRecoveryPayload) => void): () => void;
  /**
   * 刷新后在途回合(可选):订阅"上一轮还在进行中"的状态——见
   * `ParanovellRoundPendingPayload`。建议在 `ready()` 之前订阅,才能在无本地数据、
   * `ready()` 仍在等待时就收到 `pending: true`。返回取消订阅函数。
   */
  onRoundPending(cb: (payload: ParanovellRoundPendingPayload) => void): () => void;
  /** 形态/画布语义化 API,详见 ParanovellUiAPI。 */
  ui: ParanovellUiAPI;
  /** plan(方案)管理 API,详见 ParanovellPlanAPI。 */
  plan: ParanovellPlanAPI;
  /**
   * 内部 API—— 事件下行通道的订阅入口,ui.* 等语义化 API接线用。
   * 双下划线前缀标记"非稳定公开契约",应用代码不应直接调用。订阅一个事件类型,返回
   * 取消订阅函数;同一事件类型可重复订阅,单个回调抛出的异常会被隔离,不影响其余
   * 订阅者、不冒泡出 SDK。
   */
  __onEvent(eventType: string, cb: (payload: unknown) => void): () => void;
}

/**
 * 全局单例:sdk.js 加载后自动挂载到全局标识符 paranovell(以及 window.paranovell,
 * 见下方 Window 接口扩展)。应用代码直接引用它即可,无需 import。
 */
declare const paranovell: ParanovellSDK;

/** 扩展 lib.dom 的 Window 接口:sdk.js 运行时把 SDK 挂到 window.paranovell 上。 */
interface Window {
  paranovell: ParanovellSDK;
}
