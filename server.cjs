// server.cjs — 单音频精简版
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');

// ===== 配置 =====
const PORT = process.env.PORT || 10000;
const OUT_DIR = path.resolve(process.cwd(), 'output');
const TMP_DIR = path.join(os.tmpdir(), 'ffmpeg-svc-tmp');

// ffmpeg/ffprobe 路径（若系统 PATH 已有 ffmpeg，就保持默认 'ffmpeg'）
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// ===== 小工具 =====
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function fetchToFile(url, filePath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText}`);
  const file = fs.createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on('error', reject);
    file.on('finish', resolve);
    file.on('error', reject);
  });
  return filePath;
}

function runFFmpeg(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { cwd });
    let errBuf = [];
    let errSize = 0;
    const ERR_CAP = 200 * 1024; // 只保留 200KB 的 stderr 尾部，防 OOM

    p.stderr.on('data', c => {
      errSize += c.length;
      errBuf.push(c);
      while (errSize > ERR_CAP && errBuf.length) {
        errSize -= errBuf[0].length;
        errBuf.shift();
      }
    });

    p.on('close', code => {
      const errTxt = Buffer.concat(errBuf).toString('utf8');
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exit ${code}\n${errTxt}`));
    });
    p.on('error', reject);
  });
}

function nowUid() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function buildBaseUrl(req) {
  // 优先用环境变量（可在 Render 环境里设 PUBLIC_BASE_URL）
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  // 否则用请求头拼
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  return `${proto}://${host}`;
}

// 把路径里冒号等特殊字符做 ffmpeg 字符串转义
function ffEscape(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// ===== 应用 =====
const app = express();
app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1);

// 输出目录静态托管
app.use('/output', express.static(OUT_DIR, { maxAge: '1y', fallthrough: false }));

// 健康检查
app.get(['/healthz', '/health'], (req, res) => res.json({ ok: true }));

// 便捷查看输出目录
app.get('/__debug__/ls', async (req, res) => {
  await ensureDir(OUT_DIR);
  const files = await fsp.readdir(OUT_DIR);
  res.json({ files });
});

// 核心：单音频合成
app.post('/make/segments', async (req, res) => {
  // 防止代理/keepalive 导致“空回复”
  res.setHeader('Connection', 'close');
  res.setTimeout(0);

  const {
    image_url,
    audio_url,                 // ✅ 单音频：用这个字段
    // 兼容你之前传数组的情况：如果提供了 audio_urls，则取第一个，但以后不推荐
    audio_urls,
    outfile_prefix = 'output',
    resolution = '1080x1920',
    fps = 30,
    motion = 'none',           // 'none' | 'shake'
    // 可选：烧字幕（SRT 直链）
    subtitle_url,              // 传了就烧到画面
    // 编码参数
    video = { preset: 'veryfast', crf: 20, threads: 1 }
  } = req.body || {};

  if (!image_url) return res.status(400).json({ error: 'image_url required' });
  const finalAudio = audio_url || (Array.isArray(audio_urls) ? audio_urls[0] : undefined);
  if (!finalAudio) return res.status(400).json({ error: 'audio_url required' });

  try {
    await ensureDir(OUT_DIR);
    await ensureDir(TMP_DIR);

    const uid = nowUid();

    // 下载到临时目录
    const imgPath = path.join(TMP_DIR, `img_${uid}.png`);
    const audPath = path.join(TMP_DIR, `aud_${uid}.mp3`);
    await fetchToFile(image_url, imgPath);
    await fetchToFile(finalAudio, audPath);

    let srtPath = null;
    if (subtitle_url) {
      srtPath = path.join(TMP_DIR, `sub_${uid}.srt`);
      await fetchToFile(subtitle_url, srtPath);
    }

    // 输出文件名 / 路径
    const outName = `${outfile_prefix}_${Date.now()}.mp4`;
    const outPath = path.join(OUT_DIR, outName);

    // 解析分辨率
    const [W, H] = (resolution || '1080x1920').split('x').map(n => parseInt(n, 10) || 0);
    if (!W || !H) throw new Error(`bad resolution: ${resolution}`);

    // 构造滤镜
    // 统一放大一点再裁切，防止抖动露黑边
    const scaleW = Math.ceil(W * 1.12);
    const scaleH = Math.ceil(H * 1.12);

    const filters = [];
    filters.push(`scale=${scaleW}:${scaleH}`);

    if (motion === 'shake') {
      // 轻微抖动：沿用你在本地试过的思路（sin/crop）
      const x = `'(in_w-out_w)/2 + 12*sin(t*0.25) + 3*sin(t*3.0)'`;
      const y = `'(in_h-out_h)/2 +  8*sin(t*0.21) + 2*sin(t*2.5)'`;
      filters.push(`crop=${W}:${H}:${x}:${y}`);
      filters.push(`fps=${fps}`);
    } else {
      // 没有抖动：直接铺满到目标
      filters.push(`crop=${W}:${H}`);
      filters.push(`fps=${fps}`);
    }

    // 烧字幕（如果有）
    if (srtPath) {
      // 注意：subtitles 读取本地文件路径，需要转义
      const esc = ffEscape(srtPath);
      // 你可以按需调整 force_style
      filters.push(`subtitles='${esc}':force_style='FontSize=28,Outline=2,Shadow=1,PrimaryColour=&HFFFFFF&'`);
    }

    // 像素格式
    filters.push(`format=yuv420p`);

    const vf = filters.join(',');

    // 组装 ffmpeg 参数
    const args = [
      '-y',
      '-loop', '1', '-i', imgPath,
      '-i', audPath,
      '-filter:v', vf,
      '-c:v', 'libx264',
      '-preset', (video && video.preset) || 'veryfast',
      '-crf', String((video && video.crf) || 20),
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      '-threads', String((video && video.threads) || 1),
      outPath
    ];

    await runFFmpeg(args, { cwd: OUT_DIR });

    const base = buildBaseUrl(req);
    const file_url = `${base}/output/${encodeURIComponent(outName)}`;

    // 清理临时文件（异步不阻塞响应）
    Promise.allSettled([fsp.unlink(imgPath), fsp.unlink(audPath), srtPath ? fsp.unlink(srtPath) : null]);

    res.json({ file_url });
  } catch (err) {
    console.error('make/segments error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// 兜底 404
app.use((req, res) => res.status(404).send('Not Found'));

// 启动 + 超时参数（防止代理掐连接）
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ready] listening on ${PORT}`);
});
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
