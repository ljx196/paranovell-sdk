/**
 * paranovell sandbox SDK(v3)—— 纯 JS 单文件,无构建产物,ES2017,浏览器 <script> 直接引入。
 *
 * 挂载:window.paranovell(IIFE)。
 * 通信:沙盒 ⇄ 宿主走 JSON 字符串消息。
 *   - native(RN WebView):上行 window.ReactNativeWebView.postMessage;
 *     下行由宿主 injectJavaScript 同时向 window 与 document 派发 'message' 事件,
 *     故本 SDK 在两个 target 上都挂监听(iOS/Android 行为差异兼容)。
 *   - web(iframe):上行 window.parent.postMessage(text, '*');下行监听 window 'message'。
 * 能力面:环境探测 + RPC + 数据层(内存 KV + buffer)+ defineRound(回合原语,取代
 *   早期的 on()/submit(),详见下方 "回合 API" 段)+ save(纯存档)+ 语言(详见下方
 *   "语言(locale)API" 段,getLanguage/setLanguage/onLanguageChange)+ 启动时自检版本
 *   漂移(见下方 checkSDKVersionDrift)。
 * 明确不做:没有 fsm——状态机是应用侧模式,状态存普通 data key,转移逻辑写在应用代码里;
 *   model.define/run(v2 遗留)已随 v3 回合 API 移除。
 *
 * changes = 操作日志(取代 key 级快照):buffer 是有序操作日志
 *   [{op:'set',key,value} | {op:'remove',key} | {op:'append',key,value}],顺序即语义。
 *   data.set/remove/append 调用即入一条 op 并同步应用到内存;append 对 key 下数组尾插
 *   一条(key 不存在视为空数组);changes 上行即这份 op 列表本身,窗口内多次快照按顺序
 *   拼接;首版不做同 key 折叠压缩(正确性优先)。后端(本期即 mock-host)按序应用三种 op,
 *   词汇表外的 op 整体拒绝。
 *
 * v3 回合生命周期(核心;入口是 defineRound(),早期的 on()/submit() 已移除,
 *   详见下方 "回合 API" 段):
 *   defineRound(name, {format, notes, example, handler}) 一次性声明,返回发起函数 sender;
 *   sender({input}) 按 name 现取当前定义、拼好 outputFormat/outputNotes 后转交内部
 *   dispatchSubmit({input, outputFormat, outputNotes, handler}) → 桥 data.submit(不带
 *   changes,只开轮次) → 桥回 {round, output} → 注入已注册 handler → handler 返回后 SDK
 *   自动 sweep 纯存档快照 + buffer 发 data.save{round, changes} 确认该轮 → resolve {output}。
 *   handler 抛错:不发 save,主动发 data.rollback 收敛该轮(取代旧版"留在途 stuck、
 *   等下次 ready()"——见下方"显式交还"段);确认 save
 *   网络失败(非冲突):先做有限次退避重试(取值理由见
 *   performRoundConfirmSave 处注释),仍失败才让回合留在"在途"(stuck),不做同会话内
 *   自动重试——真相以下一次交还/放弃事件为准(见下方"显式交还"段)。
 *   仅 DATA_CONFLICT(后端胜、全量替换)会把回合状态收敛回 idle。
 *   崩溃/刷新后重入:默认
 *   **自动重放**——宿主后台取到 output 后,SDK 直接调用同名 handler(与正常路径完全
 *   同一份 `runRoundHandler`),跑完照常发确认 save,应用不用写任何代码。`onRoundRecovery()`
 *   降级成可选的覆盖钩子,只在应用显式订阅时才接管决定权;没有订阅**不等于放弃**(旧
 *   默认是"零订阅者→自动 rollback",现在是"零订阅者→自动重放并 save")。详见下方
 *   "显式交还"段。
 *
 * 纯存档(save())与回合确认共用同一条节流上行通道(archive.*):
 *   调用即快照(sweep buffer),上行按 3s 窗口合并;空闲兜底与页面隐藏/失焦 flush 同源触发;
 *   回合在途时上行整体抑制,回合确认时一并吸收(sweep)当时未上行的快照。
 *
 * 事件下行通道:宿主 → 应用的单向推送,协议信封
 *   `{ type:'event', event:<eventType>, payload }`(与请求/响应信封 `{id,type,...}` 是
 *   两套独立形状,不共用 id,也不经 pendingRequests 的 RPC 超时/去重逻辑)。内部维护
 *   eventType -> 订阅回调数组的订阅表,`__onEvent(eventType, cb) → unsubscribe`;同一
 *   eventType 可多次订阅,逐个隔离调用 —— 单个回调抛异常只记 dev 告警,不中断其余回调、
 *   不冒泡到桥。
 *
 * ui.* 形态/画布 API:在上面的内部订阅表之上包一层
 *   语义化 API —— `present(form)`/`setCanvas(set)` 走桥请求(`ui.present`/
 *   `ui.setCanvas`,与请求/响应协议同构,占用普通 RPC 超时,不占用回合状态机);
 *   `getPresentation()` 纯本地读一份内部缓存 `uiState`,**绝不发请求**;
 *   `onPresentationChange(cb)` 直接复用 __onEvent 订阅 `ui.presentationChange` 事件。
 *   `uiState` 由内部订阅者(__onEvent 注册顺序早于任何应用代码,见下方接线处)在收到
 *   `ui.presentationChange` 事件时更新;首次可能来自 ready() 的 data.pull 响应里的
 *   可选 `presentation` 字段(宿主若在 pull 响应里带上初始快照即可提前 seed,省去应用
 *   启动后还要等第一次 present()/宿主事件才能拿到非空 getPresentation() 的窗口),
 *   否则保持 { form:null, canvas:null, scale:1 } 直到第一条事件到达。
 *   present()/setCanvas() 本身的校验(form 白名单 / 画布取值域)只是 UX(同步快速失败,
 *   不占一次网络往返);真正权威的校验在宿主桥侧独立完成,
 *   SDK 这里过了本地校验不代表桥一定放行。
 *   另有一套内部机制(由 mousemove 驱动,
 *   见下方"三条实测硬事实"):监听自身文档的指针活动,节流上报 `ui.pointerEnter`,用于
 *   宿主侧 float 悬停放大判定——对应用开发者完全透明,不是公开 API,不挂在
 *   window.paranovell.ui 上,应用不需要写任何代码。
 *
 * plan.* API(详见下方 "plan.* API" 段):挂在
 *   window.paranovell.plan 上,list()/create()/restart() 三个方法读写小说的 plan(方案)
 *   实体。create()/restart() 在桥内部会先经宿主确认框(应用不可见、不可控),SDK 只是
 *   发一个耗时可能偏长的请求,resolve/reject 是唯一可观测的结局。
 *
 * 回合 API:defineRound(name, def)(取代早期的 on() + submit(),详见下方
 *   "回合 API" 段):把「期望回复格式 + 说明与例子 + 处理函数」收拢成
 *   一次声明,SDK 负责把普通 JS 对象 format 转成后端要的 JSON 样例串,返回一个只闭包了
 *   name 的发起函数 sender。on()/submit() 已从公开面移除,不做兼容——v1 发布前的
 *   API 收敛,不构成破坏性变更。
 *
 * 语言(locale)API(详见下方 "语言(locale)API" 段):defineRound
 *   替开发者拼一句给模型看的引导语(LEAD_IN),这句话的语言不再由应用作者控制,SDK 因此
 *   需要知道当前用户语言。getLanguage()/setLanguage()/onLanguageChange() 三个方法读取、
 *   覆盖、跟随当前语言('zh'/'en'),内部状态经 ready() 的 data.pull 回包(locale 字段)
 *   与宿主推送的 sys.languageChange 事件两条路径更新,应用侧零主动查询。
 */
