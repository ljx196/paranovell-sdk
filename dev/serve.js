#!/usr/bin/env node
// ============================================================================
// Sandbox 调试台一键启动器
//
// 用途:零依赖(仅 Node 内置模块)静态伺服 sandbox-sdk 根目录(本文件所在 dev/ 的上一级),
// 并自动打开浏览器到调试台 dev.html——省去手动起静态服务器 + 拼 URL 的步骤。只绑
// 127.0.0.1(仅本机可访问,不对局域网暴露)。
//
// 静态根目录由本文件位置推算(__dirname/..),以 URL 前缀 /sandbox-sdk/ 挂载,不依赖执行时
// 的 cwd。目录布局里 dev/、versions/、以及任意放应用的子目录(如 examples/)都在这个根下。
//
// 用法:
//   node serve.js                     # 端口默认 4173
//   node serve.js --port 5000         # 指定端口(被占用时自动 +1 重试)
//   node serve.js --no-open           # 只起服务,不自动打开浏览器
//   node serve.js --allow-test-pick   # 额外开放 pick 接口的测试注入参数(见下,仅供
//                                      # 自动化冒烟使用,正常使用不要加)
//
// 额外提供 GET /__sandbox-dev/apps:递归扫描根目录(dev/、versions/、node_modules/ 除外)
// 下的所有 *.html,返回 JSON { apps: [{ path, label }] } 供 dev.html 的应用选择器使用——
// path 是相对 dev/ 目录的相对路径(可直接拼进 ?app=),label 是相对根目录的展示用路径。
// 裸静态服务(没有跑本脚本,比如直接拿别的 http-server 伺服)访问这个接口会 404,
// dev.html 据此优雅降级为手填输入框。
//
// GET /__sandbox-dev/pick——弹出原生「打开文件」对话框(win32 用 PowerShell +
// System.Windows.Forms.OpenFileDialog;darwin 用 osascript;linux 用 zenity,未安装则
// 501),让用户直接从磁盘挑一个 HTML 调试。同一时刻只允许一个对话框在途,第二个请求
// 直接 409;子进程挂 5 分钟超时兜底,防止对话框一直不关闭时请求悬挂。
//   - 选中文件在静态根目录内 → 转成与 /__sandbox-dev/apps 同形态的相对路径
//     { path: '../xxx' },按现有装载流程走。
//   - 选中文件在根外 → 把该文件所在目录挂载为 { appUrl: '/__sandbox-dev/mounted/<id>/
//     <文件名>' }(id 为随机串,只活在本进程生命周期内,重启后失效)。该虚拟路径下静态
//     伺服挂载目录(越界规范化后仍需落在挂载目录内,否则 403);挂载目录内没有的 sdk.js
//     请求(应用相对引用 `../sdk.js` 时,浏览器解析出的地址会落在挂载路径去掉文件名那一级
//     之外,天然命中"未挂载"分支)会兜底重定向到当前大版本的 sdk.js,从而让根外应用也能
//     正常连上 SDK;取消对话框返回 { canceled: true }。
//   - --allow-test-pick 旗标:仅显式带上时,GET /__sandbox-dev/pick?test=<绝对路径>
//     跳过真实弹框、直接按该路径走完整后续逻辑,供自动化冒烟使用;未带旗标时 test 参数
//     一律忽略,永远走真实弹框。
// ============================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');

// 静态根目录 = 本文件所在 dev/ 的上一级(sandbox-sdk 根),URL 前缀固定为 /sandbox-sdk/——
// 不依赖执行时的 cwd,无论从哪个目录 `node serve.js` 都能跑对。
const SANDBOX_SDK_ROOT = path.resolve(__dirname, '..');
const URL_PREFIX = '/sandbox-sdk/';
const SANDBOX_SDK_VERSIONS_ROOT = path.join(SANDBOX_SDK_ROOT, 'versions');
// 静态根的 realpath,用于 serveFile 里的越界符号链接兜底校验。
const SANDBOX_SDK_ROOT_REAL = fs.realpathSync(SANDBOX_SDK_ROOT);

// SDK 真源在 versions/v<n>/sdk.js(根下没有顶层 sdk.js)。dev 服务器要在两处提供
// "latest 别名"语义:
//   1) 挂载路径未命中时的兜底重定向(见 serveMountedFallbackOrNotFound)
//   2) 直接请求根相对 /sandbox-sdk/sdk.js(应用里 `<script src="../sdk.js">` 解析出的
//      地址,不经过 mount 逻辑;磁盘上没有这个文件,必须由本函数动态兜底)
// "当前 major" = versions/ 目录里最大的那个 v<n>,只在进程启动时扫描一次——改目录结构
// 需要重启 dev 服务器,不做热感知。
const CURRENT_MAJOR_SDK_JS_PATH = resolveCurrentMajorSDKJSPath();

