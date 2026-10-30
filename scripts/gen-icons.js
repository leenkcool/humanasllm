#!/usr/bin/env node
/* gen-icons.js — 零依赖 PWA 图标生成器
 *
 * 不引入任何 npm 依赖：用 Node 内置 zlib 手写 PNG 编码器（8-bit RGBA、无交错、
 * 每行前置 filter byte 0、IHDR/IDAT/IEND 三个 chunk、自实现 CRC32）。
 *
 * 图形：品牌蓝 #2563eb 圆角方块 + 白色机器人轮廓（天线圆点 + 颈部连杆 +
 * 圆角矩形头身 + 两只蓝色眼睛），与 public/workbench.html 第 17 行的
 * 内联 SVG 机器人图标保持同一视觉语言（像素级近似，不追求精确还原）。
 *
 * 用法：node scripts/gen-icons.js   （可重复运行，覆盖生成）
 * 产物：public/icons/icon-192.png、icon-512.png、icon-maskable-512.png
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// ===== 颜色 =====
const BLUE = [37, 99, 235];      // #2563eb 品牌主色
const WHITE = [255, 255, 255];

// ===== CRC32（PNG chunk 校验）=====
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

// ===== PNG chunk 封装 =====
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// 把 RGBA 原始像素编码为完整 PNG 文件
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    raw[off] = 0; // filter type 0 = None
    rgba.copy(raw, off + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);   // 宽
  ihdr.writeUInt32BE(height, 4);  // 高
  ihdr[8] = 8;                    // bit depth 8
  ihdr[9] = 6;                    // color type 6 = RGBA
  ihdr[10] = 0;                   // compression = deflate
  ihdr[11] = 0;                   // filter = adaptive
  ihdr[12] = 0;                   // interlace = none

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ===== 几何判定 =====
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  // 把点夹到「圆角中心可活动的核心矩形」上，再判距最近圆角中心的距离
  const nx = Math.min(Math.max(x, x0 + r), x1 - r);
  const ny = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - nx, dy = y - ny;
  return dx * dx + dy * dy <= r * r;
}

// 机器人几何（归一化 0~1 坐标，基于整张画布）
const ROBOT = {
  antenna: { cx: 0.5, cy: 0.215, r: 0.058 },
  neck: { x0: 0.482, y0: 0.205, x1: 0.518, y1: 0.40 },
  body: { x0: 0.225, y0: 0.385, x1: 0.775, y1: 0.785, r: 0.105 },
  eyes: [
    { cx: 0.395, cy: 0.575, r: 0.048 },
    { cx: 0.605, cy: 0.575, r: 0.048 },
  ],
};

/**
 * 生成取样函数：给定归一化坐标返回颜色（或 null = 透明）。
 * maskable=true 时：背景铺满整张画布（系统会自行裁切遮罩），
 * 机器人整体缩放到中心 80% 安全区内。
 */
function makeSampler(maskable) {
  const k = maskable ? 0.8 : 1.0;
  return function sample(x, y) {
    // 普通图标：圆角方块之外透明
    if (!maskable && !inRoundedRect(x, y, 0, 0, 1, 1, 0.22)) return null;

    // 缩放进安全区后，把坐标反变换回机器人基准坐标系
    const bx = 0.5 + (x - 0.5) / k;
    const by = 0.5 + (y - 0.5) / k;

    // 眼睛：叠在白色躯干上的蓝色圆点（先判眼睛，后判躯干）
    for (const e of ROBOT.eyes) {
      if (inCircle(bx, by, e.cx, e.cy, e.r)) return BLUE;
    }
    // 天线圆点 + 颈部连杆 + 圆角矩形头身
    if (inCircle(bx, by, ROBOT.antenna.cx, ROBOT.antenna.cy, ROBOT.antenna.r)) return WHITE;
    if (bx >= ROBOT.neck.x0 && bx <= ROBOT.neck.x1 && by >= ROBOT.neck.y0 && by <= ROBOT.neck.y1) return WHITE;
    if (inRoundedRect(bx, by, ROBOT.body.x0, ROBOT.body.y0, ROBOT.body.x1, ROBOT.body.y1, ROBOT.body.r)) return WHITE;

    return BLUE; // 背景
  };
}

// ===== 渲染（4x4 超采样抗锯齿）=====
function render(size, maskable) {
  const SS = 4;                  // 每轴 4 个子样本 → 16 样本/像素
  const n = SS * SS;
  const buf = Buffer.alloc(size * size * 4);
  const sample = makeSampler(maskable);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        const y = (py + (sy + 0.5) / SS) / size;
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const c = sample(x, y);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; covered++;
        }
      }
      const i = (py * size + px) * 4;
      if (covered === 0) {
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
        continue;
      }
      // PNG 用直通 alpha：颜色取「被覆盖样本」的平均，alpha 取覆盖率
      buf[i] = Math.round(r / covered);
      buf[i + 1] = Math.round(g / covered);
      buf[i + 2] = Math.round(b / covered);
      buf[i + 3] = Math.round(255 * covered / n);
    }
  }
  return buf;
}

// ===== 产物校验：读回 PNG 并解析 IHDR =====
function verify(file, expectSize) {
  const b = fs.readFileSync(file);
  const sigOk = b.length > 33 &&
    b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  const ihdrType = b.slice(12, 16).toString('ascii');
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const bitDepth = b[24];
  const colorType = b[25];
  const ok = sigOk && ihdrType === 'IHDR' && w === expectSize && h === expectSize &&
    bitDepth === 8 && colorType === 6;
  return { file, bytes: b.length, w, h, bitDepth, colorType, sigOk, ok };
}

// ===== 主流程 =====
const TARGETS = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
for (const t of TARGETS) {
  const file = path.join(OUT_DIR, t.name);
  const rgba = render(t.size, t.maskable);
  const png = encodePNG(t.size, t.size, rgba);
  fs.writeFileSync(file, png);
  results.push(verify(file, t.size));
}

console.log('生成 PWA 图标（零依赖 PNG 编码器）：');
let allOk = true;
for (const r of results) {
  if (!r.ok) allOk = false;
  console.log(
    `  ${r.ok ? 'OK  ' : 'FAIL'} ${r.file}  ${r.bytes} 字节  ` +
    `IHDR ${r.w}x${r.h}  bitDepth=${r.bitDepth} colorType=${r.colorType}  ` +
    `PNG签名=${r.sigOk ? '有效' : '无效'}`
  );
}

if (!allOk) {
  console.error('图标校验失败：尺寸/格式不符合预期');
  process.exit(1);
}
console.log('全部图标校验通过。');
