#!/usr/bin/env node
/**
 * pack.js —— 把一个应用目录打成可上传到 paranovell「发布应用」页的 zip 包。零依赖。
 *
 * 用法:
 *   node scripts/pack.js <应用目录> [--out <输出目录>] [--sdk-major <n>]
 *   npm run pack examples/hello
 *
 * 它做的事:
 *   1. 把应用目录的**内容**(不是外层文件夹)压成 zip,包根就是应用目录本身;
 *   2. 包根没有 sdk.js 时,从 versions/v<n>/sdk.js 补一份(上传后平台会把包根 sdk.js
 *      替换为平台当前版本,带不带都行);
 *   3. 打包前自检:清单、入口、SDK 引用写法、调试文件引用、体积/文件数限额;
 *      有硬错误则非零退出、不写 zip。
 *
 * 输出:<输出目录>/<应用目录名>.zip,默认输出目录是仓库根下的 dist/。
 * 同样的输入产出逐字节相同的 zip(时间戳固定)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO_ROOT = path.resolve(__dirname, '..');
const VERSIONS_DIR = path.join(REPO_ROOT, 'versions');
const DEFAULT_OUT = path.join(REPO_ROOT, 'dist');

// 平台上传校验的限额(与「发布应用」页一致)。
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;
const MAX_FILE_COUNT = 1000;
const MAX_APP_NAME_LEN = 100;
const MAX_CANVASES_BYTES = 64 * 1024;

const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', '__MACOSX', 'node_modules', '.git']);
const TEXT_EXT = /\.(html?|css|js|mjs|json|svg)$/i;

function listFiles(rootDir) {
  const out = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (SKIP_NAMES.has(entry.name)) return;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('包内不允许符号链接:' + abs);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    });
  })(rootDir);
  return out
    .map((abs) => ({ abs, name: path.relative(rootDir, abs).split(path.sep).join('/') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function detectLatestSdkMajor() {
  const majors = fs
    .readdirSync(VERSIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => /^v(\d+)$/.exec(e.name))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  if (!majors.length) throw new Error('versions/ 下没有 v<n> 目录');
  return Math.max(...majors);
}

function buildPackage(appDir, opts) {
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    throw new Error('应用目录不存在:' + appDir);
  }
  const files = new Map();
  listFiles(appDir).forEach((f) => files.set(f.name, fs.readFileSync(f.abs)));

  const errors = [];
  const warnings = [];

  // 清单
  let manifest = null;
  if (!files.has('paranovell.json')) {
    errors.push('包根缺少 paranovell.json(最小合法内容是 {})');
  } else {
    try {
      manifest = JSON.parse(files.get('paranovell.json').toString('utf8'));
      if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
        errors.push('paranovell.json 必须是一个 JSON 对象');
        manifest = null;
      }
    } catch (e) {
      errors.push('paranovell.json 不是合法 JSON:' + e.message);
    }
  }
  const entry = (manifest && manifest.entry) || 'index.html';
  if (manifest) {
    if (manifest.appName !== undefined && [...String(manifest.appName)].length > MAX_APP_NAME_LEN) {
      errors.push('appName 超过 ' + MAX_APP_NAME_LEN + ' 字');
    }
    if (manifest.canvases !== undefined && Buffer.byteLength(JSON.stringify(manifest.canvases)) > MAX_CANVASES_BYTES) {
      errors.push('canvases 声明超过 64 KB');
    }
    if (manifest.entry !== undefined && !/\.html?$/i.test(String(manifest.entry))) {
      errors.push('entry 必须指向一个 .html 文件:' + manifest.entry);
    }
  }
  if (!files.has(entry)) {
    errors.push('入口文件不存在:' + entry + (manifest && manifest.entry ? '(paranovell.json 的 entry)' : '(默认入口 index.html)'));
  }

  // SDK 随包:没有就补
  let sdkMajor = null;
  if (!files.has('sdk.js')) {
    sdkMajor = opts.sdkMajor || detectLatestSdkMajor();
    const sdkSrc = path.join(VERSIONS_DIR, 'v' + sdkMajor, 'sdk.js');
    if (!fs.existsSync(sdkSrc)) throw new Error('SDK 不存在:' + sdkSrc);
    files.set('sdk.js', fs.readFileSync(sdkSrc));
  }

  // 逐文件扫描
  for (const [name, buf] of files) {
    if (!TEXT_EXT.test(name)) continue;
    const text = buf.toString('utf8');
    if (/\.html?$/i.test(name)) {
      if (/mock-host|paranovell-dev|__sandbox-dev/.test(text)) {
        errors.push(name + ' 引用了调试台文件(mock-host / paranovell-dev),平台会拒收');
      }
      (text.match(/<script\b[^>]*>/gi) || []).forEach((tag) => {
        const m = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (!m || !/(^|\/)sdk\.js$/.test(m[1])) return;
        if (m[1] !== 'sdk.js' && m[1] !== './sdk.js') {
          warnings.push(name + ':SDK 引用 ' + m[1] + ' 不在包根 sdk.js,上传后可能找不到 SDK');
        }
        if (/\b(defer|async)\b|type\s*=\s*["']module["']/i.test(tag)) {
          warnings.push(name + ':sdk.js 的 <script> 带了 defer / async / type="module",SDK 可能未就绪就被引用');
        }
      });
    }
    if (/\bnew\s+(Shared)?Worker\s*\(/.test(text) && !/createObjectURL/.test(text)) {
      warnings.push(name + ':new Worker(...) 且没有 createObjectURL,同源 worker 在沙盒里起不来');
    }
    if (/\b(localStorage|sessionStorage|indexedDB)\b/.test(text) && name !== 'sdk.js') {
      warnings.push(name + ':出现 localStorage / sessionStorage / indexedDB,沙盒内会抛 SecurityError,请改用 paranovell.data.*');
    }
    if (/RTCPeerConnection/.test(text) && name !== 'sdk.js') {
      errors.push(name + ' 使用了 WebRTC,平台会拒收');
    }
  }

  // 限额
  if (files.size > MAX_FILE_COUNT) errors.push('文件数 ' + files.size + ' 超过 ' + MAX_FILE_COUNT);
  let total = 0;
  for (const buf of files.values()) total += buf.length;
  if (total > MAX_UNCOMPRESSED_BYTES) errors.push('解压后体积超过 150 MB');

  return { files, manifest, entry, sdkMajor, errors, warnings };
}

// ---------------------------------------------------------------------------
// 极简 ZIP 写入器(STORE / DEFLATE),零依赖;时间戳固定,产物可复现
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, raw] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // bit 11 = UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { appDir: null, outDir: DEFAULT_OUT, sdkMajor: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = path.resolve(argv[++i]);
    else if (a === '--sdk-major') out.sdkMajor = Number(argv[++i]);
    else if (!a.startsWith('-') && !out.appDir) out.appDir = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.appDir) {
    console.error('用法: node scripts/pack.js <应用目录> [--out 输出目录] [--sdk-major n]');
    console.error('例如: npm run pack examples/hello');
    process.exit(2);
  }
  const appDir = path.resolve(args.appDir);
  const result = buildPackage(appDir, args);

  console.log('应用目录: ' + appDir);
  console.log('入口    : ' + result.entry);
  if (result.sdkMajor) console.log('sdk.js  : 包内没有,已补入 v' + result.sdkMajor);
  console.log('文件 ' + result.files.size + ' 个:');
  for (const [name, buf] of result.files) {
    console.log('  ' + name.padEnd(30) + String(buf.length).padStart(9) + ' B');
  }
  result.warnings.forEach((w) => console.log('  ! 告警:' + w));

  if (result.errors.length) {
    console.error('\n打包前自检未通过:');
    result.errors.forEach((e) => console.error('  x ' + e));
    process.exit(1);
  }

  const zip = buildZip(result.files);
  if (zip.length > MAX_PACKAGE_BYTES) {
    console.error('\n  x zip 体积超过 50 MB:' + zip.length + ' B');
    process.exit(1);
  }
  fs.mkdirSync(args.outDir, { recursive: true });
  const zipPath = path.join(args.outDir, path.basename(appDir) + '.zip');
  fs.writeFileSync(zipPath, zip);
  console.log('\n自检通过。已写出:' + zipPath);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('打包失败:' + e.message);
    process.exit(1);
  }
}

module.exports = { buildPackage, buildZip };