function resolveCurrentMajorSDKJSPath() {
  let entries;
  try {
    entries = fs.readdirSync(SANDBOX_SDK_VERSIONS_ROOT, { withFileTypes: true });
  } catch (e) {
    throw new Error('无法读取 ' + SANDBOX_SDK_VERSIONS_ROOT + ':' + e.message);
  }
  let maxMajor = -1;
  entries.forEach((entry) => {
    if (!entry.isDirectory()) return;
    const m = /^v([1-9][0-9]*)$/.exec(entry.name);
    if (!m) return;
    const major = parseInt(m[1], 10);
    if (major > maxMajor) maxMajor = major;
  });
  if (maxMajor === -1) {
    throw new Error(SANDBOX_SDK_VERSIONS_ROOT + ' 下未发现合法的 v<n> 版本目录');
  }
  return path.join(SANDBOX_SDK_VERSIONS_ROOT, 'v' + maxMajor, 'sdk.js');
}
const DEFAULT_PORT = 4173;
const MAX_PORT_RETRIES = 10;
const DEV_HTML_PATH = URL_PREFIX + 'dev/dev.html';
const SANDBOX_DEV_PREFIX = '/__sandbox-dev/';
const APPS_API_PATH = '/__sandbox-dev/apps';
const PICK_API_PATH = '/__sandbox-dev/pick';
const MOUNTED_PREFIX = '/__sandbox-dev/mounted/';
const SDK_ALIAS_PATH = URL_PREFIX + 'sdk.js'; // 根下没有顶层 sdk.js,latest 别名动态兜底(见下)
const BIND_HOST = '127.0.0.1';
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000; // 子进程超时兜底,防对话框一直不关闭悬挂请求
const ALLOW_TEST_PICK = hasFlag(process.argv.slice(2), '--allow-test-pick');
const NO_OPEN = hasFlag(process.argv.slice(2), '--no-open');
// 只信任 127.0.0.1/localhost 作为 Host——防 DNS rebinding 后拿浏览器同源身份打本机端口。
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

// 任何同类同步抛出(比如 fs.* 遇到含 NUL 字节的路径直接 throw,不走
// callback)兜底记录日志、不让进程退出——当前请求会挂起无响应,但不影响后续请求继续
// 被正常服务。
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 已捕获,进程继续运行:', err && err.stack ? err.stack : err);
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const DEFAULT_MIME = 'application/octet-stream';

function parsePort(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const v = argv[i + 1];
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) return n;
    } else if (arg.indexOf('--port=') === 0) {
      const n = parseInt(arg.slice('--port='.length), 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return DEFAULT_PORT;
}

function hasFlag(argv, flag) {
  return argv.indexOf(flag) !== -1;
}

// 路径规范化 + 目录穿越防护:请求路径必须落在 /sandbox-sdk/ 前缀下,且解析后仍在静态根
// 目录内(例如 `/sandbox-sdk/../../etc/passwd`),否则一律拒绝。
// pathname 在 sandbox-sdk 根下的首段是否为 versions(不分大小写)。
// 应用自己的 myapp/versions/sdk.js 不算,仍走 sdk.js 兜底。
function isUnderVersionsRoot(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return false;
  }
  if (decoded.indexOf(URL_PREFIX) !== 0) return false;
  const first = decoded.slice(URL_PREFIX.length).split('/')[0];
  return first.toLowerCase() === 'versions';
}

function resolveSafePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (e) {
    return null;
  }
  // NUL 字节(如 `%00`)不做穿越校验也能通过 normalize/前缀判断,但会让
  // fs.stat 同步抛 ERR_INVALID_ARG_VALUE 崩进程——这里先行拒绝。
  if (decoded.indexOf('\0') !== -1) return null;
  if (decoded !== URL_PREFIX.slice(0, -1) && decoded.indexOf(URL_PREFIX) !== 0) return null;
  const rest = decoded.slice(URL_PREFIX.length);
  const normalized = path.normalize(path.join(SANDBOX_SDK_ROOT, rest));
  const rootWithSep = SANDBOX_SDK_ROOT + path.sep;
  if (normalized !== SANDBOX_SDK_ROOT && normalized.indexOf(rootWithSep) !== 0) return null;
  return normalized;
}

