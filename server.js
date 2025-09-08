// server.js
// --------------- 基础依赖 ---------------
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');

// --------------- App 初始化 ---------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --------------- 输出目录 & 静态托管 ---------------
const OUTPUT_DIR = path.join(process.cwd(), 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// /output/xxx.mp4 可直接 GET
app.use('/output', express.static(OUTPUT_DIR, { fallthrough: false }));

// --------------- 小工具函数 ---------------
function publicBaseUrl(req) {
  // 优先使用环境变量（Render Dashboard → Environment → PUBLIC_BASE_URL）
  // 例如：https://ffmpeg-service-kunkaka.onrender.com
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https');
  const host = req.get('host');
  return `${proto}://${host}`;
}

function sh(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// 构建 ffmpeg 音频输入列表与 concat 过滤器（顺序拼接多段音频）
function buildAudioConcatInputs(audioUrls = []) {
  // 返回：{ inputs: ['-i', url1, '-i', url2, ...], filter: "concat=n=2:v=0:a=1[outa]" }
  if (!Array.isArray(audioUrls) || audioUrls.length === 0) {
    throw new Error('audio_urls must be a non-empty array');
  }
  const inputs = [];
  for (const u of audioUrls) {
    inputs.push('-i', u);
  }
  const n = audioUrls.length;
  const filter = `concat=n=${n}:v=0:a=1[outa]`;
  return { inputs, filter };
}

// 简单伪动效（可选）
// mode: 'none' | 'subtle' | 'verticalSubtle'
// size: {w,h}, fps: number
function buildMotionFilter(mode, size, fps) {
  const { w, h } = size;
  if (mode === 'verticalSubtle') {
    return [
      `[0:v]`,
      `scale=ceil(${w}*1.22):ceil(${h}*1.22),`,
      `crop=${w}:${h}:`,
      `x='(in_w-out_w)/2 + 20*sin(t*0.25) + 5*sin(t*4.2)':`,
      `y='(in_h-out_h)/2 + 16*sin(t*0.20) + 4*sin(t*3.5)',`,
      `rotate='0.005*sin(1.7*t)+0.002*cos(9*t)',`,
      `eq=contrast=1.06:brightness=-0.04:saturation=0.92,`,
      `noise=alls=7:allf=t,`,
      `rgbashift=rh=2:rv=2:gh=-2:gv=-2,`,
      `vignette=0.12:0.65,`,
      `fps=${fps},format=yuv420p[vbg]`
    ].join('');
  }
  if (mode === 'subtle') {
    return [
      `[0:v]`,
      `scale=ceil(${w}*1.12):ceil(${h}*1.12),`,
      `crop=${w}:${h}:`,
      `x='(in_w-out_w)/2 + 12*sin(t*0.25) + 3*sin(t*3.0)':`,
      `y='(in_h-out_h)/2 +  8*sin(t*0.21) + 2*sin(t*2.5)',`,
      `eq=contrast=1.05:brightness=-0.03:saturation=0.95,`,
      `vignette=0.1:0.6,`,
      `fps=${fps},format=yuv420p[vbg]`
    ].join('');
  }
  // none：只做尺寸格式化
  return [`[0:v]scale=${w}:${h},fps=${fps},format=yuv420p[vbg]`].join('');
}

// --------------- 健康检查 & 调试 ---------------
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/__debug__/ls', (_req, res) => {
  try {
    const files = fs.readdirSync(OUTPUT_DIR).sort();
    res.json({ OUTPUT_DIR, files });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --------------- 主路由：单图 + 多音频顺序拼接 ---------------
/**
 * POST /make/segments
 * body:
 * {
 *   "image_url": "<必填> 单张图片直链（png/jpg）",
 *   "audio_urls": ["<必填> 多段 mp3 直链，按顺序拼接"],
 *   "outfile_prefix": "demo_cli",             // 可选，默认 "video"
 *   "resolution": "1280x720" | "1080x1920",   // 可选，默认 "1280x720"
 *   "fps": 30,                                // 可选，默认 30
 *   "motion": "none" | "subtle" | "verticalSubtle"  // 可选，默认 'none'
 * }
 */
app.post('/make/segments', async (req, res) => {
  const {
    image_url,
    audio_urls,
    outfile_prefix = 'video',
    resolution = '1280x720',
    fps = 30,
    motion = 'none'
  } = req.body || {};

  if (!image_url || !Array.isArray(audio_urls) || audio_urls.length === 0) {
    return res.status(400).json({ ok: false, error: 'image_url and audio_urls[] are required' });
  }

  // 解析分辨率
  const m = String(resolution).match(/^(\d+)x(\d+)$/i);
  if (!m) return res.status(400).json({ ok: false, error: 'resolution must be like 1280x720' });
  const size = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };

  // 输出文件
  const stamp = Date.now();
  const filename = `${outfile_prefix}_${stamp}.mp4`;
  const outfile = path.join(OUTPUT_DIR, filename);

  try {
    // 构建音频输入和 concat
    const { inputs: audioInputs, filter: audioConcat } = buildAudioConcatInputs(audio_urls);

    // 伪动效（视频侧）
    const vFilter = buildMotionFilter(motion, size, fps);

    // 组装 filter_complex：
    //   [0:v]...(vFilter)->[vbg]
    //   若有多音频：concat n=audios -> [outa]
    //   最终 map [vbg] + [outa]
    const filterLines = [];
    filterLines.push(vFilter);
    filterLines.push(audioConcat);
    const filterComplex = `${filterLines.join(';')}`;

    // ffmpeg 参数
    const args = [
      '-y',
      '-loop', '1',
      '-i', image_url,
      ...audioInputs,
      '-filter_complex', filterComplex,
      '-map', '[vbg]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      outfile
    ];

    // 调用 ffmpeg（Render 镜像已预装；若自建，需要确保 ffmpeg 在 PATH）
    const { stderr } = await sh('ffmpeg', args);
    // 可选日志：console.log(stderr);

    const base = publicBaseUrl(req);
    const file_url = `${base}/output/${filename}`;
    return res.json({ ok: true, file_url, resolution, fps, motion });
  } catch (err) {
    console.error('[make/segments] error:', err.stderr || err.message || err);
    return res.status(500).json({
      ok: false,
      error: String(err.message || err),
      stderr: err.stderr ? String(err.stderr).slice(0, 2000) : undefined
    });
  }
});

// --------------- 兜底 ---------------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `No route: ${req.method} ${req.originalUrl}` });
});

// --------------- 启动 ---------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[ready] listening on ${PORT}`);
});
