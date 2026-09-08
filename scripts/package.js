/**
 * ============================================================================
 * scripts/package.js — 一键打包发行包（绿色免安装版）
 * ============================================================================
 * 用法：
 *   node scripts/package.js             打「绿色版」：附带 node_modules，
 *                                       解压后无需 npm install 直接运行（需机器有 Node.js）
 *   node scripts/package.js --no-deps   打「源码版」：不带依赖，目标机器需先 npm install
 *
 * 产物：dist/danmu-games_v<版本>_<日期>[-src].zip（压缩包内根目录为 danmu-games/）
 * 纯 Node 实现（zlib deflate + 标准 ZIP 结构），无任何子进程/外部工具依赖。
 *
 * 不入包内容（运行时数据/本机状态，含真实观众信息与隐私）：
 *   node_modules（--no-deps 时）、dist、log、.git、.mimosa、gui-test-screenshots、
 *   data/ 运行数据（排行榜、赛季名册——首启自动重建空榜）、host/host.json（首启自动生成）、
 *   各类 *.log / *.bak / *.back / *.tmp
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const withDeps = !process.argv.includes('--no-deps');
const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT_NAME = `danmu-games_v${pkg.version}_${date}${withDeps ? '' : '_src'}.zip`;

const DIST = path.join(ROOT, 'dist');
// 暂存目录必须位于工程外（cpSync 禁止把目录拷进自身子目录），用系统临时目录
const os = require('os');
const STAGE_ROOT = path.join(os.tmpdir(), `danmu-games-pkg-${process.pid}`);
const STAGE = path.join(STAGE_ROOT, 'danmu-games');

/* ───────────── 拷贝白名单 ───────────── */

// 整体排除的目录名（任意层级）；node_modules 单独处理（仅 --no-deps 源码版排除）
const EXCLUDE_DIRS = new Set([
  'dist', 'staging', 'log', 'logs',
  '.git', '.github', '.mimosa', '.vscode', 'gui-test-screenshots', 'data',
]);
const EXCLUDE_SUFFIX = /\.(log|bak|back|tmp)$/i;
const EXCLUDE_FILES = new Set(['host/host.json']);

function filter(src) {
  const rel = path.relative(ROOT, src).replace(/\\/g, '/');
  if (rel === '') return true;                       // 根目录本身
  const top = rel.split('/')[0];
  if (top === 'data') return false;                  // 运行数据整体不入包（打包时重建空 data/.gitkeep）
  if (top === 'node_modules' && !withDeps) return false;   // 源码版不带依赖
  if (EXCLUDE_DIRS.has(top)) return false;
  if (EXCLUDE_DIRS.has(path.basename(src))) return false;
  if (EXCLUDE_FILES.has(rel)) return false;
  if (EXCLUDE_SUFFIX.test(path.basename(src))) return false;
  return true;
}

/* ───────────── 路径边界守卫 ───────────── */

/** 目标必须落在 root 内（防路径穿越；遍历来自受控 readdir，此处为显式断言） */
function inside(root, p) {
  const r = path.resolve(root);
  const t = path.resolve(p);
  return t === r || t.startsWith(r + path.sep);
}

/* ───────────── 纯 Node ZIP 写入器（deflate / store） ───────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** files: [{ rel: '包内路径(/ 分隔)', abs: '磁盘绝对路径' }]，abs 必须落在 STAGE 内 */
function writeZip(files, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    if (!inside(STAGE, f.abs)) throw new Error(`路径越界: ${f.abs}`);
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const { time, date } = dosTime(fs.statSync(f.abs).mtime);
    const raw = fs.readFileSync(f.abs);
    const crc = crc32(raw);
    // 压缩有效才用 deflate（method 8），否则原样存储（method 0）
    const def = zlib.deflateRawSync(raw);
    const useDeflate = def.length < raw.length;
    const payload = useDeflate ? def : raw;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);            // local file header 签名
    lh.writeUInt16LE(20, 4);                    // 解压所需版本
    lh.writeUInt16LE(0x0800, 6);                // 标志位 bit11：UTF-8 文件名
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);    // 压缩方法
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);       // 压缩后大小
    lh.writeUInt32LE(raw.length, 22);           // 原始大小
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);                    // extra 长度
    chunks.push(lh, nameBuf, payload);

    central.push({ nameBuf, method: useDeflate ? 8 : 0, crc, cSize: payload.length, uSize: raw.length, time, date, offset });
    offset += 30 + nameBuf.length + payload.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);            // central directory 签名
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);                // UTF-8 文件名
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(e.time, 12);
    ch.writeUInt16LE(e.date, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(e.cSize, 20);
    ch.writeUInt32LE(e.uSize, 24);
    ch.writeUInt16LE(e.nameBuf.length, 28);
    ch.writeUInt32LE(e.offset, 42);             // 本地头偏移
    chunks.push(ch, e.nameBuf);
    offset += 46 + e.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);            // EOCD 签名
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);     // central directory 大小
  eocd.writeUInt32LE(cdStart, 16);              // central directory 偏移
  chunks.push(eocd);

  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

/* ───────────── 主流程 ───────────── */

function walkFiles(dir, base) {
  if (!inside(STAGE, dir)) throw new Error(`路径越界: ${dir}`);
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(abs, rel));
    else out.push({ rel, abs });
  }
  return out;
}

function main() {
  console.log('════════════ 弹幕互动游戏中心 · 打包 ════════════');
  console.log(`版本：v${pkg.version} · 模式：${withDeps ? '绿色版（附带依赖）' : '源码版（需 npm install）'}`);

  // 1) 清理旧产物与暂存目录
  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  // 2) 拷贝工程（按过滤规则）+ 重建空 data 占位（首启自动生成空排行榜）
  fs.cpSync(ROOT, STAGE, { recursive: true, filter });
  fs.mkdirSync(path.join(STAGE, 'data'), { recursive: true });
  fs.writeFileSync(path.join(STAGE, 'data', '.gitkeep'), '');

  // 3) 压缩
  const outPath = path.join(DIST, OUT_NAME);
  fs.mkdirSync(DIST, { recursive: true });
  fs.rmSync(outPath, { force: true });
  writeZip(walkFiles(STAGE, 'danmu-games'), outPath);

  // 4) 汇报并清理暂存
  const files = walkFiles(STAGE, '').length;
  const size = fs.statSync(outPath).size;
  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  console.log('════════════════════════════════════════════════');
  console.log(`  打包完成：dist/${OUT_NAME}`);
  console.log(`  文件数 ${files} · 包大小 ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log('  使用方式：解压到任意目录 → 双击「一键启动.bat」');
  console.log('  启动后在 DanmuDesk 填 ws://127.0.0.1:18080/danmu 并勾选转发；');
  console.log('  主播台 http://127.0.0.1:18080/control.html （各游戏控制台左侧切换）');
  if (!withDeps) console.log('  （源码版需先在包内执行 npm install）');
  console.log('════════════════════════════════════════════════');
}

try {
  main();
} catch (e) {
  console.error('打包失败:', e.message);
  process.exit(1);
}