// 递归扫描静态根下的 *.html,跳过顶层 dev/(启动器/调试台自身所在)、versions/(SDK 版本
// 目录)与 node_modules/,它们都不算"可选应用"。返回按 path 排序的 { path, label } 列表。
function scanApps() {
  const results = [];
  function walk(dir, isTopLevel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    entries.forEach((entry) => {
      if (isTopLevel && entry.isDirectory() && entry.name === 'dev') return; // 排除 dev/
      if (isTopLevel && entry.isDirectory() && entry.name === 'versions') return; // 排除 versions/
      if (isTopLevel && entry.isDirectory() && entry.name === 'node_modules') return; // 排除 node_modules/
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, false);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.html') {
        const relFromSdk = path.relative(SANDBOX_SDK_ROOT, fullPath).split(path.sep).join('/');
        results.push({
          path: '../' + relFromSdk, // 相对 dev/ 目录,可直接拼进 dev.html 的 ?app=
          label: relFromSdk,
        });
      }
    });
  }
  walk(SANDBOX_SDK_ROOT, true);
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results;
}

// ============================================================================
// 原生文件选择 + 根外目录挂载
// ============================================================================

// 挂载表:mount id(随机 hex 串)→ 该文件所在目录的 realpath。只活在本进程生命周期
// 内,进程重启后全部失效(dev.html 侧靠装载失败信号识别并如实提示,见 dev.html)。
let mounts = Object.create(null);
let pickInFlight = false; // 同一时刻只允许一个对话框在途

// mount id 若自增可枚举(1、2、3...),同源页面能靠猜 id 读到别人挂载的目录;
// 使用不可预测的随机 hex 串。
function generateMountId() {
  return crypto.randomBytes(16).toString('hex');
}

// 选中的绝对路径分类:在静态根目录内 → 转成相对 dev/ 目录的相对路径(与
// /__sandbox-dev/apps 清单的 path 形态一致);根外 → 注册一个新挂载,返回虚拟 URL。
function classifySelectedPath(rawPath) {
  const abs = path.resolve(rawPath);
  const rootWithSep = SANDBOX_SDK_ROOT + path.sep;
  if (abs === SANDBOX_SDK_ROOT || abs.indexOf(rootWithSep) === 0) {
    const rel = path.relative(__dirname, abs).split(path.sep).join('/');
    return { path: rel };
  }
  const id = generateMountId();
  const dir = path.dirname(abs);
  // 挂载目录记录 realpath,供 serveFile 校验挂载目录内的符号链接/junction
  // 是否指向目录外(注册这一刻目录理应存在;极端竞态下 realpath 失败就退化为原始
  // 路径,后续请求在 serveFile 阶段自然按 404/403 处理)。
  let dirReal;
  try {
    dirReal = fs.realpathSync(dir);
  } catch (e) {
    dirReal = dir;
  }
  mounts[id] = dirReal;
  return { appUrl: MOUNTED_PREFIX + id + '/' + encodeURIComponent(path.basename(abs)) };
}

// 跨平台原生「打开文件」对话框。callback(err, selectedAbsPathOrNull) —— err 为
// { statusCode, message } 形状;selectedAbsPathOrNull 为 null 表示用户取消。
function openNativeDialog(callback) {
  if (process.platform === 'win32') return openDialogWin32(callback);
  if (process.platform === 'darwin') return openDialogDarwin(callback);
  if (process.platform === 'linux') return openDialogLinux(callback);
  callback({ statusCode: 501, message: '当前平台(' + process.platform + ')不支持原生文件选择对话框' });
}

function openDialogWin32(callback) {
  const initialDir = SANDBOX_SDK_ROOT.replace(/'/g, "''");
  const script =
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null; " +
    "$f = New-Object System.Windows.Forms.OpenFileDialog; " +
    "$f.InitialDirectory = '" + initialDir + "'; " +
    "$f.Filter = 'HTML files (*.html)|*.html'; " +
    "$f.Title = 'Select sandbox app HTML'; " +
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }";
  execFile(
    'powershell',
    ['-NoProfile', '-STA', '-Command', script],
    { timeout: DIALOG_TIMEOUT_MS },
    function (err, stdout) {
      if (err) {
        if (err.killed) return callback({ statusCode: 504, message: '文件选择窗口超时未响应(已自动关闭)' });
        return callback({ statusCode: 500, message: 'PowerShell 弹框失败:' + err.message });
      }
      const out = String(stdout || '').trim();
      callback(null, out || null);
    }
  );
}