(function () {
  'use strict';

  // RPC 超时按方法分级:宿主转发显式超时(submit 段 1 730s + 段 2
  // output 300s 预算 + 段 3 rollback 90s = 1120s / save·rollback 30s / pull 15s)
  // 严格早于这里的对应值,保证桥必先结算、两层状态机不失步——
  // 宿主超时后迟到的后端成功由下一次 ready() 见到 pendingRound 后的**交还/放弃**收敛
  // (不再是早期的"ready 期一律回滚";
  // 不重放 handler 这条结论不变,详见下方"显式交还"段)。
  //
  // 历史上修正过两处倒置:
  //   1. REQUEST_TIMEOUT_MS(默认档,pull 走这一档)原 10000ms 比宿主 PULL_TIMEOUT_MS=15000ms
  //      更短——宿主还没来得及结算,SDK 自己先超时了,违反"宿主必先结算"不变量。抬到
  //      20000ms(15s + 5s 余量,与其余分级同款留白比例)。
  //   2. SUBMIT_REQUEST_TIMEOUT_MS 原 200000ms 是配合宿主原 180000ms 定的(+20s 余量);
  //      宿主 submit 超时同步抬到 730000ms,这里跟着
  //      抬到 750000ms,保持同一条 +20s 余量惯例,不然这一档会变成新的倒置。
  //
  // 随后 `data.submit` 的宿主侧从单次 730s 拆成
  // 两步(沙盒结果与正文解耦)——
  // 正文段(段 1)仍是 730s,但桥内部紧接着还要发起 output 段(段 2,300s 墙钟预算,拿到
  // `pending`/5xx 立即重发,不数次数)+ 段 3 的 rollback 有界重试(90s)才真正结算,三段
  // 串行相加 730 + 300 + 90 = 1120s。若这里的常量仍停在旧值,会重演本条注释开头说的
  // 倒置:宿主还没结算,SDK 自己先超时,`roundInFlight` 被就地复位,但服务端壳仍在——
  // 下一次 submit 真出网撞 409。抬到 1140000ms,继续沿用
  // +20s 余量惯例,"宿主必先结算"不变量继续成立。⚠ 这个常量与下面的 SDK_VERSION 必须
  // 一起改——只改数字不改这段注释,下一个人会照着旧注释("单次 730s")重新推出一个倒置
  // (需保持 730_000+300_000+90_000 < 本常量 这条不等式)。
  var REQUEST_TIMEOUT_MS = 20000; // 默认(sys.ping / data.pull 等未特别分级的方法)
  var SUBMIT_REQUEST_TIMEOUT_MS = 1140000; // data.submit:段 1 730s + 段 2 300s + 段 3 90s + 20s 余量
  var SAVE_ROLLBACK_REQUEST_TIMEOUT_MS = 40000; // data.save / data.rollback
  // 纯存档节流合并窗口 + 空闲兜底延迟——同一节流通道用同一常量("三源合并节流")。
  var ARCHIVE_SAVE_THROTTLE_MS = 3000;
  // 悬停放大探测上报节流窗口(见下方"三条实测硬事实")——取
  // 150~250ms 区间的中点 200ms:约每秒 5 条,人眼可感知延迟阈值(~100-200ms)以内,重新进入
  // 应用后放大感觉是即时的;同时远低于宿主桥 ui.* 独立频控桶容量
  // (30/1000ms),留出 6 倍余量。没有其它数值依赖这个常量,
  // 纯粹是"够快不丢体验、够慢不刷屏"的折中,不是从别处推导出来的。
  var POINTER_REPORT_THROTTLE_MS = 200;
  // 焦点几何上报节流——与上面的
  // POINTER_REPORT_THROTTLE_MS 是姊妹常量但刻意分开维护(不复用同一个数字):指针悬停
  // 上报服务的是"实时跟手"的视觉反馈,几何变化再小也要跟手;焦点几何上报服务的是宿主的
  // 键盘平移计算,变化频率远低于指针移动,不需要 200ms 那么快,但要明显快于宿主侧
  // 焦点门控的过期时限(2000ms),否则正常
  // 持续聚焦也会被宿主误判成过期。两处各自独立维护这个数值(sdk.js 不能 import
  // 宿主代码),靠注释交叉引用保持同步意图,不做运行期强校验。
  //
  // ⚠ 语义说明:这条心跳不是给宿主的"存活
  // 信号"——宿主侧不再有需要被"解救"的冻结状态(宿主持续维护可视高度基线),
  // 心跳的语义是
  // **纯粹的几何新鲜度信号**(证明"这份 rect 仍然对应当前正被使用的输入框"),不承担
  // 任何自愈职责;它存在的唯一理由是"正常持续聚焦不该被宿主的过期时限误判"这一条,
  // 见上一段。
  var FOCUS_REPORT_HEARTBEAT_MS = 800;

  // 双指缩放手势上报的节流窗口(「捏合要全局可用」)。
  // 宿主给 `ui.viewportGesture` 单开了 60/秒 的频控桶,33ms ≈ 30/秒,留了一倍余量;
  // 每条上报都带**相对起手的绝对量**(scale/dx/dy),丢帧不累积误差,所以节流掉的帧
  // 只影响跟手的平滑度,不会让缩放走偏。
  var GESTURE_REPORT_THROTTLE_MS = 33;
  // RATE_LIMITED 未带 retryAfter 时的退避兜底秒数。
  var DEFAULT_RATE_LIMIT_RETRY_S = 3;
  // RATE_LIMITED retryAfter 的钳制上限(秒)——防御宿主/后端传回
  // 异常大或负值时把重试无限期推迟或立即打爆重试。
  var MAX_RATE_LIMIT_RETRY_S = 600;

  // SDK 自身版本号——必须与
  // sdk-version.json 的 "version" 字段逐字同步(发版时两处一起改)。
  // 用途见下方 checkSDKVersionDrift:与 shim 上传时烧录的 __PARANOVELL_SDK_BUILT_AGAINST
  // 比对,不一致时上报。两处字面量各自独立维护(sdk.js 不能 import JSON),
  // 不靠人工记住"这两个文件是一对"。
  //
  // 版本记录(每次变更都要 bump,漂移检测靠字面量比对):
  // 1.1.0:新增 plan.* 命名空间,纯增量(只增不改),
  // 不构成 breaking change,按 minor 号推进。
  // 1.2.0:on()/submit() 从公开面
  // 移除,改为 defineRound()。这是一次 breaking change,但 v1 发布前没有任何第三方应用上线,
  // 不构成对任何存量应用的破坏;不开 v2 是因为 versions/v1/ 是 API 世代目录,SDK_VERSION 是世代内
  // 的构建版本号,两者不是一回事,零存量用户下"数字变了"就足够让漂移检测工作。版本号
  // 必须变,否则上传管线烧录的 __PARANOVELL_SDK_BUILT_AGAINST 漂移检测会对着已删除的
  // 旧公开面误报"无漂移"。
  // 1.3.0:`SUBMIT_REQUEST_TIMEOUT_MS` 从 750000
  // 抬到 1140000(见上方定义处注释)。公开面(defineRound sender / handler 契约 / 自动
  // 确认 save)一字未改,只是内部超时常量调整,不构成 breaking change;仍在 versions/v1/
  // 世代内(判据同 1.2.0),不开 v2。版本号仍然必须变——道理与
  // 1.2.0 相同:漂移检测靠字面量比对,数字不变就侦测不出这次常量调整。
  // 1.4.0:新增公开 API
  // `onRoundRecovery()`(见 paranovell.d.ts `ParanovellRoundRecoveryPayload`)。纯增量
  // (只加方法不改既有签名),不构成 breaking change,不开 v2;但版本号
  // 仍然必须变——checkSDKVersionDrift 的漂移统计只上报不阻断,存在的意义就是"在真正
  // 发生破坏性变更前估出影响面":新增了公开 API 却不改版本号,按旧版打包的应用与吃到
  // 新 API 的运行时之间会显得"没有漂移",这个信号就废了。
  // 1.5.0:默认行为
  // 反转,不是纯增量:没有订阅 `onRoundRecovery()` 时,交还不再自动 rollback,改为自动跑
  // 已注册的 `defineRound` handler(见下方"显式交还"段)。
  // `onRoundRecovery()` 本身签名不变,但它的角色从"唯一恢复
  // 路径"降级成"可选覆盖钩子"——对同一份旧代码(`defineRound` 了但没接 `onRoundRecovery`
  // 的应用)运行时行为发生了实质变化(以前刷新后这一轮会被弃,现在会被自动重放并 save),
  // 版本号必须变,否则漂移检测会对着这次行为翻转误报"没有漂移"。
  // 1.5.1(patch,非行为反转):应用侧
  // 可见的 JS API(defineRound/data.set/sender 的返回值与时序)逐字节不变,变的只是
  // submit 前那次"强制存档"从独立 data.save 请求改为随 data.submit 一起挂
  // pending_changes 字段出网;失败时的兜底(缓冲区保留 + 回落纯存档)使这一步比改前更
  // 稳健,不是更弱。因此只 bump patch 位,不是 minor——这里仍然记账,理由同上面几次
  // bump:后人靠字面量差值判断"要不要读这段注释",省略并非疏漏。
  // 1.5.2(patch,非行为反转):应用侧
  // 可见的 JS API 逐字节不变,变的是 submit 失败时 pendingChangesOps 的内部兜底落点:
  // DATA_CONFLICT(409)不再回落纯存档,整批丢弃(与该分支对其它本地写的既有处置一致,
  // 由应用基于冲突响应带回的新 data/revision 重新决定);网络错误/超时/响应无 revision
  // 改为放回 state.buffer 头部,只随下一次 submit 出网,不再被 idle 定时器抢先当独立
  // 纯存档写到落账线之前(见 dispatchSubmitAfterArchive 的 requeuePendingChangesToBuffer
  // 与三个调用点注释)。
  // 1.5.3(patch,非行为反转):1.5.2 那次
  // "放回 state.buffer 头部"的兜底本身就是新孤儿路径:state.buffer 是 triggerIdleArchive/
  // flushOnHide/archiveSnapshotAndEnqueue 三条纯存档抽取路径共用的公共缓冲区,这三处的
  // state.roundInFlight 守卫在 submit 失败分支里已经不成立(失败处理开头已经把它复位成
  // false),放回 buffer 会被其中任意一条当独立纯存档抢先出网,写到落账线**之前**——与
  // 1.5.1 要消灭的孤儿路径同构。现在只有 submit 失败(回合未开出)这批写改放进独立槽位
  // state.heldPendingChanges——三条 sweep 一律不碰它,只有 dispatchSubmitAfterArchive
  // 自己在下一次派单时读它、并入新一批 pendingChanges 后清空(见下方 state 定义与
  // dispatchSubmitAfterArchive 内 holdPendingChangesForNextSubmit 的注释)。"响应无
  // revision"(回合已经开出)这一支不受影响,原样放回 state.buffer、随本轮确认 save 上行。
  // 1.9.0(minor,纯增量;刷新 / 换设备后回到生成中状态)——新增公开 API `onRoundPending(cb)` 与下行
  // 事件 `round.pending`(宿主预告"这一轮正文还在生成",同时充当首次 data.pull 的超时顺延
  // 心跳)。不订阅时行为不变;旧宿主不发 `round.pending`,旧行为不变。
  // 1.11.0(minor,纯增量;应用文档整页滚动条隐藏)——SDK 加载后往应用文档注入一段只作用于文档级
  // (html/body)的样式隐藏滚动条,滚动能力保留;应用内部容器的滚动条不受影响。
  // 见下方 injectDocumentScrollbarStyle。
  var SDK_VERSION = '1.11.0';

  function timeoutForMethod(method) {
    if (method === 'data.submit') return SUBMIT_REQUEST_TIMEOUT_MS;
    if (method === 'data.save' || method === 'data.rollback') return SAVE_ROLLBACK_REQUEST_TIMEOUT_MS;
    // plan.create/plan.restart **不设超时**(返回 0,
    // request() 据此不起计时器)。
    //
    // 这两个调用在桥侧真正发出网络请求之前,会先 await 宿主的授权框 —— 时长由**人什么时候
    // 点按钮**界定,不由网络界定,给它安一个秒数没有任何依据可循。初版复用了 submit 的
    // 750s,结果是宿主侧不得不再配一个更小的框超时来抢在它前面结算,两个数字互相咬着,
    // —— 是在解决自己制造的问题。
    //
    // 不设超时是安全的,因为这个 Promise 已经被真实生命周期事件兜住:用户做决定 / 面板关闭
    // 或会话切换(宿主结算悬空的 confirm Promise,回 USER_REJECTED)/ iframe 销毁(整个 SDK
    // 一起没了)。而「用户开着框一直不动」本身是自洽状态 —— 应用在等、用户在看,没有东西坏掉。
    // 网络那一段仍有宿主侧 30s 显式超时,「宿主必先结算」在网络层照旧成立。
    if (method === 'plan.create' || method === 'plan.restart') return 0;
    return REQUEST_TIMEOUT_MS;
  }

  // retryAfter 钳制 —— 非法/NaN 落回退避兜底值,否则夹到 [0, MAX_RATE_LIMIT_RETRY_S]。
  function clampRetryAfterSeconds(value) {
    if (typeof value !== 'number' || isNaN(value)) {
      return DEFAULT_RATE_LIMIT_RETRY_S;
    }
    return Math.min(Math.max(0, value), MAX_RATE_LIMIT_RETRY_S);
  }

  // ------------------------------------------------------------------
  // 错误工具:统一构造带 code/payload 的 Error 对象
  // ------------------------------------------------------------------

  function makeError(code, message, payload) {
    var err = new Error(message || code || 'sandbox sdk error');
    err.code = code || 'INTERNAL';
    if (payload !== undefined) {
      err.payload = payload;
    }
    return err;
  }

  // 从 BridgeError payload 中提取错误分类,供调用方做重试/刷新/拒绝决策。
  function getErrorCategory(err) {
    return (err && err.payload && err.payload.category) || null;
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // defineRound 的 name 是裸 bracket 赋值进 handlerRegistry /
  // roundRegistry 的(见下方 defineRound),不像旧 submit() 那样有 hasOwn() 那道闸
  // 兜底"未注册"语义——name 若传危险 key,bracket 赋值会触发原型链的特殊行为而不是
  // 产生一个普通的 own 属性,校验必须在 defineRound 里显式挡在赋值之前。用字符串
  // 直接比较而不是 `{ '__proto__': true }` 这种查表写法——对象字面量里的 `__proto__`
  // 键本身就会被解释成设置原型而不是普通 own 属性,查表法会踩到同一个坑。
  function isUnsafeRoundName(name) {
    return name === '__proto__' || name === 'constructor' || name === 'prototype';
  }

  // 深拷贝:数据全程走 JSON 桥,JSON 往返即可满足语义(不含函数/循环引用)。
  function deepClone(value) {
    if (value === undefined) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(value));
  }

  // ------------------------------------------------------------------
  // 环境探测与收发通道
  // ------------------------------------------------------------------

  function isNativeTransport() {
    return !!(
      window.ReactNativeWebView &&
      typeof window.ReactNativeWebView.postMessage === 'function'
    );
  }

  function detectAppId() {
    try {
      if (window.location && window.location.search) {
        var match = /[?&]appId=([^&]+)/.exec(window.location.search);
        if (match) {
          return decodeURIComponent(match[1]);
        }
      }
    } catch (e) {
      // 忽略:无 location 或解析失败时退化为空串
    }
    return '';
  }

  var env = {
    platform: isNativeTransport() ? 'native' : 'web',
    appId: detectAppId(),
  };

  function sendToHost(msg) {
    var text = JSON.stringify(msg);
    if (isNativeTransport()) {
      window.ReactNativeWebView.postMessage(text);
      return;
    }
    if (!window.parent || typeof window.parent.postMessage !== 'function') {
      throw makeError('INTERNAL', 'no host transport available (window.parent.postMessage missing)');
    }
    window.parent.postMessage(text, '*');
  }

  // ------------------------------------------------------------------
  // dev 告警:仅 dev 生效。宿主可在注入 sdk.js 前设置 window.__DEV__(RN 约定),
  // web iframe 场景同理由宿主 bootstrap 脚本设置;未设置一律视为生产环境,静默。
  // ------------------------------------------------------------------

  function isDevMode() {
    try {
      return window.__DEV__ === true;
    } catch (e) {
      return false;
    }
  }

  function warnDev(message) {
    if (isDevMode() && typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[paranovell sdk] ' + message);
    }
  }

  // ------------------------------------------------------------------
  // RPC 层:自增 id、pending map、10s 超时
  // ------------------------------------------------------------------

  var nextRequestId = 0;
  var pendingRequests = {};

  function request(method, params) {
    // id 必须是 string —— 宿主桥严格校验类型,数字 id 会被静默丢弃(安全基线)。
    var id = 'sdk-' + (++nextRequestId);
    var msg = { id: id, type: 'request', method: method };
    if (params !== undefined) {
      msg.params = params;
    }
    return new Promise(function (resolve, reject) {
      // timeoutForMethod 返回 0 = 该方法不设 deadline(目前只有 plan.create/plan.restart,
      // 理由见 timeoutForMethod 内注释)。此时不起计时器,timer 记 null;下方结算路径统一
      // 走 clearTimeout(entry.timer),clearTimeout(null) 是无害 no-op,不需要额外分支。
      var timeoutMs = timeoutForMethod(method);
      var entry = {
        resolve: resolve,
        reject: reject,
        timer: null,
        // 刷新后在途回合(1.9.0):供 extendPendingPullTimeouts 找到在途的 data.pull 并
        // 重新计时(宿主 round.pending 心跳),见其注释。
        method: method,
        timeoutMs: timeoutMs,
        startedAt: Date.now(),
      };
      entry.timer = armRequestTimeout(id, entry);
      var timer = entry.timer;

      pendingRequests[id] = entry;

      try {
        sendToHost(msg);
      } catch (e) {
        clearTimeout(timer);
        delete pendingRequests[id];
        reject(e);
      }
    });
  }

  function armRequestTimeout(id, entry) {
    if (!(entry.timeoutMs > 0)) return null;
    return setTimeout(function () {
      delete pendingRequests[id];
      entry.reject(makeError('TIMEOUT', 'request timed out: ' + entry.method));
    }, entry.timeoutMs);
  }

  // 刷新后在途回合(1.9.0):宿主在
  // 「这一轮正文还在生成、数据要等生成完才能给」时挂起 data.pull,并周期性下发
  // round.pending 作为心跳——每收到一次,把在途 data.pull 的超时重新计满一个窗口,总时长
  // 上限对齐 submit 超时(宿主段 1 最长也只等这么久),不让 ready() 因 20s 默认超时失败。
  var PULL_KEEPALIVE_MAX_MS = SUBMIT_REQUEST_TIMEOUT_MS;
  function extendPendingPullTimeouts() {
    var now = Date.now();
    for (var id in pendingRequests) {
      if (!hasOwn(pendingRequests, id)) continue;
      var entry = pendingRequests[id];
      if (entry.method !== 'data.pull' || !entry.timer) continue;
      if (now - entry.startedAt >= PULL_KEEPALIVE_MAX_MS) continue;
      clearTimeout(entry.timer);
      entry.timer = armRequestTimeout(id, entry);
    }
  }

  function handleIncomingRaw(raw) {
    var msg = raw;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return; // 畸形消息忽略,不崩桥
      }
    }
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (msg.type === 'response') {
      var entry = pendingRequests[msg.id];
      if (!entry) {
        // 未知/已处理过的 id(如 native 同时向 window+document 派发导致的重复回包),忽略即可。
        return;
      }
      delete pendingRequests[msg.id];
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.data);
      } else {
        var errInfo = msg.error || {};
        entry.reject(makeError(errInfo.code, errInfo.message, errInfo.payload));
      }
      return;
    }
    if (msg.type === 'event') {
      // 事件下行通道:event 字段缺失/非字符串视为畸形,静默忽略。
      // native 同时向 window+document 派发同一条消息(见文件头部通信说明)对 response
      // 靠 pendingRequests[id] 去重;event 没有请求-响应配对可依,这里用 msg.id(宿主侧
      // emit() 每次生成的自增 id)做等价去重 —— 两次派发在同一次 injectJavaScript 同步
      // 执行内背靠背到达,中间不会插入其它消息,单槽"上一条已处理 id"足够可靠(带 id 的
      // 第二次到达即判定为回声,消费掉后清空,不影响后续独立事件;宿主未带 id 时退化为
      // 不去重,不引入误判)。
      if (typeof msg.event === 'string' && msg.event) {
        var incomingEventId = msg.id;
        if (incomingEventId !== undefined && incomingEventId === lastDeliveredEventId) {
          lastDeliveredEventId = NO_LAST_EVENT_ID; // 消费这次回声,清空供下一条独立事件使用
          return;
        }
        lastDeliveredEventId = incomingEventId;
        dispatchEvent(msg.event, msg.payload);
      }
    }
    // 其它 type 取值:协议保留,本期不实现任何处理。
  }

  function onBridgeMessage(evt) {
    handleIncomingRaw(evt && evt.data);
  }

  // ------------------------------------------------------------------
  // 事件下行通道:eventType -> 订阅回调数组
  // ------------------------------------------------------------------

  var eventSubscribers = {};
  // 上一条已处理的事件消息 id,供 handleIncomingRaw 的 native window+document 双派发
  // 回声去重(见调用处注释)。哨兵对象(不等于任何真实 id 或 undefined)区分"从未处理过"
  // 与"上一条 id 恰好是 undefined",避免宿主未带 id 时被误判命中去重。
  var NO_LAST_EVENT_ID = {};
  var lastDeliveredEventId = NO_LAST_EVENT_ID;

  // 内部订阅入口:返回取消订阅函数。多订阅者逐个隔离调用 —— 用 slice() 快照订阅列表
  // (防止回调内增删订阅导致下标错位,与 mock-host.js callListeners 同款防御),单个
  // 回调抛出的异常只记 dev 告警,不得中断其余回调、不得冒泡到桥/宿主。
  function __onEvent(eventType, cb) {
    if (typeof eventType !== 'string' || !eventType) {
      throw new TypeError('paranovell.__onEvent: eventType must be a non-empty string');
    }
    if (typeof cb !== 'function') {
      throw new TypeError('paranovell.__onEvent: cb must be a function');
    }
    if (!hasOwn(eventSubscribers, eventType)) {
      eventSubscribers[eventType] = [];
    }
    eventSubscribers[eventType].push(cb);
    return function unsubscribe() {
      var list = eventSubscribers[eventType];
      if (!list) return;
      var idx = list.indexOf(cb);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  function dispatchEvent(eventType, payload) {
    var list = eventSubscribers[eventType];
    if (!list || list.length === 0) return;
    var snapshot = list.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](payload);
      } catch (e) {
        warnDev('event subscriber for "' + eventType + '" threw: ' + (e && e.message));
      }
    }
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', onBridgeMessage);
  }
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('message', onBridgeMessage);
  }

  // ------------------------------------------------------------------
  // 版本漂移自检:shim(应用包内的 sdk.js 入口)在
  // 上传那一刻把中心 SDK 的精确版本烧进 window.__PARANOVELL_SDK_BUILT_AGAINST。
  // 真 SDK 起来后与自身 SDK_VERSION
  // 比对,不一致说明这个应用是按旧版 SDK 打的包,但线上 v1 通道已经打了补丁(v1 内部
  // 持续更新,存量应用下次打开自动吃到最新字节)。只上报,不阻断运行
  // (中心分发下 API 只增不改,版本漂移不代表功能已经坏,但漂移统计能在
  // 真正发生破坏性变更前估出影响面,也是排查"升级后哪个应用坏了"的唯一线索)。
  //
  // 上报走**既有**请求/响应桥协议(与 sys.ping 同一信封形状:{id,type:'request',method,
  // params}),不新造协议——宿主侧由宿主桥注册
  // sys.reportSdkVersionDrift 落 console.warn(可观测,不是发出去就丢)。fire-and-forget:
  // 这条上报是诊断信号,不是关键路径,METHOD_NOT_FOUND(宿主未升级到能处理这个方法的
  // 版本)或网络失败都静默吞掉,不重试、不影响 SDK 正常工作。
  function checkSDKVersionDrift() {
    var builtAgainst = window.__PARANOVELL_SDK_BUILT_AGAINST;
    if (typeof builtAgainst !== 'string' || !builtAgainst || builtAgainst === SDK_VERSION) {
      // 未烧录(shim 之外的场景,如本地开发在包根放真 SDK 副本)或版本一致:无需上报。
      return;
    }
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(
        '[paranovell] SDK version drift: this app was packaged against SDK '
          + builtAgainst + ', currently running ' + SDK_VERSION
          + ' (v1 channel has been patched since upload)'
      );
    }
    request('sys.reportSdkVersionDrift', { builtAgainst: builtAgainst, running: SDK_VERSION }).catch(function () {});
  }
  checkSDKVersionDrift();

  // 只隐藏文档级(html/body)滚动条,滚动能力保留。
  // ⚠ 选择器必须限定在 html/body 上:裸的 `::-webkit-scrollbar` 会命中所有元素,
  // 连应用内部 overflow:auto 容器的滚动条也一并隐藏。`scrollbar-width` 不继承,
  // 只作用于 html/body 自身,正是想要的范围。幂等:按 id 去重,重复加载不插两次。
  var DOC_SCROLLBAR_STYLE_ID = 'paranovell-doc-scrollbar-style';
  function injectDocumentScrollbarStyle() {
    try {
      if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return;
      if (typeof document.getElementById === 'function' && document.getElementById(DOC_SCROLLBAR_STYLE_ID)) return;
      var host = document.head || document.documentElement;
      if (!host || typeof host.appendChild !== 'function') return;
      var style = document.createElement('style');
      style.id = DOC_SCROLLBAR_STYLE_ID;
      style.textContent = 'html, body { scrollbar-width: none; }\n'
        + 'html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }';
      host.appendChild(style);
    } catch (e) {}
  }
  injectDocumentScrollbarStyle();

  // ------------------------------------------------------------------
  // ui.* 形态/画布 API:present/setCanvas 走桥请求,getPresentation
  // 纯本地读缓存,onPresentationChange 复用上面的 __onEvent 订阅表。
  // ------------------------------------------------------------------

  var PRESENTATION_CHANGE_EVENT = 'ui.presentationChange';
  // 六种形态白名单,只服务本文件的本地快速失败(UX);桥侧独立维护同一份白名单并
  // 才是权威校验。
  var UI_FORM_WHITELIST = ['split', 'float', 'full', 'mfull', 'mland', 'mdrawer'];

  // 本地缓存:getPresentation() 只读它,不发请求。初始为空,由下方内部
  // 订阅者在收到 ui.presentationChange 事件时更新;首次也可能由 ready() 的 data.pull
  // 响应里的可选 presentation 字段 seed(见 ready() 内的调用处)。
  var uiState = { form: null, canvas: null, scale: 1 };

  function applyPresentationSnapshot(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.form === 'string') uiState.form = payload.form;
    if (payload.canvas === null || typeof payload.canvas === 'string') uiState.canvas = payload.canvas;
    if (typeof payload.scale === 'number' && isFinite(payload.scale)) uiState.scale = payload.scale;
  }

  // 内部订阅:必须在此处(IIFE 初始化阶段,早于任何应用代码有机会调用
  // onPresentationChange())注册,才能保证 eventSubscribers['ui.presentationChange']
  // 列表里这个缓存更新回调排在应用回调之前 —— dispatchEvent 按注册顺序逐个同步调用,
  // 应用回调执行时 uiState 已经是最新值(应用若在自己的回调里同步调 getPresentation(),
  // 不会读到过期缓存)。
  __onEvent(PRESENTATION_CHANGE_EVENT, applyPresentationSnapshot);

  function isValidUiFormKey(value) {
    return typeof value === 'string' && UI_FORM_WHITELIST.indexOf(value) !== -1;
  }

  // present(form):Promise<{applied, degraded, reason?}> —— 走桥请求 ui.present。
  // 本地白名单校验只是 UX(同步快速失败,不占一次网络往返);真正权威校验在桥侧。
  function uiPresent(form) {
    if (!isValidUiFormKey(form)) {
      return Promise.reject(makeError('INVALID_PARAM', 'paranovell.ui.present: unsupported form "' + form + '"'));
    }
    return request('ui.present', { form: form });
  }

  // setCanvas(set):Promise<void> —— 走桥请求 ui.setCanvas,校验失败经 Promise reject
  // 回传(不是同步抛异常,校验失败统一以 Promise 回传)。本地只做粗校验
  // (顶层结构必须是普通对象);比例/bleed 取值域的精确校验留给桥侧权威实现,这里过了
  // 不代表桥一定放行。
  function uiSetCanvas(set) {
    if (!set || typeof set !== 'object' || Array.isArray(set)) {
      return Promise.reject(makeError('INVALID_PARAM', 'paranovell.ui.setCanvas: set must be a plain object'));
    }
    return request('ui.setCanvas', set).then(function () {
      return undefined;
    });
  }

  // getPresentation():{form, canvas, scale} —— 纯本地读缓存,绝不发请求。
  function getPresentation() {
    return { form: uiState.form, canvas: uiState.canvas, scale: uiState.scale };
  }

  // onPresentationChange(cb):任何形态变化都回调,不只是降级 —— 直接复用
  // __onEvent 的通用订阅/退订/异常隔离语义,不重新实现一套。
  function onPresentationChange(cb) {
    return __onEvent(PRESENTATION_CHANGE_EVENT, cb);
  }

  // ------------------------------------------------------------------
  // 语言(locale)API:defineRound 会替开发者拼一句给模型看的
  // 引导语(LEAD_IN,见下方 "回合 API" 段的 buildOutputNotes),这句话下沉到 SDK 之后
  // 就不再由应用作者控制语言,SDK 因此需要知道当前用户在用哪种语言。
  //
  // 传播路径两条,应用侧零主动查询:
  //   1. 启动:搭 ready() 现成的那次 data.pull,回包带 locale 字段,applyPullResponse
  //      里消费(见下方 ready() 段)。
  //   2. 变化:宿主推 sys.languageChange 事件(payload 形如 { locale: 'en' }),下方
  //      handleLanguageChangeEvent 复用既有 __onEvent 订阅表更新内部状态。
  //
  // 语义细则:
  //   - 默认 'zh',ready() 之前调 getLanguage() 也返回 'zh',不抛错。
  //   - 白名单:宿主推来或 pull 回包里的值不在 {'zh','en'} 内 → 忽略,保持当前值,不抛错
  //     ——SDK 不信任 wire 上的值,与既有做法一致。
  //   - setLanguage() 是锁定:调用之后忽略宿主推送(不可撤销)。
  //   - onLanguageChange 只在生效值确有变化时触发(经 setLanguage 造成的变化也触发,
  //     订阅者可能不是调用方)。
  // ------------------------------------------------------------------

  var LANGUAGE_WHITELIST = ['zh', 'en'];
  var DEFAULT_LANGUAGE = 'zh';
  var LEAD_IN_BY_LANGUAGE = { zh: '举个例子:', en: 'For example: ' };
  // 宿主推送该事件通知语言变化,payload 形如 { locale: 'en' }(与 data.pull 回包的
  // locale 字段同名;本文件不依赖宿主的具体实现,只约定字段名)。
  var LANGUAGE_CHANGE_EVENT = 'sys.languageChange';
  // 应用侧 onLanguageChange() 订阅的内部通知 key —— 与上面宿主推送用的 key 刻意分开:
  // 白名单过滤 / setLanguage 锁定 / 去重(只在确有变化时触发)都必须先在
  // handleLanguageChangeEvent 里做完,再决定要不要通知应用订阅者;若两者共用同一个 key,
  // dispatchEvent 会把宿主的原始 payload 不经处理地直接喂给应用订阅者,绕过以上全部
  // 校验。复用的仍是同一份 __onEvent/eventSubscribers/dispatchEvent 机制,只是多开
  // 一个 key,不是另造一套订阅逻辑。
  var LANGUAGE_CHANGE_NOTIFY_EVENT = 'paranovell.languageChanged';

  var languageState = DEFAULT_LANGUAGE;
  var languageLocked = false; // setLanguage() 调用后置真,此后忽略宿主推送(不可撤销)

  function isValidLanguage(value) {
    return typeof value === 'string' && LANGUAGE_WHITELIST.indexOf(value) !== -1;
  }

  // 落地一次语言变化:只在真的变了时更新状态并通知 onLanguageChange 订阅者。
  function commitLanguage(next) {
    if (next === languageState) return;
    languageState = next;
    dispatchEvent(LANGUAGE_CHANGE_NOTIFY_EVENT, languageState);
  }

  // 应用于任何"来自 wire"的语言值(pull 回包的 locale 字段、宿主推送事件皆走这里):
  // 锁定后忽略;非白名单值忽略;都不抛错。
  function applyIncomingLanguage(value) {
    if (languageLocked) return;
    if (!isValidLanguage(value)) return;
    commitLanguage(value);
  }

  function handleLanguageChangeEvent(payload) {
    var value = payload && typeof payload === 'object' ? payload.locale : payload;
    applyIncomingLanguage(value);
  }

  __onEvent(LANGUAGE_CHANGE_EVENT, handleLanguageChangeEvent);

  // getLanguage():同步读当前语言,默认 'zh',ready() 之前调用也不抛错。
  function getLanguage() {
    return languageState;
  }

  // setLanguage(lang):显式覆盖并锁定 —— 此后忽略宿主推送。非法值同步抛 TypeError
  // (与 SDK 既有校验风格一致)。
  function setLanguage(lang) {
    if (!isValidLanguage(lang)) {
      throw new TypeError('paranovell.setLanguage: lang must be one of ' + LANGUAGE_WHITELIST.join('/'));
    }
    languageLocked = true;
    commitLanguage(lang);
  }

  // onLanguageChange(cb):直接复用 __onEvent 的通用订阅/退订/异常隔离语义,不重新
  // 实现一套(与 onPresentationChange 同款写法);订阅的是上面的"内部通知" key,只在
  // 语言真的变化时才会被 dispatchEvent 调到(见 commitLanguage)。
  function onLanguageChange(cb) {
    return __onEvent(LANGUAGE_CHANGE_NOTIFY_EVENT, cb);
  }

  // languageLeadIn():LEAD_IN —— 在 send 时按当时语言取,不在 define
  // 时定死(切语言后下一次 send 立刻生效,不需要重新 defineRound)。
  function languageLeadIn() {
    return LEAD_IN_BY_LANGUAGE[languageState] || LEAD_IN_BY_LANGUAGE[DEFAULT_LANGUAGE];
  }

  // ------------------------------------------------------------------
  // 悬停放大探测上报:sandbox iframe 是
  // opaque origin,宿主对 iframe 内容区的指针事件彻底失明(含 mouseenter,已实证:同一
  // 页面同样鼠标轨迹,sandbox iframe 容器收到的宿主侧 JS 事件为 0,CSS :hover 也不命中)
  // ——任何"宿主侧探测指针是否在面板矩形内"的方案都不可能成立,只有 iframe 内部的 SDK
  // 自己看得到指针何时进入。这里在自己的文档上监听指针活动,通过既有 postMessage 通道
  // 节流上报给宿主,宿主据此触发放大——对应用开发者完全透明(平台注入,不暴露任何公开
  // API,不需要应用写任何代码,不走 window.paranovell.ui 挂载的公开方法)。这是进入判定
  // **唯一**的通道——宿主侧原来兜底的几何接近区(floatApproachRect)已删除,不再有几何
  // 兜底能顶一下,可靠性比以前更关键。
  //
  // 三条实测硬事实(真实浏览器 A/B 实验实证,决定了下面必须
  // 用 mousemove 驱动、而不是 enter/leave 驱动):
  //   1. pointerenter/mouseenter 在 opaque origin 的 sandbox iframe 内**一辈子只触发一次
  //      **——不是"去重标志没写对"的问题,是浏览器对这个子文档本身只派发一次这类事件,
  //      即便指针后续反复离开又进入,enter 也不会再来第二次。上一版无论怎么改去重策略
  //      (从"靠 leave 复位"改成"微任务级复位")都治不好,因为坏的不是去重逻辑,是事件
  //      源头本身不会再来第二次。
  //   2. pointerleave/mouseleave **从不触发**——指针一移出面板矩形就进入了父页面地盘,
  //      子文档永远收不到"离开"通知,内部状态因此永远停留在"指针还在我这儿"。旧实现
  //      靠这两个事件复位长期标志 `pointerInsideReported`,这个前提从根上就不成立。
  //   3. mousemove 是三者中唯一可靠、指针每次在应用内移动都照常触发的信号。
  // 结论:enter 类事件只能当一次性的首帧加速,不能是判定通道的主体;判定通道必须换成
  // mousemove/pointermove 驱动、纯时间戳节流上报,且**不依赖任何跨调用的长期状态**——
  // 旧实现的 `pointerInsideReported` 正是这样一个可能被永久卡住的长期标志,卡住即等于
  // 功能永久失效,这正是用户反复反馈"第一次进入放大之后永久失效"的根因。已删除该标志,
  // 改成下面的纯时间戳节流:每次 mousemove 只看"距上次上报过了多久",不看任何"是否已经
  // 上报过"的旧状态,天然无状态、幂等、自愈——不存在"卡死后再也不触发"的路径。
  //
  // document.documentElement || document:优先挂在 <html> 上(有真实几何边界,是检测
  // "指针在整个页面内活动"的常见写法);document 本身做兜底(headless/无 DOM 的测试环境
  // 里更常见,typeof 保护避免抛异常)。
  // ------------------------------------------------------------------

  var lastPointerReportAt = 0;

  function reportPointerInside() {
    var now = (typeof Date !== 'undefined' && typeof Date.now === 'function') ? Date.now() : 0;
    if (now - lastPointerReportAt < POINTER_REPORT_THROTTLE_MS) return;
    lastPointerReportAt = now;
    // fire-and-forget:这条上报是锦上添花的 UX 信号,不是关键路径——RATE_LIMITED/TIMEOUT
    // 等失败静默吞掉,不重试、不告警应用(节流窗口一到,下一次 mousemove 会自然重新
    // 上报,不需要任何重试逻辑兜底)。
    request('ui.pointerEnter', {}).catch(function () {});
  }

  (function attachPointerReportWatcher() {
    var root = (typeof document !== 'undefined' && document)
      ? (document.documentElement || document)
      : null;
    if (!root || typeof root.addEventListener !== 'function') return;
    // 主路径:mousemove/pointermove 节流上报(硬事实 3)——两个事件都监听(标准 Pointer
    // Events 优先,mouseevent 兜底不支持前者的环境);`reportPointerInside` 内部按时间戳
    // 去重,两路事件同一 tick 内背靠背触发也只会真正上报一次(节流窗口内的第二次调用
    // 直接 return)。
    root.addEventListener('pointermove', reportPointerInside);
    root.addEventListener('mousemove', reportPointerInside);
    // enter 类事件保留,仅作首帧加速——指针第一次进入时能比等第一个 move 事件早一点点
    // 触发放大,复用同一个节流函数,不另起一套上报路径、不引入新状态。**不得**依赖它作为
    // 唯一或主要来源(硬事实 1:它一辈子只触发一次,后续的离开/再进入完全指望不上它)。
    root.addEventListener('pointerenter', reportPointerInside);
    root.addEventListener('mouseenter', reportPointerInside);
    // leave 类事件已删除,不再监听 pointerleave/mouseleave——硬事实 2 已实证它们在
    // opaque origin sandbox iframe 场景下从不触发,旧实现留着它们只是两段永远不会执行的
    // 死代码(靠它们复位的 `pointerInsideReported` 标志本身也已随之删除),继续留着只会
    // 让后人误以为这里在工作。
  })();

  // ------------------------------------------------------------------
  // 键盘弹出时宿主不缩放沙盒应用——
  // SDK 上报焦点元素的几何位置(`ui.focusRect`),宿主按"刚好让输入框露出来"的距离平移
  // 面板。宿主侧如何用这份上报(持续维护的可视高度
  // 基线 + 焦点门控,不是"拍快照冻结"),这里只记落地时的几条硬约束:
  //
  // 🔴 只报几何,绝不报输入框里的值(隐私边界,用户点名)——上行 params 恰为
  //   `{ rect: {top,left,width,height} | null }`,不得出现 `value`/`text`/`target`/
  //   `name`/`id`/`placeholder` 等任何可能携带内容的字段。`currentFocusRect()` 显式只从
  //   `getBoundingClientRect()` 摘那四个数值字段,不整体透传/展开这个 DOMRect(它还带
  //   `right`/`bottom`/`x`/`y` 等多余字段,一并透传会破坏"key 集合恰为那四个"这条契约,
  //   这条约束有测试用例钉住)。
  //
  // 触发源:focusin/focusout(rect=null)/ scroll / visualViewport.resize,外加
  //   聚焦期间的定时重报(应对"没有任何几何变化,但宿主需要知道这份焦点上报仍然新鲜"这条
  //   心跳语义——宿主侧靠"距上次上报超过焦点门控的过期时限"清掉门控,见宿主侧视口处理;
  //   这条心跳不再承担自愈职责,见上方 FOCUS_REPORT_HEARTBEAT_MS 声明处的说明)。
  //   全部走与 B 主路径同款的无状态时间戳节流(FOCUS_REPORT_HEARTBEAT_MS),不靠任何跨
  //   调用的长期状态判断"是否已经报过"——这条范式是本仓踩出来的(见上面 B 主路径"三条
  //   实测硬事实":`pointerenter` 在这个 opaque origin sandbox iframe 里一辈子只触发
  //   一次、`pointerleave` 从不触发,`focusin`/`focusout` 是否会有同样的坑没有实测过,
  //   不能假定它俩就一定正常成对触发,所以同样按无状态节流处理,不依赖"focusout 一定会
  //   来"这个假设来复位状态——心跳定时重报正是这份不信任的落地)。
  //
  // fire-and-forget + 全吞错误:与 `reportPointerInside` 同一先例——这条上报是
  //   UX 辅助信号,不是关键路径,METHOD_NOT_FOUND(老宿主缓存,未接上 ui.focusRect)/
  //   RATE_LIMITED / INTERNAL 等任何错误码都不重试、不告警应用。
  //
  // native 门控:同一份 sdk.js 也跑在 native WebView 里,焦点上报只服务
  //   web 端的键盘平移问题(native 有自己的键盘策略),`env.platform !== 'web'` 时整个
  //   监听器不挂载,native 上每次聚焦不会白白多一次 RPC 往返。
  // ------------------------------------------------------------------

  var lastFocusReportAt = 0;
  var focusedElement = null;
  var focusHeartbeatTimer = null;

  function currentFocusRect() {
    if (!focusedElement || typeof focusedElement.getBoundingClientRect !== 'function') return null;
    var r = focusedElement.getBoundingClientRect();
    // 🔴 只摘几何四个字段,不整体透传 DOMRect(见上方文件头硬约束)。
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  // `force` = 这是一次**状态转移**(换了焦点元素 / 失焦清空),不是一次几何采样。
  // ⚠ 转移必须绕过节流,采样才走节流。理由:节流窗口(800ms)本是为 scroll/resize/心跳
  //   这类高频**幂等采样**准备的,把它套在转移上会吞掉语义信号 ——
  //   - 失焦清空被吞 ⇒ 宿主收不到「停止平移」,只能等到焦点门控的过期时限自动清掉
  //     (2000ms),键盘都收起 2s 了面板还吊在半空。那条过期时限是给异常路径
  //     (应用换页、iOS 点「完成」不派发 focusout)准备的兜底,不是正常失焦的主路径——
  //     正常失焦应该立即让宿主停止平移,不必等超时。
  //   - 切换输入框时新元素的 rect 被吞 ⇒ 平移要等到下一次心跳才跟上(最长 800ms),
  //     而「点另一个输入框、点表情再点回来」恰恰是聊天类应用里最常见的操作。
  //   同一元素上重复触发的 focusin 不算转移(见 handleFocusIn 的 changed 判定),仍走
  //   节流,所以「强制」不会退化成无节流。
  function reportFocusRect(force) {
    var now = (typeof Date !== 'undefined' && typeof Date.now === 'function') ? Date.now() : 0;
    if (!force && now - lastFocusReportAt < FOCUS_REPORT_HEARTBEAT_MS) return;
    lastFocusReportAt = now;
    request('ui.focusRect', { rect: currentFocusRect() }).catch(function () {});
  }

  (function attachFocusRectWatcher() {
    if (env.platform !== 'web') return; // native 端不上报。
    var root = (typeof document !== 'undefined' && document) ? document : null;
    if (!root || typeof root.addEventListener !== 'function') return;

    function handleFocusIn(evt) {
      var next = (evt && evt.target) || null;
      var changed = next !== focusedElement; // 换了元素才算状态转移,同元素重复聚焦仍走节流
      focusedElement = next;
      reportFocusRect(changed);
      // 聚焦期间定时重报(心跳)——即便焦点元素的几何、visualViewport 都没有任何
      // 变化,也要让宿主持续知道这份焦点上报仍然新鲜(几何新鲜度信号,不是
      // "存活自愈"信号),否则宿主的焦点门控会在用户仍在打字时因过期时限被清掉,
      // 平移在用户没有失焦的情况下被误判着收起。
      if (focusHeartbeatTimer) clearInterval(focusHeartbeatTimer);
      // 显式包一层传 false:心跳是采样不是转移,且不同宿主环境下 setInterval 是否给回调
      // 传参(如某些实现传 lateness)并不统一,裸传函数名有被当成 force 的风险。
      focusHeartbeatTimer = setInterval(function () { reportFocusRect(false); }, FOCUS_REPORT_HEARTBEAT_MS);
    }

    function handleFocusOut() {
      if (!focusedElement) return; // 已经是清空态,重复 focusout 不再发(也防被当成转移绕过节流)
      focusedElement = null;
      if (focusHeartbeatTimer) {
        clearInterval(focusHeartbeatTimer);
        focusHeartbeatTimer = null;
      }
      reportFocusRect(true); // 清空是状态转移,必须绕过节流(见 reportFocusRect 注释)。
    }

    function handleGeometryChange() {
      if (!focusedElement) return; // 未聚焦时几何变化与本上报无关,忽略。
      reportFocusRect(false); // 几何采样,走节流。
    }

    root.addEventListener('focusin', handleFocusIn);
    root.addEventListener('focusout', handleFocusOut);
    // capture:true——元素内部的滚动容器滚动时不冒泡到 document,必须在捕获阶段监听
    // 才能收到(与 scroll 事件不冒泡这一 DOM 标准行为一致)。
    root.addEventListener('scroll', handleGeometryChange, true);
    if (typeof window !== 'undefined' && window.visualViewport
      && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', handleGeometryChange);
    }
  })();

  // ------------------------------------------------------------------
  // 双指缩放手势上报(`ui.viewportGesture`)——「捏合在应用画面上
  // 任意位置都能缩放」,而不是先点按钮进某个模式。
  //
  // 为什么必须由 SDK 来做:沙盒 iframe 是 `allow-scripts` 且**不给** `allow-same-origin`,
  // 跨源文档内部的 touch 事件不会冒泡到宿主 —— 手指落在应用上时宿主一个事件都收不到。
  // 这与 `ui.pointerEnter` 撞的是同一堵墙,解法沿用同一条:应用内部监听、
  // 经桥上报,宿主只拿到"缩放了多少、平移了多少"这两个数,拿不到任何内容。
  //
  // 🔴 单指一律不碰(硬约束):只在 `touches.length >= 2` 时接管并 `preventDefault()`。
  //   这份 sdk.js 由平台集中投递、对**所有已发布应用**立即生效,单指若被误接管,等于
  //   一次性弄坏所有应用的正常交互。判据只有"手指数量"这一条,没有任何启发式。
  //
  // preventDefault 的作用:iOS Safari 会把双指捏合当成**页面级**缩放吃掉,不 preventDefault
  //   宿主这边只能收到半截手势。touchmove 监听器必须 `passive: false` 才允许 preventDefault
  //   (Chrome/Safari 对 document 级 touchmove 默认 passive)。
  //
  // fire-and-forget + 全吞错误:同 reportPointerInside / reportFocusRect 的既有先例,
  //   老宿主(未接 ui.viewportGesture)回 METHOD_NOT_FOUND,静默忽略即可,应用无感。
  // ------------------------------------------------------------------

  // ⚠ 坐标一律取 `screenX/screenY`(设备屏幕坐标),**不能用 `clientX/clientY`**
  //   (真机实测:手机上双指缩放抖动)。
  //
  //   root cause 是一个闭合反馈环:宿主用 `transform: scale()` 缩放整个 iframe,于是
  //   "屏幕位置 → 应用内部坐标"的映射系数**随宿主缩放实时变化**。用 clientX 测量时,
  //   手指一动不动、只要宿主改了缩放,应用内读到的坐标就会变 —— 上报的比值/位移因此
  //   把宿主自己刚施加的缩放又吃进去一遍,宿主再据此调整缩放……闭环震荡,表现为抖动。
  //   (可算出来:用户实际张开 R 倍时,这个环的不动点是 √R,还会一路振铃。)
  //
  //   `screenX/screenY` 是设备屏幕坐标,不受 iframe 自身任何变换影响 —— 测量系与被控量
  //   彻底解耦,环断掉。副产物:上报的 dx/dy 直接就是**屏幕 px**,宿主不用再做任何换算
  //   (换算系数曾经也是这个环的一环)。
  //   `clientX` 兜底仅为极少数不提供 screenX 的环境(以及测试桩)留的,不改变上述结论。
  var gestureActive = false;
  var gestureStart = null; // { dist, cx, cy }(屏幕坐标)
  var lastGestureReportAt = 0;
  // 宿主当前的用户缩放档位(由 `ui.viewportZoom` 事件推下来,见下方订阅)。
  // 只用来决定"单指要不要拿来平移":未放大时单指**必须**完全属于应用。
  var hostViewportZoom = 1;
  var hostGestureEnabled = false;
  // 🔴 宿主是否**启用了缩放层**(同一条事件的 `enabled` 字段)。默认 false = 不接管任何手势。
  //
  // 为什么默认关:这份 sdk.js 对所有宿主、所有已发布应用立即生效,
  // 而缩放层只在**移动端**启用。若无条件接管双指,桌面触屏本 / iPad Safari(宽 ≥768,
  // 宿主判桌面、缩放层根本不开)上的双指手势会被 preventDefault 吃掉、宿主又什么都不做 ——
  // 用户白白失去一项能力。老宿主(前端未升级、没有这个事件)同理:收不到 enabled 就永不接管,
  // 行为与升级前逐字相同。
  // 单指平移的起手判定:落指时不接管(否则点击/轻扫会被吃掉),位移越过阈值才认作拖动。
  var panCandidate = null; // { x, y }(屏幕坐标)
  var PAN_START_THRESHOLD_PX = 6;

  function touchPoint(t) {
    var x = typeof t.screenX === 'number' ? t.screenX : t.clientX;
    var y = typeof t.screenY === 'number' ? t.screenY : t.clientY;
    return { x: x, y: y };
  }

  function touchCentroid(touches) {
    var a = touchPoint(touches[0]);
    var b = touchPoint(touches[1]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function touchSpread(touches) {
    var a = touchPoint(touches[0]);
    var b = touchPoint(touches[1]);
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function reportGesture(phase, scale, dx, dy) {
    request('ui.viewportGesture', { phase: phase, scale: scale, dx: dx, dy: dy }).catch(function () {});
  }

  /**
   * 放大态下单指的归属裁决。
   *
   * 【为什么不是"单指一律平移"】放大之后应用内部往往还有要上下滑的内容,单指全被征用
   * 为画布平移,那些内容就再也滑不动了。
   *
   * 【为什么顺序是"先滚、到底再平移",不能反过来】Web 上一次手势内**只能单向交棒**:
   *   - 不 preventDefault → 原生滚动跑起来 → 后续 touchmove 被标成不可取消,SDK 再想
   *     接管也拦不住;
   *   - preventDefault 掐断原生滚动 → 同一次手势内再也恢复不了。
   * 所以只有"先让原生滚、到边界后 SDK 再开始上报平移"这一条路走得通 —— 而且它顺带
   * 保住了滚动的惯性与橡皮筋(那一段完全是浏览器自己在滚),这正是"全程接管"方案
   * (SDK 手动 scrollTop+=)做不到的。
   */
  var scrollDelegate = null;   // 本次手势里"应用自己的滚动容器",null = 没有/被 panLock 跳过
  var injectedPan = null;      // { x, y, startedAt } 到边界后累积的平移量(绝对量,协议要求)
  var lastPanPoint = null;     // 上一帧的触点,用来算逐帧增量
  var hostPanLock = false;     // 宿主的「平移」开关(C):开着就跳过裁决,单指一律平移

  /** 这个元素在给定轴向上还能不能继续滚(delta>0 = 手指往正方向移 = 内容往回滚)。 */
  function canScrollFurther(el, axis, delta) {
    if (!el || !delta) return false;
    if (axis === 'y') {
      if (el.scrollHeight - el.clientHeight <= 1) return false;
      return delta > 0 ? el.scrollTop > 0 : el.scrollTop < el.scrollHeight - el.clientHeight - 1;
    }
    if (el.scrollWidth - el.clientWidth <= 1) return false;
    return delta > 0 ? el.scrollLeft > 0 : el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
  }

  /**
   * 从触点元素往上找最近的可滚动祖先。
   *
   * ⚠ 启发式,覆盖不到用 transform 自己实现滚动的容器 —— 那种会被判成"没有滚动容器"
   * 而落回画布平移(= 改动前的行为,不会更糟),用户可用 C 开关强制平移绕开。
   */
  function findScrollableAncestor(node) {
    var el = node;
    var guard = 0;
    while (el && el.nodeType === 1 && guard++ < 40) {
      var cs = null;
      try { cs = window.getComputedStyle(el); } catch (e) { cs = null; }
      if (cs) {
        var oy = cs.overflowY;
        var ox = cs.overflowX;
        var scrollableY = (oy === 'auto' || oy === 'scroll') && el.scrollHeight - el.clientHeight > 1;
        var scrollableX = (ox === 'auto' || ox === 'scroll') && el.scrollWidth - el.clientWidth > 1;
        if (scrollableY || scrollableX) return el;
      }
      el = el.parentElement;
    }
    // 兜底:文档自身可滚时也算(应用没有独立滚动容器、直接滚 body 的常见写法)。
    var root = (typeof document !== 'undefined') ? (document.scrollingElement || document.documentElement) : null;
    if (root && root.scrollHeight - root.clientHeight > 1) return root;
    return null;
  }

  /** 到边界后开始注入平移时,给该容器临时关掉滚动链 —— 否则 iOS 会把回弹链给整个页面。 */
  var overscrollSaved = null;
  function lockOverscroll(el) {
    if (!el || !el.style || overscrollSaved) return;
    overscrollSaved = { el: el, value: el.style.overscrollBehavior || '' };
    el.style.overscrollBehavior = 'contain';
  }
  function unlockOverscroll() {
    if (!overscrollSaved) return;
    try { overscrollSaved.el.style.overscrollBehavior = overscrollSaved.value; } catch (e) {}
    overscrollSaved = null;
  }

  /**
   * 本轮是否已经发过 'start' —— 两条路径各有各的标记,收尾判定必须认全:
   *   - 接管式(双指 / branch 2 的整段平移):`gestureActive`;
   *   - 注入式(branch 3 到边界后才开始上报):`injectedPan.startedAt`,它**不置**
   *     `gestureActive`(那面旗子的语义是"我接管了、我会 preventDefault",注入式全程不接管)。
   * ⚠ 早先 handleTouchEnd 与 ui.viewportZoom 复位只认 `gestureActive`,于是注入式
   *   那一路抬手时 endGesture() 根本没被调用 —— 'end' 不发(破坏"每个 start 必有 end"),
   *   更糟的是 lockOverscroll 挂在应用滚动容器上的 `overscroll-behavior: contain`
   *   **永久留着**,缩回 1× 也不还,等于静默改掉了应用未放大时的滚动链行为。
   */
  function gestureReportOpen() {
    return gestureActive || !!(injectedPan && injectedPan.startedAt);
  }

  function endGesture() {
    var wasActive = gestureReportOpen();
    gestureActive = false;
    gestureStart = null;
    panCandidate = null;
    scrollDelegate = null;
    injectedPan = null;
    lastPanPoint = null;
    unlockOverscroll();
    // 只在真的发过 'start' 时才发 'end' —— "每个 start 必有 end"是协议不变式,
    // 但没 start 过就发 end 会让宿主清掉别人的快照。
    if (wasActive) reportGesture('end', 1, 0, 0);
  }

  (function attachViewportGestureWatcher() {
    if (env.platform !== 'web') return; // 与焦点上报同一门控:native 端宿主没有这条通路。
    var root = (typeof document !== 'undefined' && document) ? document : null;
    if (!root || typeof root.addEventListener !== 'function') return;

    function handleTouchStart(evt) {
      var touches = evt && evt.touches;
      if (!touches) return;
      if (!hostGestureEnabled) return; // 宿主没开缩放层:一根手指都不碰(见其声明处 root cause)
      if (touches.length >= 2) {
        var dist = touchSpread(touches);
        if (!(dist > 0)) return; // 两指落在同一点:起手距离为 0,比值会除零,不接管。
        var c = touchCentroid(touches);
        gestureActive = true;
        panCandidate = null;
        gestureStart = { dist: dist, cx: c.x, cy: c.y };
        lastGestureReportAt = 0; // 起手那条必须发出去(宿主据此快照档位),不受节流影响。
        if (typeof evt.preventDefault === 'function') evt.preventDefault();
        reportGesture('start', 1, 0, 0);
        return;
      }
      // 单指:只在**已经放大**时才有资格成为平移手势,且此刻**绝不**接管 ——
      // 先记下落点,等位移越过阈值再说,这样点击/轻点仍然完整地属于应用(不 preventDefault)。
      if (touches.length === 1 && hostViewportZoom > 1.01) {
        panCandidate = touchPoint(touches[0]);
        // 触点下有没有"应用自己的滚动容器"决定这次手势归谁(见 scrollDelegate 文档)。
        // panLock(C 开关)开着时直接判"没有",单指一律平移。
        scrollDelegate = hostPanLock ? null : findScrollableAncestor(evt.target);
        injectedPan = null;
        lastPanPoint = null;
      }
    }

    function handleTouchMove(evt) {
      var touches = evt && evt.touches;
      if (!touches) return;
      if (!hostGestureEnabled) return;

      if (touches.length >= 2 && gestureActive && gestureStart) {
        if (typeof evt.preventDefault === 'function') evt.preventDefault();
        var now = (typeof Date !== 'undefined' && typeof Date.now === 'function') ? Date.now() : 0;
        if (now - lastGestureReportAt < GESTURE_REPORT_THROTTLE_MS) return;
        lastGestureReportAt = now;
        var c = touchCentroid(touches);
        reportGesture('move', touchSpread(touches) / gestureStart.dist, c.x - gestureStart.cx, c.y - gestureStart.cy);
        return;
      }

      if (touches.length !== 1) return;

      // ---- 放大态下的单指:先按"谁能滚谁拿"裁决,到边界后再注入画布平移 ----
      // (设计推理见 scrollDelegate 声明处那段文档)
      // 未放大时 panCandidate 恒为 null,整段不成立 —— 单指完全属于应用,与改动前一致。

      // (1) 已经整段接管为画布平移(panLock 开着,或触点下压根没有可滚容器):老路径。
      if (gestureActive) {
        if (!gestureStart) return;
        if (typeof evt.preventDefault === 'function') evt.preventDefault();
        var nowPan = (typeof Date !== 'undefined' && typeof Date.now === 'function') ? Date.now() : 0;
        if (nowPan - lastGestureReportAt < GESTURE_REPORT_THROTTLE_MS) return;
        lastGestureReportAt = nowPan;
        var p = touchPoint(touches[0]);
        // 单指只平移,不改缩放(scale 恒 1)。
        reportGesture('move', 1, p.x - gestureStart.cx, p.y - gestureStart.cy);
        return;
      }

      if (!panCandidate) return;

      // panLock(C 开关)开着:**从第一条 move 就掐断原生滚动**,不能等越过起手阈值再掐。
      // root cause(用户实测"平移开着还是偶尔会滚应用"):阈值前那几像素里 SDK 什么都不做,
      // 而浏览器判定"这是一次滚动"的余量比 6px 还小 —— 它一旦开滚,后续 touchmove 就被标成
      // 不可取消,下面分支 (2) 那次 preventDefault 变成空操作,手势被应用的滚动容器吃掉。
      // 谁先越过各自的阈值取决于手指多快,所以表现为"偶尔"。掐断的是原生滚动,不影响点击
      // (click 的合成看的是 touchstart/touchend,不看 touchmove),纯点击照样传给应用;
      // 1× 时整段不成立(panCandidate 恒为 null,上一行就返回了),硬约束不受影响。
      //
      // ⚠ 只在 panLock 下提前掐,**不**扩大到"没有可滚容器"那一路:后者的起手阈值内属于
      // "还可能是一次点击",既有用例「已放大 + 纯点击 → 零 preventDefault,点击仍属于应用」
      // 明确钉着这个语义。panLock 是用户手动按下的"单指一律平移",不存在这层犹豫。
      if (hostPanLock && typeof evt.preventDefault === 'function') evt.preventDefault();

      var p0 = touchPoint(touches[0]);
      if (!injectedPan
        && Math.abs(p0.x - panCandidate.x) < PAN_START_THRESHOLD_PX
        && Math.abs(p0.y - panCandidate.y) < PAN_START_THRESHOLD_PX) {
        return; // 还在点击判定范围内:不接管,继续留给应用。
      }

      // (2) 没有可滚容器(或 panLock 强制平移)→ 整段接管,全程 preventDefault。
      if (!scrollDelegate) {
        gestureActive = true;
        gestureStart = { dist: 0, cx: panCandidate.x, cy: panCandidate.y };
        lastGestureReportAt = 0;
        // panLock 那一路上面首帧就掐过了,这里不重复调用(浏览器无害,但读代码时会误以为
        // 有两个独立的掐断点)。
        if (!hostPanLock && typeof evt.preventDefault === 'function') evt.preventDefault();
        reportGesture('start', 1, 0, 0);
        return;
      }

      // (3) 有可滚容器:**全程不 preventDefault**,原生滚动照跑(惯性与橡皮筋都保住);
      //     逐帧问它"这个方向还能滚吗",滚不动的那部分位移才注入为画布平移。
      //     手指反向、容器又能滚了 → 那一帧不再累加,画布停住、列表继续滚,自然来回。
      if (!injectedPan) {
        // 起手方向定**轴锁**,整轮只认这一个轴。
        // root cause:竖向列表几乎都是 scrollWidth === clientWidth,于是
        // `canScrollFurther(el,'x',...)` 恒为 false —— 不锁轴的话,滚列表时手指那 1px 的
        // 横向抖动会被当成"横向已到边界"直接注入,画布随手左右漂,而且每滚一次列表就白白
        // 发一次 'start' + 上一把 overscroll 锁。浏览器自己的触摸滚动也是这么轴锁的,
        // 跟随原生手感,不是发明新规则。
        var adx = Math.abs(p0.x - panCandidate.x);
        var ady = Math.abs(p0.y - panCandidate.y);
        injectedPan = { x: 0, y: 0, startedAt: 0, axis: adx > ady ? 'x' : 'y' };
        lastPanPoint = p0;
        return;
      }
      var fdx = p0.x - lastPanPoint.x;
      var fdy = p0.y - lastPanPoint.y;
      lastPanPoint = p0;
      var axis = injectedPan.axis;
      var fd = axis === 'x' ? fdx : fdy;
      // 锁定轴上容器滚不动了(到边界,或它这个轴压根不可滚)才把位移注入为画布平移。
      if (!canScrollFurther(scrollDelegate, axis, fd)) injectedPan[axis] += fd;
      if (!injectedPan.x && !injectedPan.y) return; // 还全在应用自己的滚动范围内
      if (!injectedPan.startedAt) {
        injectedPan.startedAt = 1;
        lastGestureReportAt = 0;
        lockOverscroll(scrollDelegate); // 防 iOS 把回弹链给整个页面
        reportGesture('start', 1, 0, 0);
      }
      var nowInj = (typeof Date !== 'undefined' && typeof Date.now === 'function') ? Date.now() : 0;
      if (nowInj - lastGestureReportAt < GESTURE_REPORT_THROTTLE_MS) return;
      lastGestureReportAt = nowInj;
      reportGesture('move', 1, injectedPan.x, injectedPan.y);
    }

    function handleTouchEnd(evt) {
      var touches = evt && evt.touches;
      if (touches && touches.length >= 2) {
        // 还剩两指以上:本轮继续,但**必须按现在这两根手指重新配平起手基准** ——
        // 抬走一根后配对的手指变了,沿用旧基准会让比值和中点当场跳一下。
        if (gestureActive) {
          var dist = touchSpread(touches);
          if (dist > 0) {
            var c = touchCentroid(touches);
            gestureStart = { dist: dist, cx: c.x, cy: c.y };
            // 重新配平后,当前档位就是新的"起手档位" —— 让宿主也重新快照一次。
            reportGesture('start', 1, 0, 0);
          }
        }
        return;
      }
      // 双指抬起一根后不退化成单指平移:剩下那根还给应用(要继续平移再重新落指即可),
      // 不去猜"还会不会再落下一根手指"。
      // ⚠ 这里**无条件**走 endGesture(),不能先按 `gestureActive` 提前返回 ——
      // 注入式平移(branch 3)不置那面旗子,提前返回会让它的 overscroll 锁永久泄漏。
      // 纯点击(什么都没发生过)走到这里也安全:endGesture 只在 gestureReportOpen() 为真时
      // 才发 'end',其余部分纯粹是清状态,与原先那条 `panCandidate = null` 等价。
      endGesture();
    }

    // capture:true —— 应用自己用手势库(hammer / interact.js 等)时常在容器上
    // stopPropagation,挂冒泡阶段会被它掐掉,全局捏合随之失效。捕获阶段先到,
    // 且只影响双指路径:单指分支在越过阈值前既不接管也不 preventDefault,硬约束不变。
    root.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
    root.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    root.addEventListener('touchend', handleTouchEnd, true);
    root.addEventListener('touchcancel', handleTouchEnd, true);

    // 🔴 iOS Safari 的捏合**不走 touch 事件**(真机实测「整个页面跟着缩放 +
    // 抽搐」)。它另发一套非标准的 gesturestart/gesturechange/gestureend,上面那些
    // touchmove 的 preventDefault() 对它完全无效 —— 于是同一次捏合被两边消费:
    // Safari 把它当**页面级**缩放(整页放大),SDK 又照常上报给宿主去缩放沙盒,
    // 两套变换各按各的基准叠加,表现就是画面抽搐。
    //
    // 只 preventDefault、不参与计算:双指的缩放量仍由上面的 touch 分支算(iOS 两套事件
    // 是同时派发的),这里单纯把浏览器自己那份吃掉,避免两处各算一遍再打架。
    // 门控与 touch 分支完全一致(hostGestureEnabled):宿主没开缩放层就一根手指都不碰,
    // 页面缩放照旧归浏览器 —— 桌面端/触控本上的应用手势不受影响。
    function handleWebkitGesture(evt) {
      if (!hostGestureEnabled) return;
      if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    }
    root.addEventListener('gesturestart', handleWebkitGesture, { passive: false, capture: true });
    root.addEventListener('gesturechange', handleWebkitGesture, { passive: false, capture: true });
    root.addEventListener('gestureend', handleWebkitGesture, { passive: false, capture: true });
  })();

  /**
   * Chrome / Android 侧的第二道保险:用 CSS `touch-action` 直接声明"这个文档不要捏合缩放"。
   *
   * ⚠ 默认必须是 `pan-x pan-y` 而不是 `none` —— `none` 会把**单指滚动**一起关掉,
   * 而"单指完整属于应用"是这条协议的硬约束,关掉等于一次性弄坏所有已发布应用的滚动。
   * `pan-x pan-y` 只摘掉捏合缩放与双击缩放,滚动照常。
   *
   * 例外是 panLock(C 开关)开着的时候:那正是用户明确要"单指一律平移、忽略应用内部
   * 所有滚动"的场景,此时必须是 `none`。留着 `pan-x pan-y` 的代价见 handleTouchMove 里
   * panLock 那段注释 —— 浏览器会在起手阈值那几像素里先把滚动跑起来,之后 touchmove
   * 被标成不可取消,SDK 的 preventDefault 成了空操作(用户实测"偶尔还是会触发滑轮")。
   *
   * 跟着 hostGestureEnabled 开关走,并记住原值以便宿主收回能力时还原(应用自己可能
   * 设过 touch-action,不能无条件抹成空串)。iOS Safari 不认这个属性,那边靠上面的
   * gesture 事件兜。
   *
   * ⚠ 别把这条当成 panLock 的等价保险:`touch-action` 的生效范围只到**最近一个
   * 自带默认手势行为的祖先**,应用内层那个 `overflow:auto` 容器自己就是滚动容器,挂在
   * `<html>` 上的 `none` 管不到它。panLock 真正的保证是 handleTouchMove 首帧那次
   * preventDefault;这里的 `none` 只对"应用直接滚 body"那种写法额外顶一层,不能删掉首帧那行。
   */
  var savedTouchAction = null;
  function applyHostTouchAction(enabled) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    var el = document.documentElement;
    if (enabled) {
      if (savedTouchAction === null) savedTouchAction = el.style.touchAction || '';
      // `hostViewportZoom > 1.01` 是 SDK 自己的兜底:宿主当前已经用
      // `zoomedIn && panLock` 把过关,但这份 sdk.js 对**所有宿主版本**生效,而
      // `ui.viewportZoom` 其余字段都做了"不信 wire"的校验,这条不该是例外 ——
      // 1× 时置 none 会连单指滚动一起关掉,正是那条硬约束要防的事。
      el.style.touchAction = (hostPanLock && hostViewportZoom > 1.01) ? 'none' : 'pan-x pan-y';
      return;
    }
    if (savedTouchAction !== null) {
      el.style.touchAction = savedTouchAction;
      savedTouchAction = null;
    }
  }

  // 宿主把当前用户缩放档位推下来(`ui.viewportZoom`,payload `{ zoom }`)——SDK 只用它
  // 判断"单指要不要拿来平移"。未放大(zoom≈1)时单指必须完整属于应用,这是硬约束:
  // 这份 sdk.js 对所有已发布应用立即生效,单指被误接管等于一次性弄坏所有应用的交互。
  __onEvent('ui.viewportZoom', function (payload) {
    // 整条 payload 原子校验(与 ui.focusRect 同口径:不信任 wire 上的值,不合法就整条忽略)。
    // ⚠ 早先是"先把 enabled 记下来、再校验 zoom",于是一条 zoom 畸形的消息
    //   也能把手势能力打开 —— 半条生效半条丢弃,是最难查的那种状态。
    if (!payload || typeof payload !== 'object') return;
    var next = payload.zoom;
    if (typeof next !== 'number' || !isFinite(next) || next <= 0) return;
    // `enabled`:宿主声明"我开了缩放层,手势交给你报"。缺字段(老宿主)按 false 处理。
    hostGestureEnabled = payload.enabled === true;
    hostViewportZoom = next;
    // panLock:宿主的「平移」开关。缺字段(老宿主)按 false = 走自动裁决。
    hostPanLock = payload.panLock === true;
    // 与 hostGestureEnabled 同步:开缩放层就摘掉浏览器的捏合缩放,收回就还原(见其文档)。
    applyHostTouchAction(hostGestureEnabled);
    if ((!hostGestureEnabled || next <= 1.01) && gestureReportOpen()) {
      // 缩放被复位(切形态)或宿主收回能力时,在途手势立刻收手,不再挡着应用。
      // ⚠ 早先这里还加了 `gestureStart.dist === 0`(只认单指平移),于是宿主
      //   在**双指捏合进行中**收回能力时收不了手 —— handleTouchMove 下一帧就因
      //   `!hostGestureEnabled` 提前 return,'end' 永远发不出去,宿主侧的起手快照成了悬空
      //   状态(要等下一次 'start' 才自愈)。"每个 start 必有 end"是这条协议的不变式,
      //   不该因为手指数量不同而有例外。
      endGesture();
    }
  });

  // ------------------------------------------------------------------
  // 数据层:内存 KV + 未提交变更 buffer(读内存,写 buffer)+ 回合/存档状态
  // ------------------------------------------------------------------

  var state = {
    data: {},
    revision: 0,
    readonly: false,
    // buffer = 有序操作日志(取代 key 级快照):
    //   [{op:'set',key,value} | {op:'remove',key} | {op:'append',key,value}]
    // 顺序即语义,首版不做同 key 折叠压缩(正确性优先)。
    buffer: [],
    // heldPendingChanges:dispatchSubmitAfterArchive 专用的
    // 独立槽位——只装"submit 失败、回合未开出"那批 pendingChangesOps(见该函数内
    // holdPendingChangesForNextSubmit),按顺序保持;只有 dispatchSubmitAfterArchive
    // 自己读写它(下一次派单时并入新一批 pendingChanges、随即清空),triggerIdleArchive/
    // flushOnHide/archiveSnapshotAndEnqueue 这三条纯存档抽取路径一律不碰它,不会被误当
    // 独立纯存档抢在下一次 submit 之前写到落账线之前。dataPending() 会把它与 state.buffer
    // 一并暴露给应用(保持"未上行的写"这一可观测语义不变)。
    heldPendingChanges: [],
    readyPromise: null,
    readyLoaded: false,
    pullsInFlight: 0,
    roundInFlight: false, // 在途互斥扩窗:submit 发出 → save 确认/失败整段
    roundSaveDispatched: false, // dev 告警场景 2:回合确认 save 已发出、尚未结算
    // 回合恢复(显式不变量):恢复期间等价于 roundInFlight——
    // ready() 见 pendingRound 时把 roundInFlight 置真(见下方 applyPullResponse),挡住
    // 新一轮/纯存档,直到宿主推 round.handback(交还给应用决定)或 round.discard(宿主
    // 已经放弃)。非恢复期(或已交还给应用、等待应用 commit/discard 决定期间)恒为 null;
    // 有值时代表"已交还、应用正在决定"这一态,与"roundInFlight=true 但 recovery 仍为
    // null"(交还事件还没到达/该轮已被宿主自动放弃)区分开。
    recovery: null, // { round, name } | null
    // 时序修正(对抗性时序用例发现):round.handback /
    // round.discard 走 __onEvent 同步派发,但 roundInFlight 只在 data.pull 对应的
    // Promise resolve 之后的下一个微任务(.then(applyPullResponse))才真正置真——
    // Promise.resolve() 本身只是**调度**了 then 回调,不代表回调已经跑完。宿主严格按
    // "先送 pull 响应、再送事件"的顺序发出两条消息,不代表事件一定在 pull 响应的
    // then 回调**跑完**之后才被处理——两者都要经过至少一次微任务调度,谁先谁后不是
    // 消息发出顺序能保证的。见 handleRoundHandback/handleRoundDiscard 与
    // applyPullResponse 的排空逻辑:缓冲 + 排空从根上消灭这个时序依赖,不猜测调度。
    pendingRoundSignal: null, // { type: 'handback'|'discard', round, name?, output? } | null
    // 刷新后在途回合(1.9.0):宿主经 round.pending 预告的 round 号——**只是
    // 预告,不置 roundInFlight**:handback/discard 的缓冲保护依赖"roundInFlight 只由
    // applyPullResponse 按真实 pendingRound 置真"这条结构保证,提前置真会让先到的交还
    // 在空数据上重放。applyPullResponse / ready 失败时清掉。
    roundPendingNotice: null, // number | null
    // onRoundPending 最近一次派发 pending:true 的 round(null = 当前没有"生成中"通知在
    // 生效)——只在翻转时派发,true 恒先于 false。
    roundPendingNotified: null, // number | null
    // 宿主判定"这一轮已死"(5437 身份不符 /
    // 5438 轴已越过,经 round.discard 事件通知)时记下的 round 号——供
    // performRoundConfirmSave 的失败处理分支识别"这次 data.save 失败,是不是因为它所属
    // 的那一轮已经被宿主判死",从而丢弃 merged 而不是放回 buffer(见 processRoundDiscard
    // 与 performRoundConfirmSave 的 REJECTED 分支注释——那里才是这个字段真正解决的问题)。
    // 只在一次新的 data.submit 真正出网时清空(dispatchSubmitAfterArchive)——round 号
    // 会复用(实测确认),旧标记不清空会误伤复用同一数字的全新轮次。
    deadRound: null,
    archive: {
      pendingSnapshot: null, // save()/idle/hide 调用时刻的快照,op 列表,未上行
      resolvers: [], // 折叠进 pendingSnapshot 的所有 save() 调用方,随实际上行统一 resolve/reject
      timer: null, // 节流窗口 / 限流退避定时器
      uploading: false, // 上行请求在途标记(防重入)
      inFlight: null, // 当前在途上行请求的 Promise(恒 resolve,不 reject)——
      // submit() 据此等待纯存档上行结算后再开轮,避免与其在网络层并发出网。
    },
  };

  var idleTimer = null;

  // ------------------------------------------------------------------
  // data.changed 下行事件 —— 宿主在 X-Sandbox-Stale 触发的重新
  // pull 成功后 emit,通知应用"数据已随正文轴回退变更"。收到即整体替换本地 state,
  // 与 DATA_CONFLICT 收敛路径同款写法(全量替换 data/revision、清空 buffer),
  // 不新增语义、不做任何合并。内部订阅在 IIFE 初始化阶段注册(早于任何应用代码),
  // 与 ui.presentationChange 的 applyPresentationSnapshot 同款先序保证。
  // ------------------------------------------------------------------

  var DATA_CHANGED_EVENT = 'data.changed';

  function applyDataChangedEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    state.data = payload.data || {};
    state.revision = typeof payload.revision === 'number' ? payload.revision : state.revision;
    state.buffer = [];
    // heldPendingChanges 里若恰好留着一批"等下一次 submit 重发"的旧写(见
    // dispatchSubmitAfterArchive 的 holdPendingChangesForNextSubmit),它们是基于这次
    // 全量替换之前的旧 data/revision 生成的——与 state.buffer 同款处置,一并作废,否则
    // 下一次 submit 会把这批基于陈旧状态算出的写当作新一批 pendingChanges 悄悄重发。
    state.heldPendingChanges = [];
  }

  __onEvent(DATA_CHANGED_EVENT, applyDataChangedEvent);

  function dataGet(key) {
    if (!hasOwn(state.data, key)) {
      return undefined;
    }
    return deepClone(state.data[key]);
  }

  function dataGetAll() {
    return deepClone(state.data) || {};
  }

  function dataSet(key, value) {
    if (value === null || value === undefined) {
      throw new TypeError('paranovell.data.set: value must not be null or undefined (use remove() to delete a key)');
    }
    if (state.readonly) {
      warnDev('data.set("' + key + '") called while readonly; write will be held in memory but not uploaded until readonly is cleared.');
    }
    if (state.roundSaveDispatched) {
      warnDev('data.set("' + key + '") called after the round-confirm save was dispatched but before it settled; this write will land in the next window, not the current round.');
    }
    var cloned = deepClone(value);
    state.data[key] = cloned;
    state.buffer.push({ op: 'set', key: key, value: deepClone(cloned) });
    scheduleIdleTimer();
  }

  function dataRemove(key) {
    if (state.readonly) {
      warnDev('data.remove("' + key + '") called while readonly; write will be held in memory but not uploaded until readonly is cleared.');
    }
    if (state.roundSaveDispatched) {
      warnDev('data.remove("' + key + '") called after the round-confirm save was dispatched but before it settled; this write will land in the next window, not the current round.');
    }
    delete state.data[key];
    state.buffer.push({ op: 'remove', key: key });
    scheduleIdleTimer();
  }

  // data.append(key, item):对 key 下的数组尾插一条,key 不存在时视为
  // 空数组;buffer 记一条 append op,同步应用到内存(get(key) 立即得到追加后的数组)。
  // item 不可为 undefined(数组元素语义上没有"未定义槽位");目标 key 若已存在且当前值
  // 不是数组,拒绝(防止把结构不明的既有值悄悄拍扁成数组,静默数据损坏)。key 的校验
  // 规则沿用 set()(现状 set() 对 key 本身不做额外类型校验)。
  function dataAppend(key, item) {
    if (item === undefined) {
      throw new TypeError('paranovell.data.append: item must not be undefined');
    }
    var current = hasOwn(state.data, key) ? state.data[key] : undefined;
    if (current !== undefined && !Array.isArray(current)) {
      throw new TypeError('paranovell.data.append: key "' + key + '" holds a non-array value, cannot append');
    }
    if (state.readonly) {
      warnDev('data.append("' + key + '") called while readonly; write will be held in memory but not uploaded until readonly is cleared.');
    }
    if (state.roundSaveDispatched) {
      warnDev('data.append("' + key + '") called after the round-confirm save was dispatched but before it settled; this write will land in the next window, not the current round.');
    }
    var cloned = deepClone(item);
    if (current === undefined) {
      state.data[key] = [cloned];
    } else {
      current.push(cloned);
    }
    state.buffer.push({ op: 'append', key: key, value: cloned });
    scheduleIdleTimer();
  }

  // pending():返回当前 buffer(操作日志)的深拷贝——调用方拿到的是快照,修改它不影响
  // SDK 内部状态(pending() 返回 op 列表拷贝)。heldPendingChanges 里的写
  // 对应用而言同样是"未上行"(只是暂存在 dispatchSubmitAfterArchive 专用槽位,等下一次
  // submit 才出网),必须一并算进 pending()——否则应用会误判这批写已经安全落盘。顺序
  // 拼接:held 里的 op 发生得更早,排在 buffer 前面。
  function dataPending() {
    return deepClone(state.heldPendingChanges.concat(state.buffer));
  }

  // ------------------------------------------------------------------
  // 小工具:op 列表拼接(窗口内多次快照按顺序拼接)、批量 settle
  // ------------------------------------------------------------------

  function resolveAll(list) {
    for (var i = 0; i < list.length; i++) {
      list[i].resolve();
    }
  }

  function rejectAll(list, err) {
    for (var i = 0; i < list.length; i++) {
      list[i].reject(err);
    }
  }

  // ------------------------------------------------------------------
  // 纯存档上行通道(save() / 空闲兜底 / 隐藏 flush 三源共用)
  // ------------------------------------------------------------------

  function cancelArchiveTimer() {
    if (state.archive.timer !== null) {
      clearTimeout(state.archive.timer);
      state.archive.timer = null;
    }
  }

  function cancelIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleTimer() {
    // 无条件重排(debounce):真正的"回合在途抑制"在 triggerIdleArchive 触发时判断,
    // 这里提前判断只是次要优化,不判断也不影响正确性。
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(triggerIdleArchive, ARCHIVE_SAVE_THROTTLE_MS);
  }

  function triggerIdleArchive() {
    idleTimer = null;
    if (state.roundInFlight) {
      // 回合在途抑制:重新排期，防止回合确认窗口内的写入永久丢失空闲兜底定时器。
      // 回合结束后 resumeArchiveUploadIfPending 只检查 pendingSnapshot，不检查 buffer；
      // 此处若不复排，回合确认窗口内 data.set() 写入 buffer 的内容将没有任何定时器接管。
      idleTimer = setTimeout(triggerIdleArchive, ARCHIVE_SAVE_THROTTLE_MS);
      return;
    }
    if (state.buffer.length === 0) {
      return; // 空闲期间没有新写入,无需存档
    }
    // 窗口内多次快照按顺序拼接:pendingSnapshot 里的 op 都发生在 buffer 的 op 之前。
    state.archive.pendingSnapshot = (state.archive.pendingSnapshot || []).concat(state.buffer);
    state.buffer = [];
    cancelArchiveTimer(); // 已经空闲等够 3s,不再排队等窗口,直接尝试上行
    attemptArchiveUpload();
  }

  function scheduleArchiveUpload(delayMs) {
    if (state.archive.timer !== null) {
      return; // 已排期:窗口内多次调用合并进同一次上行,不重置窗口
    }
    state.archive.timer = setTimeout(function () {
      state.archive.timer = null;
      attemptArchiveUpload();
    }, delayMs === undefined ? ARCHIVE_SAVE_THROTTLE_MS : delayMs);
  }

  // roundInFlight 从 true 复位为 false 的每一处收尾都要检查
  // 是否在回合在途期间又攒了新的纯存档快照(save() 在 roundInFlight 时只 sweep 不排期
  // 上行)——不复位检查会让它永久悬空,不能指望"下一次写入才顺带唤醒"。统一收口成
  // 一个helper,由所有 roundInFlight 复位点调用,避免逻辑分散、各自漏一处。
  function resumeArchiveUploadIfPending() {
    if (!state.roundInFlight && hookQuery && hookQuery.offered) { hookQuery = null; }
    if (!state.roundInFlight && state.archive.pendingSnapshot && state.archive.pendingSnapshot.length > 0) {
      scheduleArchiveUpload();
    }
    // 1.9.0:本函数由所有 roundInFlight 复位点调用(见上),恰好也是 onRoundPending
    // "这一轮在 SDK 侧结束"的全部出口——复用同一个收口点,不在各复位处各写一份。
    if (!state.roundInFlight && state.roundPendingNotice === null) {
      notifyRoundPending(false);
    }
  }

  function attemptArchiveUpload() {
    if (state.roundInFlight || hookQuery) {
      return; // 防御性兜底:正常路径下 submit() 已经取消过 timer,不应到达这里
    }
    if (state.readonly) {
      // 只读降级：保留快照以备恢复，但不发起网络请求。
      // pull 失败后触发的降级模式下，缓存中的 revision 可能已经过期，
      // 基于过期快照的 op 不能落盘。
      return;
    }
    if (state.archive.uploading) {
      return;
    }
    if (!state.archive.pendingSnapshot || state.archive.pendingSnapshot.length === 0) {
      // 空快照也可能有待结算的 resolvers——save() 在 buffer/
      // pendingSnapshot 皆空时会经由 save() 自身的早退直接 resolve,不会走到这里;
      // 这里是防御性兜底(理论上此时 resolvers 应恒为空,保持不变式:resolvers 非空
      // 蕴含 pendingSnapshot 非空),命中说明该不变式被打破,也要结算掉,不留悬空 Promise。
      if (state.archive.resolvers.length > 0) {
        var orphanResolvers = state.archive.resolvers;
        state.archive.resolvers = [];
        resolveAll(orphanResolvers);
      }
      return;
    }

    // 上行开始时刻即"截断"当前这批快照与调用方,期间新的 save()/写入落进全新的下一批,
    // 不与本次在途请求混淆(避免用引用相等去判断"上行期间是否有新增"的复杂度)。
    var uploadingSnapshot = state.archive.pendingSnapshot;
    var uploadingResolvers = state.archive.resolvers;
    state.archive.pendingSnapshot = null;
    state.archive.resolvers = [];
    state.archive.uploading = true;

    var changes = uploadingSnapshot; // op 列表本身即 changes,已在写入时深拷贝过
    // 把这次上行的 Promise 记到 state.archive.inFlight——submit()
    // 据此等待纯存档上行结算(成功或失败)后再开轮,避免与之在网络层并发出网。这条 Promise
    // 内部两支都不重新 throw,恒 resolve,submit() 只需一支 .then() 即可续行。
    // anchor = state.revision:纯存档锚点即乐观锁,
    // 后端不匹配回 409 全量替换,匹配则按序应用 + revision+1,故成功后必须回填新 revision
    // (否则下一次纯存档仍带旧 anchor,会被后端当作陈旧锚点持续拒绝)。
    state.archive.inFlight = request('data.save', { changes: changes, anchor: state.revision }).then(
      function (res) {
        state.archive.uploading = false;
        state.archive.inFlight = null;
        state.revision = res && typeof res.revision === 'number' ? res.revision : state.revision;
        resolveAll(uploadingResolvers);
        if (state.archive.pendingSnapshot && !state.roundInFlight) {
          // 上行在途期间又攒了新快照:立即续排,不必再等一个完整 3s 窗口。
          scheduleArchiveUpload(0);
        }
      },
      function (err) {
        state.archive.uploading = false;
        state.archive.inFlight = null;
        if (err && err.code === 'RATE_LIMITED') {
          // 限流对 SDK 是"推迟"不是"失败"——快照与 Promise 都保留,退避重排,不 reject。
          // 顺序拼接:失败的这批 op 发生在时间上更早,排在重新攒起的新快照之前。
          state.archive.pendingSnapshot = uploadingSnapshot.concat(state.archive.pendingSnapshot || []);
          state.archive.resolvers = uploadingResolvers.concat(state.archive.resolvers);
          var retryAfterS = clampRetryAfterSeconds(err.payload && err.payload.retryAfter);
          // 限流退避必须尊重服务端给的 retryAfter,不能被
          // "在途期间新 save() 调用已经排出的默认 3s 窗口定时器"吞掉——scheduleArchiveUpload
          // 的"已排期不重置窗口"守卫是为合并普通写入设计的,这里是退避重排,
          // 语义不同,必须强制取消旧定时器再按 retryAfter 重排。
          cancelArchiveTimer();
          scheduleArchiveUpload(retryAfterS * 1000);
          return;
        }
        if (err && err.code === 'DATA_CONFLICT') {
          var payload = err.payload || {};
          state.data = payload.data || {};
          state.revision = typeof payload.revision === 'number' ? payload.revision : state.revision;
          state.buffer = [];
          // 同上(applyDataChangedEvent)——全量替换收敛时一并作废 heldPendingChanges,
          // 避免基于旧 revision 算出的写在下一次 submit 时悄悄重发。
          state.heldPendingChanges = [];
          var allResolvers = uploadingResolvers.concat(state.archive.resolvers);
          state.archive.pendingSnapshot = null;
          state.archive.resolvers = [];
          rejectAll(allResolvers, err);
          return;
        }
        // 其它可重试失败(SUBMIT_FAILED/TIMEOUT/INTERNAL):失败快照
        // 必须放回 pendingSnapshot 头部(与上面 RATE_LIMITED 分支同款),不能放回 buffer——
        // 在途期间若发生了新的 save() 调用,会把当时的 buffer sweep 进一个全新的
        // pendingSnapshot(uploading 开始时已被置 null),那批"更晚发生"的 op 已经躺在
        // archive.pendingSnapshot 里;若这里把失败快照放回 buffer,下次 sweep 会把
        // pendingSnapshot(新、晚)拼在 buffer(旧、失败重试、早)前面,顺序被打反——
        // 旧值反而覆盖新值,顺序即语义的约定被破坏。顺序拼接:失败批次发生在时间上更早,
        // 理应排在在途期间新攒起的快照之前。reject 这一批调用方——它们的数据未丢(已并入
        // pendingSnapshot),只是这批 Promise 的结局与本次上行尝试共命运;数据本身需要
        // 主动重新排期上行,不能像旧代码那样指望下一次 set()/remove() 才顺带唤醒
        // (否则期间若无新写入,会永久滞留,无定时器接管)。
        state.archive.pendingSnapshot = uploadingSnapshot.concat(state.archive.pendingSnapshot || []);
        rejectAll(uploadingResolvers, err);
        if (!state.roundInFlight) {
          scheduleArchiveUpload();
        }
      }
    );
  }

  function flushOnHide() {
    cancelIdleTimer();
    if (state.roundInFlight) {
      return; // 回合在途抑制;回合结束时的确认 save 会自然吸收当前 buffer
    }
    state.archive.pendingSnapshot = (state.archive.pendingSnapshot || []).concat(state.buffer);
    state.buffer = [];
    if (!state.archive.pendingSnapshot || state.archive.pendingSnapshot.length === 0) {
      return;
    }
    cancelArchiveTimer(); // 隐藏/失焦:不再等窗口,立即 flush
    attemptArchiveUpload();
  }

  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        flushOnHide();
      }
    });
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('blur', flushOnHide);
  }

  // ------------------------------------------------------------------
  // save():纯存档公开 API —— 调用即快照,上行走统一节流通道
  // ------------------------------------------------------------------

  // save() 的"调用即快照 + 挂 resolver"逻辑——sweep 当前 buffer 进 pending 快照,
  // 此后的新写入进下一窗口 buffer,不混入本次;顺序拼接:既有快照的 op 发生在
  // 本次 sweep 的 buffer op 之前。此前这段逻辑与 submit 前置
  // 强制存档(flushArchiveForSubmit)共用,现在 submit 前置存档已退役,唯一调用方只剩 save()。
  // 返回 null 表示 sweep 后仍无待上行内容:没有新写入需要持久化,
  // 已确认态即最新,调用方应直接 resolve,不要把一个永远不会被 attemptArchiveUpload()
  // 结算的 resolver 塞进 state.archive.resolvers(那会导致 Promise 永久悬空)。
  function archiveSnapshotAndEnqueue() {
    state.archive.pendingSnapshot = (state.archive.pendingSnapshot || []).concat(state.buffer);
    state.buffer = [];
    cancelIdleTimer();

    if (state.archive.pendingSnapshot.length === 0) {
      return null;
    }

    return new Promise(function (resolve, reject) {
      state.archive.resolvers.push({ resolve: resolve, reject: reject });
    });
  }

  function save() {
    if (state.readonly) {
      return Promise.reject(makeError('READONLY', 'sandbox data is readonly'));
    }
    var promise = archiveSnapshotAndEnqueue();
    if (promise === null) {
      return Promise.resolve();
    }
    if (!state.roundInFlight) {
      scheduleArchiveUpload();
    }
    // 回合在途:快照已留存、上行抑制,回合确认时一并吸收,或回合结束后由节流通道续行。
    return promise;
  }

  // ------------------------------------------------------------------
  // ready():完成一次 data.pull;若有 pendingRound,不阻塞地把它交还给应用决定
  // (取代早期的"一律回滚";
  // 详见下方"显式交还"段与 applyPullResponse)。SDK 只读 pendingRound.round,
  // 后端仍下发的 output/handler 在 pull 响应里被忽略(真正的 output 由 round.handback
  // 事件携带),不驱动任何前端逻辑。
  // ------------------------------------------------------------------

  // 把「data.pull 响应应用到本地 state」抽成 applyPullResponse,
  // ready() 与强制重拉(STALE 恢复)共用同一份收敛逻辑,不复制语义。
  function applyPullResponse(res) {
    // 无条件清空——必须在下面
    // `if (!pendingRound) return` 这条早退分支**之前**。改前的清空只发生在
    // "这次 pull 确实带 pendingRound"的分支内部,于是"handback/discard 缓冲进
    // pendingRoundSignal → 之后一次*没有* pendingRound 的 pull(普通刷新 / STALE
    // 恢复后闸记录已经不在)先到达"这条路径完全没有清槽的机会:旧信号永久留在槽里,
    // 直到某个复用了同一个 round 号的全新轮次(实测确认 round 号会复用)在未来
    // 某次 pull 里带回同一个数字,就会被错误当成"这次的信号"重放——用**旧**
    // output/name 触发一次错误的交还,若缓冲的是 discard,则直接把新一轮的
    // `roundInFlight` 置假(见 handleRoundDiscard 文档)。信号只可能属于触发它的
    // 那一次 pull,任何后到的 pull 响应(不管这次有没有 pendingRound)都应该让它失效。
    var bufferedRoundSignal = state.pendingRoundSignal;
    state.pendingRoundSignal = null;
    state.data = (res && res.data) || {};
    state.revision = res && typeof res.revision === 'number' ? res.revision : 0;
    state.readonly = !!(res && res.readonly);

    // data.pull 响应可选携带一份初始 presentation 快照(宿主若能在 pull 时就
    // 算出当前呈现即可提前下发),省去应用启动后还要等第一次 present()/宿主事件
    // 才能拿到非空 getPresentation() 的窗口("首次由 ready() 响应...seed",见文件
    // 头 ui.* 段说明);未携带时 uiState 保持初始值,直到第一条事件到达。
    if (res && res.presentation) {
      applyPresentationSnapshot(res.presentation);
    }

    // data.pull 回包可选携带 locale 字段(宿主本地同步取 getLanguage(),不出网)。
    // 走与宿主推送事件同一条校验路径(白名单 + setLanguage 锁定),非法/缺省值静默忽略。
    applyIncomingLanguage(res && res.locale);

    var pendingRound = res && res.pendingRound;
    // 1.9.0:真实数据到了,预告使命结束——有 pendingRound 时下面置 roundInFlight 并保持
    // "生成中"通知;没有(这一轮已在别处结清 / 段 1 失败)则收回通知。
    state.roundPendingNotice = null;
    if (!pendingRound || !(Number.isInteger(pendingRound.round) && pendingRound.round > 0)) {
      if (!state.roundInFlight) notifyRoundPending(false);
      return undefined;
    }
    // 回合恢复(取代早期的"一律回滚"):
    // ready 期见 pendingRound 不再一律 rollback——交还给应用决定,且**不阻塞
    // ready() 本身**:这里只做本地记账,把 roundInFlight 置真挡住新一轮/
    // 纯存档(显式不变量:恢复期间等价于 roundInFlight),不等待任何后续事件就让
    // ready() 立即成功返回。真正的 output 由宿主在后台异步取到后经 round.handback /
    // round.discard 两个事件推送过来(见上方"显式交还"段与 handleRoundHandback /
    // handleRoundDiscard),SDK 这里只读 pendingRound.round 判断"有没有一轮待恢复"。
    //
    // 仍然只读 round,不读 output/handler:旧流程 output 与
    // 壳同时写入,pendingRound.output 是当时唯一能拿到 output 的地方(即便 SDK 从不读
    // 它);新流程壳在正文返回时先写**空壳**,output 由独立端点单独取,pull 里带的这份
    // output 只是后端顺手回填、供人工排障参考的记录,不是数据通路的一部分。
    if (Number.isInteger(pendingRound.round) && pendingRound.round > 0) {
      state.roundInFlight = true;
      notifyRoundPending(true, pendingRound.round);
      // 预告时 round 若与真实 pendingRound 不同(预告窗口内号变了),以真实号为准——
      // 之后 pending:false 的载荷才对得上。
      state.roundPendingNotified = pendingRound.round;
      // deadRound 此前只在新 submit 派发时清空
      // (dispatchSubmit),这个恢复入口不清——与"一轮一标记"的意图不一致:round 号
      // 会复用(已实测确认),上一轮判死时记下的 deadRound 若恰好等于这次恢复的
      // round 号,performRoundConfirmSave 的 REJECTED/耗尽分支会把这次全新恢复轮的
      // 失败误判成"还是那个已判死的轮次",错误地丢弃本该放回 buffer 的 changes。
      state.deadRound = null;
      // 排空可能抢先抵达的 round.handback/round.discard——
      // 见 state.pendingRoundSignal 声明处注释。按 round 号精确匹配,不匹配则直接丢弃,
      // 不猜一个可能错的值——这条分支**不是"理论上不该发生"**(round 号会
      // 复用,缓冲的旧信号完全可能属于同一数字的上一次出现),清空已经在函数入口处
      // 无条件做过,这里只需要按 round 号决定要不要重放。
      // 早期版本曾在这里加过
      // 一条分支——零订阅者时提前自行 rollback,不等宿主的 round.handback 绕一圈。
      // 那条分支建立在"零订阅者 = 没人处理这一轮,不如提前放弃"这个已被
      // 推翻的前提上;默认行为反转成自动重放后,"零订阅者"不再意味着放弃,而是意味着
      // "用已注册的 handler 自动重放"——但重放需要的 handler 名/output 这里根本拿不到
      // (pendingRound 只读 round,不读 handler,见上方注释),没有办法在这个
      // 时间点判断"到底该重放还是该放弃",因此**不再提前做任何决定**,老老实实等宿主的
      // round.handback/round.discard 事件——决定权完全下放给 processRoundHandback
      // (见下方"显式交还"段)。这不是回归:能提前决定的前提(pendingRound 只读 round)从一开始就不
      // 成立,提前 rollback 本就是在"猜"而不是"读"。
      if (bufferedRoundSignal && bufferedRoundSignal.round === pendingRound.round) {
        // 这里**不能**再同步调用 processRoundHandback/
        // processRoundDiscard——见 scheduleBufferedRoundSignalDrain 处的完整推导。改成
        // 挂到 state.readyPromise 结算之后再跑,让"交还恒晚于 ready() resolve"由结构
        // 保证,不靠"宿主多久发一次消息"这种时序运气。
        scheduleBufferedRoundSignalDrain(bufferedRoundSignal);
      }
    }
    return undefined;
  }

  // scheduleBufferedRoundSignalDrain(signal):把上面缓冲排空的实际处理动作
  // 从 applyPullResponse 的同步执行体里挪出来,改为挂在 state.readyPromise 结算之后。
  //
  // 为什么原来的同步调用是缺陷:processRoundHandback 的"零订阅者→自动重放"分支(默认路径)
  // 内部经 runRoundHandler 用 `Promise.resolve().then(handlerFn)` 排一个微任务去跑应用
  // 注册的 handler;`onRoundRecovery` 覆盖路径则更直接——订阅者回调是同步调用。两条路径
  // 都在 applyPullResponse **执行期间**(即 ready() 返回给应用的那个 promise 结算**之前**)
  // 就已经触发/入队,必然抢在应用挂在 `ready()` 上的 `.then(cb)`/`await ready()`(paranovell.d.ts
  // 推荐写法:初始化放在 ready 成功之后)前面跑——把 DOM 引用、闭包状态的初始化放在
  // `await ready()` 之后的应用,handler 会在初始化完成前执行,要么抛错丢一轮,要么读到
  // 未初始化的状态静默算错,违反"交还在 ready() 成功返回后的任意时刻到达"这条约定。
  //
  // 为什么挂到 state.readyPromise 能修好它,而不是新增一次 `.then()` 就够:关键不是"多等
  // 一跳",而是**reaction 的 FIFO 顺序**——同一个 promise 上的多个 `.then()` 按**挂载
  // 顺序**触发。应用照 paranovell.d.ts 推荐写法,会在拿到 `ready()` 的返回值后立即(同一个
  // 同步栈里)`.then(cb)`/`await` 挂载自己的回调;而这个函数的调用点在 applyPullResponse
  // 内部——只有等 data.pull 真正走完一次网络往返(至少一次微任务调度)才会执行,因此这里
  // 对 `state.readyPromise` 追加的 `.then(drain, drain)` 必然**晚于**应用的挂载动作。
  // Promise 的 reaction 队列不看谁先跑完,只看谁先挂上——应用的回调恒先触发,这份 drain
  // 恒排在后面,由 Promise 规范本身保证,不依赖任何具体调度细节。
  //
  // force=true 的 STALE 重拉复用同一份 applyPullResponse,但 force 路径不写
  // state.readyPromise(见 ready() 注释)——这里读到的是此前那次成功 ready() 留下、早已
  // resolve 的 memo promise。这完全正确:STALE 恢复发生在应用已经跑起来之后,不存在
  // "还没 await 完 ready()"这个窗口,挂上去下一微任务就跑,等价于"立即",不需要也不应该
  // 再等谁。
  //
  // readyPromise 结算走 reject 分支要怎么办:既有不变量是
  // "state.readyPromise 非 null 时恒已成功、永久 memo——失败会把它清空(null),不会把
  // 它留成一个已 reject 的 promise"。本函数只会在 applyPullResponse **已经成功执行完**
  // (走到这一行代码,后面只剩 `return undefined`)之后才会被调用,此刻它所在的
  // promise 链必然走向 fulfilled,不存在"先调度了 drain、这个 promise 后来又 reject"的
  // 路径——理论上 onRejected 分支不会被这次调用触发。即便如此仍然显式传两个分支(而不是
  // 只传 onFulfilled),原因是"排空必须仍然发生,不能出现延后之后再也不跑"这条约束不应该
  // 依赖"当前实现细节保证了它只会 fulfill"这个前提长期成立——哪天 ready() 的实现变了
  // (比如 memo 语义被改动),这里不必跟着改也不会退化成"reject 时信号永久卡在
  // 半路":drain 在 settle(不管成功失败)后必然跑一次。
  //
  // state.readyPromise 为 null 时的兜底(理论上不会被公开 API 触发到,但 `ready` 直接
  // 以 `ready: ready` 整个函数对外导出,`force` 参数未写进 d.ts 但技术上可以被应用直接
  // 传入——`sdk.ready(true)` 作为**第一次**调用、从未有过一次成功的非 force ready() 时,
  // state.readyPromise 确实是 null):退化为下一个微任务执行,至少保证排空不丢,不再等待
  // 任何 promise。
  function scheduleBufferedRoundSignalDrain(signal) {
    function drain() {
      try {
        if (signal.type === 'handback') {
          processRoundHandback(signal.round, signal.name, signal.output);
        } else if (signal.type === 'discard') {
          processRoundDiscard(signal.round);
        }
      } catch (e) {
        // drain 挂在独立的 promise 链上(不回流进 state.readyPromise/ready() 本身的链),
        // 这里若不吞掉异常会变成未处理的 promise rejection——与文件里其它 fire-and-forget
        // 分支(如 processRoundHandback 内部的自动 rollback)同款,只留痕不冒泡。
        warnDev('deferred round signal drain ("' + signal.type + '") threw: ' + (e && e.message));
      }
    }
    if (state.readyPromise) {
      state.readyPromise.then(drain, drain);
    } else {
      Promise.resolve().then(drain);
    }
  }

  // ready(force):
  //   force 缺省(false)= 启动语义 —— readyPromise 成功后永久 memo(只在失败时清空,
  //   应用可重调重试),同一会话内再调直接返回缓存的 promise,不再出网。
  //   force=true = STALE 恢复语义 —— 绕过 readyPromise 的 memo(应用既然在跑,
  //   ready() 早就成功过,普通重调是空操作),并给桥带 {force:true} 让 data.pull
  //   跳过 5s 结果缓存(缓存里是轴回退前的旧结果),真正重拉权威态。
  function ready(force) {
    if (!force && state.readyPromise) {
      return state.readyPromise;
    }
    state.pullsInFlight += 1;
    var promise = request('data.pull', force ? { force: true } : {}).then(function (result) {
      state.pullsInFlight -= 1;
      var applied = applyPullResponse(result);
      state.readyLoaded = true;
      return applied;
    }, function (err) {
      state.pullsInFlight -= 1;
      throw err;
    }).catch(function (err) {
      // 1.9.0:数据没拿到,预告的那一轮无从恢复——收回"生成中"通知(roundInFlight 从未因
      // 预告置真,不需要复位,见 state.roundPendingNotice 注释)。
      if (state.roundPendingNotice !== null) {
        state.roundPendingNotice = null;
        if (!state.roundInFlight) notifyRoundPending(false);
      }
      if (!force) {
        // 失败态不永久缓存到 readyPromise——清空后再抛,让应用可以
        // 重新调用 ready() 重试(覆盖 data.pull 本身失败,以及 pendingRound rollback 失败;
        // 成功结果仍走上面的 then 链,永久缓存不受影响)。force 路径不写 readyPromise,
        // 失败即抛,下一次 STALE 恢复仍可再次强制重拉。
        state.readyPromise = null;
      }
      throw err;
    });
    if (!force) {
      state.readyPromise = promise;
    }
    return promise;
  }

  function rollbackRound(round) {
    return request('data.rollback', { round: round }).then(
      function (res) {
        state.data = (res && res.data) || {};
        state.revision = res && typeof res.revision === 'number' ? res.revision : state.revision;
        state.buffer = [];
        state.roundInFlight = false;
        resumeArchiveUploadIfPending(); // 复位处补检查
      },
      function (err) {
        // rollback 请求本身失败(网络/超时等)同样不能让
        // roundInFlight 永久卡死——复位后向上抛,由 ready() 的 catch 收口并允许重试。
        state.roundInFlight = false;
        resumeArchiveUploadIfPending(); // 复位处补检查
        throw err;
      }
    );
  }

  // ------------------------------------------------------------------
  // 回合 API:defineRound(注册表 + 发起函数)—— 取代早期的 on() + submit()
  //
  // 内部复用既有 handlerRegistry(dispatchSubmit 按 handler 名去查函数,见下方)与
  // dispatchSubmit(回合状态机不变)。defineRound 只做三件事:
  //   define 时(一次):1) JSON.stringify(def.format) 当场求值并快照成字符串(fail-fast +
  //   之后原地改 format 对象不影响已上行字节);2) 整份定义(formatString +
  //   notes + example)按 name 存进 roundRegistry,handler 单独存进 handlerRegistry
  //   (dispatchSubmit 的既有查找路径不变);3) 返回一个只闭包了 name 的 sender。
  //   send 时(每次):sender 按 name 现取当前定义,拼好 outputNotes(LEAD_IN 随语言,
  //   在 send 时求值,见上方"语言(locale)API"段),转交 dispatchSubmit。
  //
  // ⚠ sender 只闭包 name、不闭包 format/notes/example(硬要求):否则
  // defineRound(name, 新定义) 之后,旧 sender 会拿着闭包住的旧 format 配新 handler ——
  // 正是本次要消灭的"format/handler drift"从后门爬回来。新旧 sender 永远按 name 现取
  // roundRegistry 里的当前定义,完全等价。
  // ------------------------------------------------------------------

  var handlerRegistry = {};
  var roundRegistry = {}; // name -> { formatString, notes, example }
  var hookDefinition = null;
  var hookQuery = null; // 当前 query 的取消标记，不持久化。
  var HOOK_ARCHIVE_WAIT_MS = 1000;

  // outputNotes 拼装(定死,便于测试与排障):
  //   notes 有 + example 有 → notes + "\n" + LEAD_IN + JSON.stringify(example)
  //   notes 有 + example 无 → notes
  //   notes 无 + example 有 → LEAD_IN + JSON.stringify(example)
  //   notes 无 + example 无 → 不返回(该键不上行,与旧 outputNotes 可选语义一致)
  // 边界:notes 为空串视同未提供 —— 空串对模型零信息量,上行只是白占 token,
  // 且"传了空串"与"没传"在开发者意图上没有可区分的差别。
  function buildOutputNotes(notes, example) {
    var hasNotes = typeof notes === 'string' && notes !== '';
    var hasExample = example !== undefined;
    if (hasNotes && hasExample) {
      return notes + '\n' + languageLeadIn() + JSON.stringify(example);
    }
    if (hasNotes) {
      return notes;
    }
    if (hasExample) {
      return languageLeadIn() + JSON.stringify(example);
    }
    return undefined;
  }

  function validateRoundDefinition(name, def, apiName) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('paranovell.' + apiName + ': name must be a non-empty string');
    }
    // 旧 submit() 靠 hasOwn(handlerRegistry, opts.handler) 挡住
    // 了危险 handler 名的"静默生效"(未登记则拒);defineRound 是裸赋值,这道闸必须挪到
    // 这里显式校验,否则 __proto__ 之类的 name 会一路畅通并污染 Object.prototype。
    if (isUnsafeRoundName(name)) {
      throw new TypeError('paranovell.' + apiName + ': name "' + name + '" is not allowed');
    }
    if (!def || typeof def !== 'object') {
      throw new TypeError('paranovell.' + apiName + ': def must be an object with { format, handler }');
    }
    if (typeof def.handler !== 'function') {
      throw new TypeError('paranovell.' + apiName + ': def.handler must be a function');
    }
    // def.format 不得为 undefined —— JSON.stringify(undefined) 返回 undefined 而
    // 不是字符串,放过去会让 outputFormat 变成非字符串。
    if (def.format === undefined) {
      throw new TypeError('paranovell.' + apiName + ': def.format must not be undefined');
    }
    if (def.notes !== undefined && typeof def.notes !== 'string') {
      throw new TypeError('paranovell.' + apiName + ': def.notes must be a string when provided');
    }

    var formatString;
    try {
      formatString = JSON.stringify(def.format);
    } catch (e) {
      // JSON.stringify 抛错(循环引用等)时包一层再抛,带上方法名 —— 裸的
      // "Converting circular structure to JSON" 看不出是谁的问题。这是错误可读性,
      // 不是校验。
      throw new TypeError('paranovell.' + apiName + ': def.format is not JSON-serializable (' + (e && e.message) + ')');
    }
    if (typeof formatString !== 'string') {
      // function/symbol 等同样序列化不出字符串的边界情形(def.format !== undefined
      // 已排除最常见的那种,这里兜底其余情形)。
      throw new TypeError('paranovell.' + apiName + ': def.format must serialize to a JSON string');
    }
    // example 与 format 同款 fail-fast——不然循环引用的 example
    // 会在用户点了发送那一刻(buildOutputNotes 每次 send 时才 JSON.stringify)抛出裸的
    // "Converting circular structure to JSON",正是要避免的那种。这里只是试跑
    // 序列化探测能否成功,不锁定快照:example 仍按设计在 send 时现取现序列化
    // (不像 format 那样需要在 define 时冻结字节)。
    if (def.example !== undefined) {
      try {
        JSON.stringify(def.example);
      } catch (e) {
        throw new TypeError('paranovell.' + apiName + ': def.example is not JSON-serializable (' + (e && e.message) + ')');
      }
    }

    return formatString;
  }

  // hook 只在 SDK 内注册；每次正文发出前由宿主现问，定义不落本地存储。
  function defineHook(name, def) {
    // 与后端规范化一致，让注册、offer 及恢复 handback 共用同一个 handler 名。
    if (typeof name === 'string') { name = name.trim(); }
    var formatString = validateRoundDefinition(name, def, 'defineHook');
    if (hasOwn(roundRegistry, name)) {
      throw new TypeError('paranovell.defineHook: name is already registered as a round');
    }
    if (typeof def.trigger !== 'string' || !def.trigger.trim()) {
      throw new TypeError('paranovell.defineHook: trigger must be a non-empty string');
    }
    if (def.input !== undefined && typeof def.input !== 'function') {
      throw new TypeError('paranovell.defineHook: input must be a function when provided');
    }
    if (hookDefinition && hookDefinition.name !== name) {
      delete handlerRegistry[hookDefinition.name];
    }
    hookDefinition = { name: name, trigger: def.trigger, formatString: formatString,
      notes: def.notes, example: def.example, input: def.input };
    handlerRegistry[name] = def.handler;
  }

  function handleHookQuery(payload) {
    var queryId = payload && payload.queryId;
    if (typeof queryId !== 'string' || !queryId) { return; }
    if (!hookDefinition || !state.readyLoaded || state.pullsInFlight > 0 || hookQuery || state.readonly || state.roundInFlight || state.roundSaveDispatched || state.recovery) {
      request('round.hookOffer', { queryId: queryId, hook: null }).catch(function () {});
      return;
    }
    var query = { queryId: queryId, cancelled: false, offered: false };
    hookQuery = query;
    // 等待的是已出网存档；期间的新写留在缓冲区，不把它们放进 hook 请求。
    var timer;
    var archiveReady = state.archive.uploading && state.archive.inFlight
      ? Promise.race([
          state.archive.inFlight.then(function () { return true; }, function () { return true; }),
          new Promise(function (resolve) { timer = setTimeout(function () { resolve(false); }, HOOK_ARCHIVE_WAIT_MS); }),
        ])
      : Promise.resolve(true);
    archiveReady.then(function (readyToOffer) {
      if (timer) { clearTimeout(timer); }
      if (query.cancelled || hookQuery !== query) { return; }
      var hook = null;
      if (readyToOffer && state.readyLoaded && state.pullsInFlight === 0 && !state.archive.uploading && !state.roundInFlight && !state.roundSaveDispatched && !state.recovery) {
        try {
          var current = hookDefinition;
          var input = current.input ? current.input() : '';
          if (typeof input !== 'string') { throw new TypeError('paranovell.defineHook: input must return a string'); }
          hook = { name: current.name, trigger: current.trigger, input: input, outputFormat: current.formatString };
          var notes = buildOutputNotes(current.notes, current.example);
          if (notes !== undefined) { hook.outputNotes = notes; }
        } catch (err) {
          warnDev('hook input failed: ' + (err && err.message));
        }
      }
      if (hook) {
        query.offered = true;
        state.roundInFlight = true;
        state.deadRound = null;
        cancelArchiveTimer();
      } else {
        hookQuery = null;
        resumeArchiveUploadIfPending();
      }
      // offer 回包丢失不等于正文未命中；只有宿主 settled 或回合收尾可解除互斥。
      request('round.hookOffer', { queryId: queryId, hook: hook }).catch(function () {});
    });
  }

  function handleHookSettled(payload) {
    if (!hookQuery || !payload || payload.queryId !== hookQuery.queryId || payload.hit !== false) { return; }
    var query = hookQuery;
    query.cancelled = true;
    hookQuery = null;
    if (query.offered) { state.roundInFlight = false; }
    resumeArchiveUploadIfPending();
  }

  function defineRound(name, def) {
    if (hookDefinition && hookDefinition.name === name) {
      throw new TypeError('paranovell.defineRound: name is already registered as a hook');
    }
    var formatString = validateRoundDefinition(name, def, 'defineRound');
    handlerRegistry[name] = def.handler;
    roundRegistry[name] = {
      formatString: formatString,
      notes: def.notes,
      example: def.example,
    };

    return function sender(opts) {
      if (!opts || typeof opts !== 'object') {
        throw new TypeError('paranovell.defineRound("' + name + '"): sender opts must be an object with { input }');
      }
      // input 必须是非空字符串,同步快速失败。
      if (typeof opts.input !== 'string' || !opts.input) {
        throw new TypeError('paranovell.defineRound("' + name + '"): opts.input must be a non-empty string');
      }
      // 按 name 现取当前定义(不是闭包住 define 时那份)—— 见上方 ⚠ 段。
      var current = roundRegistry[name];
      var submitOpts = { input: opts.input, outputFormat: current.formatString, handler: name };
      var outputNotes = buildOutputNotes(current.notes, current.example);
      if (outputNotes !== undefined) {
        submitOpts.outputNotes = outputNotes;
      }
      return dispatchSubmit(submitOpts);
    };
  }

  // dispatchSubmit 是校验通过后的实际派单逻辑,拆出来是为了等待重试
  // (纯存档在途时递归重入)不必重复跑一遍已经通过的参数校验。
  function dispatchSubmit(opts) {
    if (state.readonly) {
      return Promise.reject(makeError('READONLY', 'sandbox data is readonly'));
    }
    if (state.roundInFlight) {
      return Promise.reject(makeError('SUBMIT_IN_FLIGHT', 'a round is already in flight'));
    }

    // 纯存档上行在途时,先等待该次
    // 上行结算(成功或失败),再发 data.submit——避免与它在网络层并发出网,且避免此刻
    // 读到的 state.revision 在其结算之后才被悄悄推进,导致下面挂进请求体的
    // pending_changes.revision 用一个陈旧值撞乐观锁 409(失败兜底虽然能兜住,但
    // 没必要制造这个可预见的冲突)。Promise 链串行等待,不因存档结果 reject 本次
    // submit 调用方。
    if (state.archive.uploading && state.archive.inFlight) {
      return state.archive.inFlight.then(function () {
        return dispatchSubmit(opts);
      });
    }

    return dispatchSubmitAfterArchive(opts);
  }

  function dispatchSubmitAfterArchive(opts) {
    if (state.roundInFlight) {
      return Promise.reject(makeError('SUBMIT_IN_FLIGHT', 'a round is already in flight'));
    }
    // roundInFlight 已经因为 round.discard 复位为
    // false,但上一轮确认 save 的退避重试环(performRoundConfirmSave 的 attempt())
    // 仍未真正收敛(state.roundSaveDispatched 只在某次 attempt 落到终态分支时才会被
    // 置回 false)——这段窗口里放行新一轮 submit 会把 state.deadRound 清空(见下方
    // dispatchSubmitAfterArchive 成功分支),旧重试环因此失去"这一轮已判死"的唯一
    // 线索,继续把死轮 changes 当作新轮的一部分重发。与上面的 roundInFlight 检查同款,
    // 这里只是多覆盖这一段"回合已解卡、但确认 save 的 Promise 链还没跑完"的窗口。
    if (state.roundSaveDispatched) {
      return Promise.reject(makeError('SUBMIT_IN_FLIGHT', 'a previous round confirm save is still retrying'));
    }

    // 取代原"submit 前强制存档一次":不再单独发一次 data.save,
    // 而是把缓冲区里当前未上行的 changes(op 列表)连同发起这一刻的 revision 一起挂进
    // data.submit 的 pending_changes 字段,由后端在本轮内一次写掉——写在这一轮的
    // 落账线**下方**,与这一轮同生共死。
    //
    // 与其它上行通道同款"上行开始时刻即截断"约定:此刻同步把 buffer 取走并清空,
    // 期间(网络往返中)新的 data.set()/remove()/append() 落进全新的下一窗口 buffer,
    // 不与本次已发出的这批混在一起——这也是为什么不需要再保留旧版那条"强制存档
    // 网络往返期间又写入"的 dev 告警:改前那条告警针对的是异步存档留出的窗口,现在
    // buffer 在同一个同步栈内就被截断,没有等价的窗口。
    // heldPendingChanges 装着上一次 submit 失败(回合未开出)那批写(见下方
    // holdPendingChangesForNextSubmit),按顺序拼接在这一次 state.buffer 之前——它们发生
    // 得更早。拼接后立即清空两处来源,与既有"上行开始时刻即截断"约定同款。
    var pendingChangesOps = state.heldPendingChanges.concat(state.buffer);
    state.heldPendingChanges = [];
    state.buffer = [];
    var pendingChangesRevision = state.revision;
    var hasPendingChanges = pendingChangesOps.length > 0;

    state.roundInFlight = true;
    // 这是一次真正出网的新 data.submit——不管这次拿到的
    // round 号是不是复用了某个已死轮次的旧数字(实测确认 round 号会复用),从这一刻
    // 起它都是一个全新的、合法的在途回合,任何旧的"判死"标记都不该再影响它。清空在这里
    // (而不是等下一次 performRoundConfirmSave 才清)是因为清空必须发生在这一轮自己的
    // performRoundConfirmSave 被调用之前。
    state.deadRound = null;
    // 在途互斥扩窗:回合开始,取消任何待发的纯存档上行——
    // pendingChangesOps 已经从 buffer 取走,不受这两个定时器影响;这里取消的是"回合
    // 开始前已经调用过 save() 但还没真正发出网络请求"的那份纯存档快照(state.archive.
    // pendingSnapshot),它会在这一轮 performRoundConfirmSave 时被自然吸收——与
    // pending_changes 是两条独立的东西,互不影响(显式 save 与 submit 相互独立)。
    cancelArchiveTimer();
    cancelIdleTimer();

    var handlerName = opts.handler;
    var handlerFn = handlerRegistry[handlerName];
    var model = { input: opts.input, outputFormat: opts.outputFormat, handler: handlerName };
    // outputNotes 可选:省略(undefined)时不上行该键,与 outputFormat 恒上行的必填语义
    // 区分开——避免给桥/mock 侧凭空多出一个空字符串键。
    if (opts.outputNotes !== undefined) {
      model.outputNotes = opts.outputNotes;
    }
    var params = {
      baseRevision: state.revision,
      model: model,
    };
    // 缓冲区为空时完全不带这个字段(不是带一个空 changes 数组)——保持"调用
    // sender() 即同步发出 data.submit"这个既有可观测行为逐字节不变。
    if (hasPendingChanges) {
      params.pendingChanges = { revision: pendingChangesRevision, changes: pendingChangesOps };
    }

    // 缓冲区清空时机(定死,唯一可能造成数据净损失的口子):pendingChangesOps 只有在收到"submit 成功
    // 且响应带数字 revision"时才真正视为已确认、就地丢弃。其余结局按"这一轮到底有没有
    // 开出"分两类,两类的落点**不是同一个地方**——这是关键:
    //   1. 成功但响应没带 revision(后端尚未支持这个字段)——回合**已经开出**,这批
    //      写放回 state.buffer 头部(顺序上早于 handler 接下来自己写入的内容);buffer 会
    //      被本轮 performRoundConfirmSave(merged = archive.pendingSnapshot.concat(buffer))
    //      与 handler 的写入合并一并上行,不需要单独处理——这一支仍然安全,因为此刻
    //      state.roundInFlight 恒为 true(下面 reject 分支才会复位),triggerIdleArchive/
    //      flushOnHide 的在途守卫挡得住,不会被误抢。
    //   2. submit 失败(回合**没有**开出)——不能放回 state.buffer:这个分支执行到这里时
    //      state.roundInFlight 已经被复位为 false(见下面 reject 回调开头),state.buffer
    //      是 triggerIdleArchive/flushOnHide/archiveSnapshotAndEnqueue 三条纯存档抽取
    //      路径共用的公共缓冲区,它们的在途守卫此刻形同虚设,放回 buffer 会被其中任意一条
    //      当独立纯存档抢先出网、写到落账线**之前**——这正是要避免的孤儿路径(与此前 submit 前置存档的孤儿路径
    //      同构)。改放进 holdPendingChangesForNextSubmit 定义的独立槽位
    //      state.heldPendingChanges,三条 sweep 一律不碰它。
    function requeuePendingChangesToBuffer() {
      if (!hasPendingChanges) return;
      state.buffer = pendingChangesOps.concat(state.buffer);
    }

    // submit 失败(回合未开出)专用的暂存——见上方情形 2。只有
    // dispatchSubmitAfterArchive 自己会消费这个槽位:下一次派单时(见上方 pendingChangesOps
    // 的拼接)读出来并入新一批 pendingChanges、随即清空;此刻理论上 state.heldPendingChanges
    // 恒为空(上面已经把它拼进 pendingChangesOps 并清空,而 roundInFlight 互斥保证同一
    // 时刻只有一次 dispatchSubmitAfterArchive 在跑),这里仍用 concat 而不是直接赋值,是
    // 防御性写法,不依赖这条不变式。
    function holdPendingChangesForNextSubmit() {
      if (!hasPendingChanges) return;
      state.heldPendingChanges = state.heldPendingChanges.concat(pendingChangesOps);
    }

    return request('data.submit', params).then(
      function (res) {
        var round = res && res.round;
        var output = res && res.output;
        if (hasPendingChanges) {
          if (res && typeof res.revision === 'number') {
            // 后端已经把 pending_changes 落进这一轮并回吐新 revision——已确认,
            // 不需要再做任何事(既不放回 buffer,也不追加一次纯存档)。
            state.revision = res.revision;
          } else {
            // 响应没带 revision——后端尚未支持这个字段,pending_changes 从未真正
            // 落进后端("可选,不传时行为逐字节不变"的另一面:老后端会原样忽略未知
            // 字段)。回合已经开出,放回 buffer 头部,随本轮确认 save 一并上行(情形 1)。
            requeuePendingChangesToBuffer();
          }
        }
        return runRoundHandler(round, output, handlerFn);
      },
      function (err) {
        // 回合尚未开出(data.submit 本身被拒/失败):本地在途状态可安全清除。
        state.roundInFlight = false;
        var category = getErrorCategory(err);
        if (err && err.code === 'DATA_CONFLICT') {
          // submit 撞 409(pending_changes.revision
          // 陈旧,后端按 sandbox_save 同款语义回 {data, revision})——与该分支对其它本地
          // 写的既有处置一致,服务端全量替换本地、**丢弃** pendingChangesOps,不回落纯
          // 存档:回合根本没开出,没有"这一轮"可归属,继续留着只会在下一次 idle 存档时
          // 抢在下一轮确认之前把这批陈旧写入写到落账线上,正是要消灭的孤儿路径。冲突
          // 错误(含新 data/revision)通过下方 throw err 交给应用,由应用基于新状态重新
          // 决定并重新提交。
          var payload = err.payload || {};
          state.data = payload.data || {};
          state.revision = typeof payload.revision === 'number' ? payload.revision : state.revision;
          state.buffer = [];
          cancelArchiveTimer();
          var pendingResolvers = state.archive.resolvers;
          state.archive.pendingSnapshot = null;
          state.archive.resolvers = [];
          rejectAll(pendingResolvers, err);
        } else if (category === 'STALE') {
          // 需要刷新的错误 —— DATA_CONFLICT 不带全量 payload 时走此路径,
          // 主动 pull 拿权威态然后重置快照。整份本地状态即将被 ready(true) 强制刷新,
          // pendingChangesOps 同样丢弃(理由同 DATA_CONFLICT)。
          rejectAll(state.archive.resolvers, err);
          state.archive.pendingSnapshot = null;
          state.archive.resolvers = [];
          // ready(true) 强制重拉 —— ready() 成功后永久 memo,这里再用普通
          // ready() 不会真发 data.pull,恢复是空操作;force 同时让桥侧跳过 5s 结果
          // 缓存。失败静默吞掉(原错误已在抛,重拉失败不改变本次 submit 的结局)。
          ready(true).catch(function () {});
        } else {
          // 其余失败(网络错误/超时/5121 幂等冲突等)——回合
          // 没有开出,放进 state.heldPendingChanges(保持顺序),不进纯存档队列、也不进
          // state.buffer——只允许随下一次 submit 的 pending_changes 出网;若应用带同一
          // 输入重新 submit(同 baseRevision → 同 request_id,幂等)会一并带上。
          holdPendingChangesForNextSubmit();
        }
        // submit 失败后(回合未开出),若仍有待上行的纯存档快照
        // (与本次 pendingChangesOps 无关的独立 save() 快照),重新排期上行——submit()
        // 派单时已取消过节流定时器,失败后不重排会让该快照卡在内存里,直到下一次
        // set()/remove() 才会被顺带唤醒(DATA_CONFLICT/STALE 分支已把 pendingSnapshot
        // 清空,不会重复触发这里)。
        if (!state.roundInFlight && state.archive.pendingSnapshot
          && state.archive.pendingSnapshot.length > 0) {
          scheduleArchiveUpload();
        }
        throw err;
      }
    );
  }

  // 与 commitRoundRecovery 共用:confirm save 结算后如何
  // 收敛 roundInFlight 的判据只有一份,不写两份(架构统一)——DATA_CONFLICT/5424/STALE/
  // REJECTED 均为终态,收敛回 idle;RETRYABLE(含无分类)保持在途(stuck),真相以下一次
  // 交还/放弃事件为准。
  function settleRoundConfirmSave(savePromise) {
    return savePromise.then(
      function (res) {
        state.roundInFlight = false;
        resumeArchiveUploadIfPending(); // 复位处补检查
        return res;
      },
      function (err) {
        var category = getErrorCategory(err);
        if (err && (err.code === 'DATA_CONFLICT' || err.code === 5424 || err.code === '5424' || category === 'STALE' || category === 'REJECTED')) {
          // 5424(sandbox_round_mismatch)/DATA_CONFLICT/STALE/REJECTED:永久性拒绝或
          // 终态错误,收敛回 idle。数据收敛(DATA_CONFLICT 全量替换 / STALE 的 ready(true)
          // 强制重拉)已在 performRoundConfirmSave 的错误处理内部完成,这里只复位回合状态。
          state.roundInFlight = false;
          resumeArchiveUploadIfPending();
        }
        throw err;
      }
    );
  }

  function runRoundHandler(round, output, handlerFn) {
    return Promise.resolve()
      .then(function () {
        return handlerFn(output);
      })
      .then(
        function () {
          return settleRoundConfirmSave(performRoundConfirmSave(round)).then(function () {
            return { output: output };
          });
        },
        function (handlerErr) {
          // handler 抛错时不发 save(轮次未确认),
          // 但改前这里只 throw、从不发任何请求——roundInFlight 永久不复位,回合一直 stuck,
          // 只有下一次页面刷新(全新 bridge 实例,readyPeriodOver 天然为 false)才解得开。
          // 现在主动调用既有的 rollbackRound()——桥侧 ROLLBACK_METHOD 守卫已放宽为
          // "roundState 处于 pendingSave 且 round 匹配即放行"(不再要求
          // ready 期),同一会话内(无需刷新)即可让这次 rollback 成功,回合正常收敛回 idle。
          return rollbackRound(round).then(
            function () {
              throw makeError('HANDLER_FAILED', 'submit handler threw', { round: round, cause: handlerErr });
            },
            function (rollbackErr) {
              // rollback 本身也失败(网络/超时等):真相以下次 ready() 为准(rollbackRound
              // 已在内部把 roundInFlight 复位),仍以原始 handlerErr 反映给应用,rollback
              // 失败原因一并挂在 payload 上供排障。
              throw makeError('HANDLER_FAILED', 'submit handler threw', { round: round, cause: handlerErr, rollbackErr: rollbackErr });
            }
          );
        }
      );
  }

  // 回合确认的网络失败在页面存活期间持续重试；明确拒绝沿用现有收尾。
  var ROUND_CONFIRM_SAVE_RETRY_BASE_MS = 1000;
  var ROUND_CONFIRM_SAVE_RETRY_MAX_MS = 30000;

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // performRoundConfirmSave:回合确认点,是"save 是唯一上行数据的时刻"(H.3)的落地——
  // sweep 当时的纯存档快照 + 当前 buffer,按顺序拼接作为该轮 changes(op 列表)
  // 一次性上行;网络类失败按上方注释的策略重试,整个重试期间回合始终保持在途(roundInFlight
  // 只在调用方——runRoundHandler——收到这里最终的 resolve/reject 后才复位),不违反在途
  // 互斥:重试自始至终都属于「同一个」在途回合,不会开出第二个回合、也不会被误判为空闲。
  function performRoundConfirmSave(round) {
    var merged = (state.archive.pendingSnapshot || []).concat(state.buffer);
    state.buffer = [];
    var archiveResolvers = state.archive.resolvers;
    state.archive.pendingSnapshot = null;
    state.archive.resolvers = [];
    cancelArchiveTimer(); // 纯存档节流定时器取消,不再单独上行

    var changes = merged; // op 列表本身即 changes
    // 从首次尝试到全部重试结束前恒为 true——期间任何 data.set() 落入下一窗口 buffer 都是
    // 正确行为(这批 changes 已经截断,重试重发的是同一份内容,不应该混入重试期间的新写)。
    state.roundSaveDispatched = true;

    function attempt(attemptIndex) {
      return request('data.save', { round: round, changes: changes }).then(
        function (res) {
          state.roundSaveDispatched = false;
          // revision 与 round 是两条独立计数轴
          // ——round 是客户端回合序号,revision 是服务端数据版本(纯存档也会推进它),两者在
          // 真实后端下会分叉。必须用响应体里的 res.revision 回填,不能拿 round 顶替(round
          // 可能早已落后于纯存档推进过的真实 revision,拿它写回会污染 anchor,下一次纯存档
          // 用陈旧 anchor 去比对,导致伪 409)。与纯存档路径(见上方)同款写法。
          state.revision = res && typeof res.revision === 'number' ? res.revision : state.revision;
          resolveAll(archiveResolvers);
          // 此刻 state.roundInFlight 恒为 true(调用方 runRoundHandler
          // 在这个 Promise 结算之后才会把它复位为 false),下面这个判断曾经的写法
          // `!state.roundInFlight` 因此恒假、从未真正续排过——已改为由调用方在真正复位
          // roundInFlight 之后调用 resumeArchiveUploadIfPending() 统一处理(dev 告警场景 2:
          // 确认过程中又攒了新的纯存档快照,交还正常节流通道续排)。
          return res;
        },
        function (err) {
          var category = getErrorCategory(err);
          if (err && err.code === 'DATA_CONFLICT') {
            // DATA_CONFLICT:后端胜,payload 带权威全量 —— 全量替换收敛。
            state.roundSaveDispatched = false;
            var payload = err.payload || {};
            state.data = payload.data || {};
            state.revision = typeof payload.revision === 'number' ? payload.revision : state.revision;
            state.buffer = [];
            var allResolvers = archiveResolvers.concat(state.archive.resolvers);
            state.archive.pendingSnapshot = null;
            state.archive.resolvers = [];
            rejectAll(allResolvers, err);
            throw err;
          }
          // STALE(5424 sandbox_round_mismatch / STALE 分类)
          // 从 DATA_CONFLICT 分支拆出 —— STALE 不带全量 payload,原分支体的
          // `state.data = payload.data || {}` 会把运行中应用的数据集当场清空。
          // 改走 submit 失败分支同款(见 dispatchSubmit)的「丢弃本批变更 + ready(true)
          // 强制重拉」路径,拿权威态替换;该轮次已不存在,重试无意义。
          if (err && (err.code === 5424 || err.code === '5424' || category === 'STALE')) {
            state.roundSaveDispatched = false;
            var staleAllResolvers = archiveResolvers.concat(state.archive.resolvers);
            state.archive.pendingSnapshot = null;
            state.archive.resolvers = [];
            rejectAll(staleAllResolvers, err);
            // ready(true) 强制重拉(绕过 readyPromise memo 与桥侧 5s 缓存);
            // 失败静默吞掉(原错误已在抛)。
            ready(true).catch(function () {});
            throw err;
          }
          // REJECTED 终态错误不重试,直接放弃。
          if (category === 'REJECTED' || (err && (String(err.code) === '5437' || String(err.code) === '5438'))) {
            state.roundSaveDispatched = false;
            // 5437(身份不符)/5438(轴已越过)
            // 都归类到这个分支(后端错误分类只把 5424/5421 分去 STALE,其余
            // 一律 REJECTED),而 round.discard 事件(processRoundDiscard)已经把这个
            // round 记成 `state.deadRound`——此时不能像下面默认那样把 merged 放回
            // buffer:buffer 里的写入会被下一次纯存档(round 为 undefined)当作普通存档
            // 上行,而纯存档在后端侧走早返回、不受三步身份/轴检查约束。
            // 5438 命中时那一轮已经在红条上标着"数据未
            // 保存",若 changes 真的从这道侧门写回去,是自相矛盾;5437 命中时更危险——
            // changes 会经这道侧门写进已经属于别人的活轮次,只剩 revision 乐观锁挡着,
            // 恰是要封的攻击面。按 5424 同款丢弃 merged(不放回 buffer),但**不**
            // 调用 `ready(true)`——round.discard 已经把状态收敛回 idle,没有"权威态需要
            // 重新拉取"这件事,强制重拉反而是多余的一次网络往返。
            if (round === state.deadRound) {
              rejectAll(archiveResolvers, err);
              throw err;
            }
            state.buffer = merged.concat(state.buffer);
            rejectAll(archiveResolvers, err);
            throw err;
          }
          // 未明确拒绝的网络/超时/5xx 持续退避，重发同一份 changes。
          var backoffMs = (err && err.code === 'RATE_LIMITED')
            ? clampRetryAfterSeconds(err.payload && err.payload.retryAfter) * 1000
            : Math.min(ROUND_CONFIRM_SAVE_RETRY_MAX_MS, ROUND_CONFIRM_SAVE_RETRY_BASE_MS * Math.pow(2, Math.min(attemptIndex, 5)));
          return delay(backoffMs).then(function () {
            if (round === state.deadRound) {
              state.roundSaveDispatched = false;
              rejectAll(archiveResolvers, err);
              throw err;
            }
            return attempt(attemptIndex + 1);
          });
        }
      );
    }

    return attempt(0);
  }

  // ------------------------------------------------------------------
  // 显式交还(取代早期"零订阅者→自动 rollback"的默认行为):
  // ready() 见 pendingRound 不阻塞(见上方 applyPullResponse)——output 由宿主在后台
  // 异步取到后,经 round.handback / round.discard 两个下行事件(与
  // ui.presentationChange/data.changed 同一机制,事件下行通道)推给 SDK:
  //   round.handback {round, name, output}:output 已就绪。
  //     - 若 name 未经 defineRound() 注册(约定 defineRound 必须在
  //       ready() 之前调用)→ SDK 自主放弃并主动 rollback,不得静默卡住。这条边界
  //       这条边界始终成立:没有 handler 就没有可以重放的东西。
  //     - 若已注册 onRoundRecovery(cb)覆盖钩子 → 交给应用决定,cb 收到
  //       {name, output, commit, discard}——commit() 只是把应用自己已经写进 data 的内容
  //       按回合确认语义上行(与 performRoundConfirmSave 同一实现,不重新计算),不会替
  //       应用调用任何 handler(不提供"一键接受并跑已注册 handler"的捷径,这条
  //       路径永远要求应用自己写代码调用)。
  //     - **默认**(未订阅 onRoundRecovery,且 name 已注册)→ **自动重放**:直接调用
  //       已注册的 handler(与正常 submit 路径同一份 runRoundHandler),跑完照常发确认
  //       save。这是相对早期版本的反转点:旧默认是"零订阅者→自动 rollback"(理由是
  //       "重放前提『应用状态机能从 data 完整重建』运行时不强制,静默重放会算错")。
  //       新默认把这个前提立成硬规范——持久状态本就该放 data、由后端存,
  //       留在 JS 闭包里是应用违规,不是正常写法,不该为了防违规应用而让所有合规应用
  //       都手写一遍回调。handler 重放时抛错仍然 rollback 收敛(边界不变,复用
  //       runRoundHandler 既有的 handlerErr 分支)。
  //   round.discard {round}:宿主已经判定这一轮不可恢复并自行完成了 rollback
  //     (身份对不上 / 轴已越过 / output 取不到),SDK 只需解除本地"恢复中"
  //     的卡住状态,不再发任何请求。
  // 两个事件都只在"确有一轮在等待宿主编排层处理"的窗口内到达一次;重复/迟到的到达按
  // 幂等处理(不重复通知应用、不重复自动重放)。
  // ------------------------------------------------------------------

  var ROUND_HANDBACK_EVENT = 'round.handback';
  var ROUND_DISCARD_EVENT = 'round.discard';
  // 应用侧 onRoundRecovery() 订阅的内部通知 key——与语言 API 同款分离手法(见
  // LANGUAGE_CHANGE_NOTIFY_EVENT 注释):handler 是否已注册的校验必须先在
  // handleRoundHandback 里做完,再决定要不要通知应用,不能让应用直接订阅 wire 事件、
  // 绕过这层校验。
  var ROUND_RECOVERY_NOTIFY_EVENT = 'paranovell.roundRecovery';

  // processRoundHandback/processRoundDiscard:两个事件的核心处理逻辑,从
  // handleRoundHandback/handleRoundDiscard 里拆出来——供"roundInFlight 已就绪"的
  // 即时路径与 applyPullResponse 的缓冲排空路径共用同一份实现(不重复实现两份)。
  function processRoundHandback(round, name, output) {
    if (state.recovery) {
      // 沿用同一个标记:同一轮的重复/迟到交还
      // 按幂等处理——不管这一轮此刻是"等订阅者决定"(覆盖路径)还是"正在自动重放中"
      // (默认路径),state.recovery 都代表"这一轮已经在处理,不要再处理第二次"。少了
      // 这道闸,默认路径会在重放/save 结算完成之前被重复触发的事件再跑一遍 handler,
      // 造成同一份 changes 被计算并上行两次。
      return;
    }
    if (!hasOwn(handlerRegistry, name)) {
      // 边界:应用没有注册对应处理入口(换了版本 /
      // round 名改了 / 注册晚于 ready())——没有 handler 就没有东西可以重放,SDK 自主
      // 放弃,不得静默卡住。不经 discardRoundRecovery(那个校验的是
      // "已交还给应用、应用主动放弃",这里从未走到"交还给应用"这一步)。
      rollbackRound(round).catch(function (err) {
        warnDev('automatic rollback after missing round handler ("' + name + '") failed: ' + (err && err.message));
      });
      return;
    }
    var subscribers = hasOwn(eventSubscribers, ROUND_RECOVERY_NOTIFY_EVENT)
      ? eventSubscribers[ROUND_RECOVERY_NOTIFY_EVENT]
      : null;
    if (!subscribers || subscribers.length === 0) {
      // handler 已注册、没有人订阅 onRoundRecovery 覆盖——这是绝大多数合规
      // 应用的默认状态,默认动作改为**自动重放**:直接复用 runRoundHandler(与正常
      // submit 路径完全同一份实现),调用 handler(output) 算出 changes 后照常发确认
      // save。state.recovery 在这里被借用成"重放进行中"的占位标记(不是"等待应用决定"
      // 语义,commitRoundRecovery/discardRoundRecovery 不会被这条路径调用),纯粹为了让
      // 本函数顶部的幂等早退在重放结算完成前也能拦住重复/迟到的同轮事件。
      // handler 抛错 / save 失败:runRoundHandler 内部已经处理(handlerErr 分支主动
      // rollback 收敛,边界不变);这里只需要清掉占位标记并留痕,没有任何调用方在
      // await 这个 Promise(与其它"自动 rollback"分支同款的 fire-and-forget)。
      state.recovery = { round: round, name: name };
      runRoundHandler(round, output, handlerRegistry[name]).then(
        function () {
          state.recovery = null;
        },
        function (err) {
          state.recovery = null;
          warnDev('automatic replay for round without any onRoundRecovery subscriber ("'
            + name + '") failed: ' + (err && err.message));
        }
      );
      return;
    }
    state.recovery = { round: round, name: name };
    // 不能直接用
    // 通用 dispatchEvent —— 它对每个订阅者的异常只 warnDev,不报告"有没有人真正完成"。
    // output 是模型产出、形状不可信的对象,一个 output.foo.bar 的 TypeError 就能让回调
    // 没走到 commit()/discard() 就抛出;state.recovery 已经在上面置上,若无人善后,
    // roundInFlight 永久卡死,而且刷新无法自愈(同一 output → 同一处抛错)。这里自己
    // 遍历订阅者、计数"未抛错完成的回调数",全部抛错(且没有任何一次调用把
    // state.recovery 清空,即没人真的走到 commit()/discard())时自动 rollback 收敛——
    // ⚠ 这里**不**改成自动重放:订阅者的存在本身就是应用主动选择"我要自己接管这一轮"
    // (覆盖默认行为),它抛错只说明这次接管失败了,不代表应用希望退回默认的自动重放;
    // 保底动作维持 rollback,与零订阅者路径(上方,默认自动重放)是两条不同语义的分支,
    // 不再等价。
    var snapshot = subscribers.slice();
    var completedWithoutThrow = 0;
    var payload = {
      name: name,
      output: output,
      commit: function () { return commitRoundRecovery(round); },
      discard: function () { return discardRoundRecovery(round); },
    };
    for (var i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](payload);
        completedWithoutThrow += 1;
      } catch (e) {
        warnDev('event subscriber for "' + ROUND_RECOVERY_NOTIFY_EVENT + '" threw: ' + (e && e.message));
      }
    }
    if (completedWithoutThrow === 0 && state.recovery && state.recovery.round === round) {
      state.recovery = null;
      rollbackRound(round).catch(function (err) {
        warnDev('automatic rollback after all round recovery subscriber(s) threw synchronously ("'
          + name + '") failed: ' + (err && err.message));
      });
    }
  }

  function processRoundDiscard(round) {
    state.recovery = null;
    state.roundInFlight = false;
    // 此前这里完全不使用 `round` 参数——即时路径
    // (roundInFlight 已置真时直接调用本函数)与缓冲路径(applyPullResponse 按 round 号
    // 匹配后才重放)因此行为不对称。记下 `deadRound`,供 performRoundConfirmSave 的
    // REJECTED 分支据此判断"这次失败是不是因为这一轮已经被宿主判死"(见其注释)——
    // 这是 `round` 参数在本函数里唯一有意义的用法:不是拿它去比对"是不是当前这一轮"
    // (SDK 单线程 + roundInFlight 互斥,同一时刻只可能有一轮在途,round.discard 到达
    // 即视为针对那一轮),而是把它交给"另一处将来会用同一个 round 号做比对"的地方。
    state.deadRound = round;
    resumeArchiveUploadIfPending();
  }

  function handleRoundHandback(payload) {
    var round = payload && typeof payload === 'object' ? payload.round : undefined;
    var name = payload && typeof payload === 'object' ? payload.name : undefined;
    var output = payload && typeof payload === 'object' ? payload.output : undefined;
    if (typeof round !== 'number' || typeof name !== 'string' || !name) {
      return; // 畸形事件静默忽略,与其它下行事件同款防御
    }
    if (!state.roundInFlight) {
      // (对抗性时序用例发现):**不是**"理论上
      // 不会发生"——即便宿主严格按"先送 pull 响应、再送事件"的顺序发出两条消息,
      // round.handback 走 __onEvent 同步派发,而 roundInFlight 只在 pull 响应对应的
      // Promise resolve 之后的下一个微任务(.then(applyPullResponse))才真正置真;
      // Promise resolve 本身只是调度、不代表 then 回调已经跑完,两条消息谁先被"处理完"
      // 不是发出顺序能保证的(已用对抗性时序用例实测复现:pull 与
      // getSandboxPendingState 都换成"已 resolve" promise 时,这里确实会先于
      // roundInFlight 置真被打到)。缓冲这次交还,等 applyPullResponse 置真
      // roundInFlight 时按 round 号排空(见 state.pendingRoundSignal 声明处注释与
      // applyPullResponse 排空逻辑)——根治时序依赖,不假设谁先谁后。
      state.pendingRoundSignal = { type: 'handback', round: round, name: name, output: output };
      return;
    }
    processRoundHandback(round, name, output);
  }

  function handleRoundDiscard(payload) {
    var round = payload && typeof payload === 'object' ? payload.round : undefined;
    if (typeof round !== 'number') {
      return;
    }
    if (!state.roundInFlight) {
      // 同上(见 handleRoundHandback 的对应说明)——round.discard 一样可能先于
      // roundInFlight 真正置真抵达(这条收敛路径与交还共用同一个 data.pull handler
      // 触发点),同样缓冲 + 排空,不当"迟到的重复推送"直接丢弃。
      state.pendingRoundSignal = { type: 'discard', round: round };
      return;
    }
    processRoundDiscard(round);
  }

  __onEvent('hook.query', handleHookQuery);
  __onEvent('hook.settled', handleHookSettled);
  __onEvent(ROUND_HANDBACK_EVENT, handleRoundHandback);
  __onEvent(ROUND_DISCARD_EVENT, handleRoundDiscard);

  // ------------------------------------------------------------------
  // 刷新后在途回合(1.9.0)
  //
  //   round.pending {round}:宿主预告"这一轮正文还在生成"(刷新 / 换设备回来时落在段 1,
  //     本地没有可先给的数据,data.pull 被宿主挂起到生成结束)。重复到达即心跳——每次都把
  //     在途 data.pull 的超时重新计满,ready() 不因默认 20s 超时失败。
  //   onRoundPending(cb):cb({pending, round})。pending:true 在数据到达前(round.pending)
  //     或 ready() 发现待恢复的一轮时派发;这一轮在 SDK 侧结束(自动重放 save 完成 /
  //     rollback / round.discard / 数据加载失败)时派发 pending:false。只在翻转时派发。
  //     不订阅时行为与 1.8.2 一致。
  // ------------------------------------------------------------------
  var ROUND_PENDING_EVENT = 'round.pending';
  var ROUND_PENDING_NOTIFY_EVENT = 'paranovell.roundPending';

  function notifyRoundPending(pending, round) {
    if (pending) {
      if (state.roundPendingNotified !== null) return;
      state.roundPendingNotified = round;
      dispatchEvent(ROUND_PENDING_NOTIFY_EVENT, { pending: true, round: round });
      return;
    }
    if (state.roundPendingNotified === null) return;
    var endedRound = state.roundPendingNotified;
    state.roundPendingNotified = null;
    dispatchEvent(ROUND_PENDING_NOTIFY_EVENT, { pending: false, round: endedRound });
  }

  function handleRoundPending(payload) {
    var round = payload && typeof payload === 'object' ? payload.round : undefined;
    if (!Number.isInteger(round) || round <= 0) {
      return; // 畸形事件静默忽略,与其它下行事件同款防御
    }
    extendPendingPullTimeouts();
    if (state.roundInFlight) {
      return; // 已按真实 pendingRound 在途(通知已发),这次只是心跳
    }
    state.roundPendingNotice = round;
    notifyRoundPending(true, round);
  }

  __onEvent(ROUND_PENDING_EVENT, handleRoundPending);

  function onRoundPending(cb) {
    return __onEvent(ROUND_PENDING_NOTIFY_EVENT, cb);
  }

  // commitRoundRecovery(round):应用决定"接"——把已经写进 data 的内容按回合确认语义
  // 上行(与 performRoundConfirmSave 同一实现,不重新计算、不调用任何 handler)。
  function commitRoundRecovery(round) {
    if (!state.recovery || state.recovery.round !== round) {
      return Promise.reject(makeError('INTERNAL', 'paranovell: no matching round recovery to commit'));
    }
    state.recovery = null;
    return settleRoundConfirmSave(performRoundConfirmSave(round)).then(function () {
      return undefined;
    });
  }

  // discardRoundRecovery(round):应用决定"弃"——转 data.rollback,复用既有 rollbackRound
  // (既有收口:成功/失败都会复位 roundInFlight)。
  function discardRoundRecovery(round) {
    if (!state.recovery || state.recovery.round !== round) {
      return Promise.reject(makeError('INTERNAL', 'paranovell: no matching round recovery to discard'));
    }
    state.recovery = null;
    return rollbackRound(round);
  }

  // onRoundRecovery(cb,可选覆盖钩子):不订阅时,交还默认自动重放
  // 已注册的 handler(见上方"显式交还"段);订阅了才由 cb 接管决定权,拿到
  // {name, output, commit, discard} 自己判断。直接复用 __onEvent 的通用订阅/退订/
  // 异常隔离语义(与 onPresentationChange/onLanguageChange 同款写法)。
  function onRoundRecovery(cb) {
    return __onEvent(ROUND_RECOVERY_NOTIFY_EVENT, cb);
  }

  // ------------------------------------------------------------------
  // plan.* API:沙盒读写小说 plan(方案)实体。
  //
  // list() 纯读、不弹确认框;create()/restart() 由宿主桥在真正发出网络请求前先弹出
  // 一个授权框——这一步完全发生在桥内部,SDK 这一层对此**不可见**:调用方看到
  // 的只是一个耗时可能偏长的 Promise,resolve/reject 是它唯一能观察到的结局。SDK 不
  // 暴露任何"跳过确认""预检查是否会弹框"的参数或方法(行为契约,见 paranovell.d.ts
  // ParanovellPlanAPI 顶部注释)——这里刻意保持 create/restart 的参数列表干净,不留
  // 后门让应用做时序攻击。
  //
  // wire 约定(与宿主桥对齐):
  //   plan.list    请求 {}                     → 响应 data = ParanovellPlanItem[](裸数组,
  //                                                createdAt 降序,桥/后端已排好序,SDK 不再排序)
  //   plan.create  请求 {title, content}        → 响应 data = ParanovellPlanRef(裸对象)
  //   plan.restart 请求 {planId}                → 响应 data = ParanovellPlanRef(裸对象)
  // 错误一律经既有 request()/handleIncomingRaw 的通用 error 通道上抛(makeError(code,
  // message, payload)),USER_REJECTED / SUBMIT_IN_FLIGHT / PLAN_IN_PROGRESS /
  // PLAN_NOT_DISCARD / PLAN_NOT_FOUND / RATE_LIMITED / INTERNAL 等码值均由宿主侧决定,
  // 这里不需要任何特殊分支——与其余桥方法的错误传播路径完全一致。
  // ------------------------------------------------------------------

  // plan.create/plan.restart 的入参尺寸上限。
  //
  // ⚠ 这不是「防御性校验」,是**去掉两侧超时之后必须补的一道闸**。宿主桥对超长消息有两条
  // 检查,顺序是关键:先 `raw.length > 256KB`(UTF-16 单元数)——这条**静默丢弃,连消息 id
  // 都不抠、不回任何响应**(出于安全考虑刻意如此,不解析不可信的超大输入);后
  // `byteLength(raw) > 256KB`(UTF-8 字节)——这条才会回 INTERNAL。
  //
  // 于是纯 ASCII 的超长 content 命中前者:桥不回话,而 plan.create/restart 现在没有本地
  // 计时器(见 timeoutForMethod),`pendingRequests[id]` 永不清理,应用的 await **永久挂起**
  // ——面板还开着、没有报错、没有恢复手段。这条路径此前由 750s 超时兜底,超时删掉后就裸奔了。
  // (中文内容因 UTF-16 单元数小于 UTF-8 字节数,反而会落到第二条拿到 INTERNAL,能结算。)
  //
  // 在 SDK 侧同步拦掉是最便宜的堵法:与既有「非空校验不出网」同款,快速失败、不发桥消息。
  // 取 64KB(UTF-16 单元数,与桥第一条检查同一口径),远低于 256KB —— 留足余量给 JSON 信封
  // 本身以及同一条消息里的其它字段,不做贴边设计。
  var PLAN_TEXT_MAX_LENGTH = 64 * 1024;

  function assertPlanTextWithinLimit(label, value) {
    if (value.length > PLAN_TEXT_MAX_LENGTH) {
      throw new TypeError(
        label + ' must be at most ' + PLAN_TEXT_MAX_LENGTH + ' characters, got ' + value.length
      );
    }
  }

  function planList() {
    return request('plan.list', {}).then(function (res) {
      return Array.isArray(res) ? res : [];
    });
  }

  // create()/restart() 的参数必填,且须为非空字符串,
  // 否则同步抛 TypeError——不发桥消息、不走一次网络往返(也不会误触发宿主确认框)。
  function planCreate(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('paranovell.plan.create: opts must be an object with { title, content }');
    }
    if (typeof opts.title !== 'string' || !opts.title) {
      throw new TypeError('paranovell.plan.create: opts.title must be a non-empty string');
    }
    if (typeof opts.content !== 'string' || !opts.content) {
      throw new TypeError('paranovell.plan.create: opts.content must be a non-empty string');
    }
    assertPlanTextWithinLimit('paranovell.plan.create: opts.title', opts.title);
    assertPlanTextWithinLimit('paranovell.plan.create: opts.content', opts.content);
    return request('plan.create', { title: opts.title, content: opts.content });
  }

  function planRestart(planId) {
    if (typeof planId !== 'string' || !planId) {
      throw new TypeError('paranovell.plan.restart: planId must be a non-empty string');
    }
    assertPlanTextWithinLimit('paranovell.plan.restart: planId', planId);
    return request('plan.restart', { planId: planId });
  }

  // ------------------------------------------------------------------
  // 组装并挂载
  // ------------------------------------------------------------------

  window.paranovell = {
    ready: ready,
    env: env,
    data: {
      get: dataGet,
      getAll: dataGetAll,
      set: dataSet,
      remove: dataRemove,
      append: dataAppend,
      pending: dataPending,
    },
    defineRound: defineRound,
    defineHook: defineHook,
    save: save,
    // 可选覆盖钩子:不订阅时交还默认
    // 自动重放,详见文件顶部"显式交还"段。
    onRoundRecovery: onRoundRecovery,
    onRoundPending: onRoundPending,
    // 语言(locale)读取 / 覆盖 / 跟随,详见文件头部 "语言(locale)API" 段。
    getLanguage: getLanguage,
    setLanguage: setLanguage,
    onLanguageChange: onLanguageChange,
    // 形态/画布语义化 API,详见文件顶部 "ui.* 形态/画布 API" 段。
    ui: {
      present: uiPresent,
      setCanvas: uiSetCanvas,
      getPresentation: getPresentation,
      onPresentationChange: onPresentationChange,
    },
    // plan 命名空间,详见文件顶部 "plan.* API" 段。
    plan: {
      list: planList,
      create: planCreate,
      restart: planRestart,
    },
    // 内部事件订阅入口,ui.* 等语义化 API 接线用,详见文件顶部注释。
    __onEvent: __onEvent,
  };
})();