function openDialogDarwin(callback) {
  const dir = SANDBOX_SDK_ROOT.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const appleScript =
    'try\n' +
    'set theFile to choose file of type {"html","htm"} with prompt "Select sandbox app HTML" default location (POSIX file "' + dir + '")\n' +
    'return POSIX path of theFile\n' +
    'on error errText number errNum\n' +
    'if errNum is equal to -128 then\n' +
    'return "__CANCELED__"\n' +
    'else\n' +
    'error errText number errNum\n' +
    'end if\n' +
    'end try';
  execFile('osascript', ['-e', appleScript], { timeout: DIALOG_TIMEOUT_MS }, function (err, stdout) {
    if (err) {
      if (err.killed) return callback({ statusCode: 504, message: '文件选择窗口超时未响应(已自动关闭)' });
      return callback({ statusCode: 500, message: 'osascript 弹框失败:' + err.message });
    }
    const out = String(stdout || '').trim();
    if (!out || out === '__CANCELED__') return callback(null, null);
    callback(null, out);
  });
}

function openDialogLinux(callback) {
  const args = [
    '--file-selection',
    '--title=Select sandbox app HTML',
    '--file-filter=HTML files | *.html *.htm',
    '--filename=' + SANDBOX_SDK_ROOT + path.sep,
  ];
  execFile('zenity', args, { timeout: DIALOG_TIMEOUT_MS }, function (err, stdout) {
    if (err) {
      if (err.code === 'ENOENT') {
        return callback({ statusCode: 501, message: '当前 Linux 环境未安装 zenity,无法弹出原生文件选择对话框' });
      }
      if (err.killed) return callback({ statusCode: 504, message: '文件选择窗口超时未响应(已自动关闭)' });
      // zenity 用户取消时以非零退出码 + 空 stdout 返回,视为取消(不算错误)。
      return callback(null, null);
    }
    const out = String(stdout || '').trim();
    callback(null, out || null);
  });
}

function handlePick(req, res, testParam) {
  if (pickInFlight) {
    sendJson(res, 409, { error: '已经有一个文件选择窗口在弹出中,请先在桌面处理它。' });
    return;
  }
  const isTestShortcut = ALLOW_TEST_PICK && testParam;
  if (isTestShortcut) {
    // 测试注入路径(仅 --allow-test-pick 显式开启时生效):跳过真实弹框,直接按该
    // 路径走完整的后续分类逻辑,供自动化冒烟使用。这条通道本身已经要求显式的
    // --allow-test-pick 命令行旗标才能生效,生产环境不启用,因此不再叠加下面的
    // Sec-Fetch-Site 同源校验(冒烟脚本用 Node http 直连,不会带这类浏览器专属头)。
    sendJson(res, 200, classifySelectedPath(testParam));
    return;
  }
  // pick 会弹出真实系统对话框,是高危端点——真实弹框这条路径上,缺
  // Origin 时进一步要求 Sec-Fetch-Site: same-origin(浏览器自身设置、页面 JS 无法
  // 伪造)兜底证明请求确实来自同源页面的 fetch,而不是被诱导发起的跨源请求。
  const originHeader = req.headers.origin;
  if (!originHeader) {
    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite !== 'same-origin') {
      sendPlainText(res, 403, '403 forbidden: pick 接口要求同源请求(缺少 Origin 与 Sec-Fetch-Site: same-origin)');
      return;
    }
  }
  pickInFlight = true;
  openNativeDialog(function (err, selectedPath) {
    pickInFlight = false;
    if (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || String(err) });
      return;
    }
    if (!selectedPath) {
      sendJson(res, 200, { canceled: true });
      return;
    }
    sendJson(res, 200, classifySelectedPath(selectedPath));
  });
}

// 挂载路径未命中(mount id 不存在,或存在但该文件不在挂载目录里)时的兜底:请求的
// basename 是 sdk.js → 回落伺服当前大版本的 sdk.js(应用相对引用 `../sdk.js`
// 时,浏览器解析出的地址正好落在这个分支——见文件头注释);其余一律 404。
function serveMountedFallbackOrNotFound(req, res, pathname) {
  if (path.posix.basename(pathname) === 'sdk.js') {
    serveFile(req, res, CURRENT_MAJOR_SDK_JS_PATH, pathname, SANDBOX_SDK_ROOT_REAL);
    return;
  }
  sendPlainText(res, 404, '404 not found: 挂载路径未命中「' + pathname + '」(挂载可能已随服务器重启失效)');
}

function handleMountedRequest(req, res, pathname) {
  const rest = pathname.slice(MOUNTED_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  const id = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const subPathRaw = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
  const mountDir = mounts[id];

  if (!mountDir) {
    serveMountedFallbackOrNotFound(req, res, pathname);
    return;
  }

  let decodedSub;
  try {
    decodedSub = decodeURIComponent(subPathRaw);
  } catch (e) {
    sendPlainText(res, 400, '400 bad request: 路径解码失败「' + pathname + '」');
    return;
  }
  // 挂载路由同样要挡 NUL 字节,否则 fs.stat 同步抛崩进程。
  if (decodedSub.indexOf('\0') !== -1) {
    sendPlainText(res, 403, '403 forbidden: 路径包含非法字符「' + pathname + '」');
    return;
  }
  const target = path.normalize(path.join(mountDir, decodedSub));
  const mountRootWithSep = mountDir + path.sep;
  if (target !== mountDir && target.indexOf(mountRootWithSep) !== 0) {
    sendPlainText(res, 403, '403 forbidden: 路径超出挂载目录范围「' + pathname + '」');
    return;
  }
  fs.stat(target, function (statErr, stat) {
    if (statErr || !stat.isFile()) {
      serveMountedFallbackOrNotFound(req, res, pathname);
      return;
    }
    serveFile(req, res, target, pathname, mountDir);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendPlainText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// 静态文件伺服(GET 完整读取 / HEAD 只发头)——供根目录静态服务与挂载路由共用。
// allowedRootReal(可选):传入时,在响应前额外用 fs.realpath 解析 filePath 的真实
// 路径,校验其落在该 root(同样已是 realpath)内——防根内 junction/符号链接指向根外
// 造成越界读取。调用方需保证 allowedRootReal 本身已是 realpath。
function serveFile(req, res, filePath, displayPath, allowedRootReal) {
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendPlainText(res, 404, '404 not found: 找不到文件「' + displayPath + '」');
      return;
    }
    function respond() {
      const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || DEFAULT_MIME;
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        sendPlainText(res, 500, '500 internal error: 读取文件失败「' + displayPath + '」');
      });
      stream.pipe(res);
    }
    if (!allowedRootReal) {
      respond();
      return;
    }
    fs.realpath(filePath, (rpErr, real) => {
      if (rpErr) {
        sendPlainText(res, 404, '404 not found: 找不到文件「' + displayPath + '」');
        return;
      }
      const rootWithSep = allowedRootReal + path.sep;
      if (real !== allowedRootReal && real.indexOf(rootWithSep) !== 0) {
        sendPlainText(res, 403, '403 forbidden: 路径越界(符号链接)「' + displayPath + '」');
        return;
      }
      respond();
    });
  });
}

// Host 头主机名部分(去掉端口)必须落在本机白名单——挡 DNS rebinding:
// 攻击者页面先以自己域名通过 SOP,再把 DNS 解析改指向 127.0.0.1,此时浏览器发出的
// 请求 Host 头仍是攻击者域名而非 127.0.0.1/localhost,靠这一校验拦下。
function extractHostname(hostHeader) {
  if (!hostHeader) return '';
  const idx = hostHeader.lastIndexOf(':');
  return (idx === -1 ? hostHeader : hostHeader.slice(0, idx)).toLowerCase();
}

function isOriginAllowed(originHeader) {
  try {
    const u = new URL(originHeader);
    return ALLOWED_HOSTNAMES.has(u.hostname.toLowerCase());
  } catch (e) {
    return false;
  }
}

function handleRequest(req, res) {
  const hostHeader = req.headers.host || '';
  if (!ALLOWED_HOSTNAMES.has(extractHostname(hostHeader))) {
    sendPlainText(res, 403, '403 forbidden: 非法 Host「' + hostHeader + '」');
    return;
  }

  const rawUrl = req.url || '/';
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);

  // /__sandbox-dev/* (apps、pick、mounted)额外校验 Origin(若存在),
  // 主机名同为本机白名单。pick 端点的同源性额外收紧放在 handlePick 里(见那边注释:
  // --allow-test-pick 的测试注入通道要豁免,否则冒烟脚本直连 HTTP 会被拦)。
  if (pathname.indexOf(SANDBOX_DEV_PREFIX) === 0) {
    const originHeader = req.headers.origin;
    if (originHeader && !isOriginAllowed(originHeader)) {
      sendPlainText(res, 403, '403 forbidden: 非法 Origin「' + originHeader + '」');
      return;
    }
  }

  if (req.method === 'GET' && pathname === APPS_API_PATH) {
    sendJson(res, 200, { apps: scanApps() });
    return;
  }

  if (req.method === 'GET' && pathname === PICK_API_PATH) {
    const query = new URLSearchParams(qIdx === -1 ? '' : rawUrl.slice(qIdx + 1));
    handlePick(req, res, query.get('test'));
    return;
  }

  if (pathname.indexOf(MOUNTED_PREFIX) === 0) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendPlainText(res, 405, '405 method not allowed: ' + req.method);
      return;
    }
    handleMountedRequest(req, res, pathname);
    return;
  }

  // latest 别名:示例页面用 `<script src="../sdk.js">` 相对引用,浏览器解析出的绝对路径
  // 就是 SDK_ALIAS_PATH——这个位置磁盘上没有真文件(唯一真源在 versions/v<n>/ 下),不特殊
  // 处理会直接 404、页面白屏。语义:永远指向当前 major。
  if (pathname === SDK_ALIAS_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendPlainText(res, 405, '405 method not allowed: ' + req.method);
      return;
    }
    serveFile(req, res, CURRENT_MAJOR_SDK_JS_PATH, pathname, SANDBOX_SDK_ROOT_REAL);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendPlainText(res, 405, '405 method not allowed: ' + req.method);
    return;
  }

  const filePath = resolveSafePath(pathname);
  if (!filePath) {
    sendPlainText(res, 403, '403 forbidden: 路径超出静态根目录范围「' + pathname + '」');
    return;
  }
  // 应用目录里没有自带 sdk.js 时(平台上传后同样由平台在包根注入),`<script src="sdk.js">`
  // 兜底成当前大版本的 sdk.js,开发时不必手工复制。
  if (
    path.basename(filePath) === 'sdk.js' &&
    !fs.existsSync(filePath) &&
    !isUnderVersionsRoot(pathname) // sandbox-sdk 根下首段为 versions:写错版本号应 404,不兜底
  ) {
    serveFile(req, res, CURRENT_MAJOR_SDK_JS_PATH, pathname, SANDBOX_SDK_ROOT_REAL);
    return;
  }
  serveFile(req, res, filePath, pathname, SANDBOX_SDK_ROOT_REAL);
}

// 起服后自动打开默认浏览器到 dev.html(--no-open 时跳过)。跨平台命令不同,失败不致命——打印 URL 供手动
// 打开即可(比如没有图形界面的环境)。
function openBrowser(url) {
  let cmd;
  if (process.platform === 'win32') {
    cmd = 'start "" "' + url + '"';
  } else if (process.platform === 'darwin') {
    cmd = 'open "' + url + '"';
  } else {
    cmd = 'xdg-open "' + url + '"';
  }
  exec(cmd, (err) => {
    if (err) {
      console.log('未能自动打开浏览器(可手动访问上面的地址):' + err.message);
    }
  });
}

function startServer(port, retriesLeft) {
  const server = http.createServer(handleRequest);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      console.log('端口 ' + port + ' 被占用,尝试 ' + (port + 1) + ' ...');
      server.close();
      startServer(port + 1, retriesLeft - 1);
    } else {
      console.error('启动失败:' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, BIND_HOST, () => {
    const url = 'http://localhost:' + port + DEV_HTML_PATH;
    console.log('Sandbox dev 服务已启动:http://' + BIND_HOST + ':' + port + '/(仅本机可访问)');
    console.log('静态根目录:' + SANDBOX_SDK_ROOT);
    console.log('打开调试台:' + url);
    if (ALLOW_TEST_PICK) {
      console.log('警告:已开启 --allow-test-pick,/__sandbox-dev/pick?test= 会跳过真实弹框——仅供自动化冒烟使用,不要在日常使用中开启。');
    }
    if (!NO_OPEN) openBrowser(url);
  });
}

if (require.main === module) {
  const port = parsePort(process.argv.slice(2));
  startServer(port, MAX_PORT_RETRIES);
}

module.exports = { scanApps, resolveSafePath, isUnderVersionsRoot, parsePort, classifySelectedPath };
