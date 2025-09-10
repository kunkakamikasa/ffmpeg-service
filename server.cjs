// server.cjs
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawn } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 10000;

// —— 基础中间件 & 静态托管 —— //
app.use(express.json({ limit: '5mb' }));
const OUTPUT_DIR = '/tmp/output';
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use('/output', express.static(OUTPUT_DIR, { fallthrough: false }));

// —— 工具：下载远程文件到本地临时盘 —— //
async function downloadToTmp(url, ext) {
  const tmp = path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  const resp = await axios.get(url, { responseType: 'stream', timeout: 30000, maxRedirects: 5 });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    resp.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  return tmp;
}

// —— 生成 ffmpeg 滤镜串 —— //
function buildFilter(resolution, fps, motion) {
  // 目标分辨率
  const [W, H] = resolution.split('x').map(n => parseInt(n, 10) || 0);
  const outW = Math.max(16, W || 720);
  const outH = Math.max(16, H || 1280);
  const outFPS = fps || 24;

  // 让图片“铺满再裁切居中”，不会变形；避免你之前遇到的 cover 报错
  // 0:v → 图片
  // 先按比例放大到至少覆盖，再裁切为目标分辨率
  let cropXY = `x='(in_w-out_w)/2':y='(in_h-out_h)/2'`;

  if (motion === 'shake') {
    // 轻微抖动（±6 像素）
    cropXY = `x='(in_w-out_w)/2 + 6*sin(2*t)':y='(in_h-out_h)/2 + 6*sin(1.7*t)'`;
  } else if (motion === 'pan') {
    // 缓慢水平平移
    cropXY = `x='(in_w-out_w)/2 + 20*sin(0.3*t)':y='(in_h-out_h)/2'`;
  } else if (motion === 'zoom') {
    // 轻微呼吸式缩放（在裁切前先做一点点放大）
    // 利用 scale2ref + crop 组合
    // 注意：这里 zoom 的幅度很小，确保不会黑边
  }

  // 基础链：scale 以“增加”方式保证覆盖，随后裁切 & 设定帧率与像素格式
  // 对于 zoom，我们在外面拼接一点小缩放因子
  const zoomPrefix = (motion === 'zoom')
    ? `scale=${outW}*1.08:${outH}*1.08:flags=bicubic,`
    : '';

  const filter = `[0:v]${zoomPrefix}scale=${outW}:${outH}:force_original_aspect_ratio=increase,` +
                 `crop=${outW}:${outH}:${cropXY},fps=${outFPS},format=yuv420p[v]`;

  return { filter, outW, outH, outFPS };
}

// —— 合成接口 —— //
app.post('/make/segments', async (req, res) => {
  const startedAt = Date.now();
  try {
    const {
      image_url,
      audio_urls = [],
      outfile_prefix = 'out',
      resolution = '720x1280',
      fps = 24,
      motion = 'none',
      // 可选编码参数（给你预留）
      video = {}
    } = req.body || {};

    if (!image_url || !audio_urls.length) {
      return res.status(400).json({ error: 'image_url 和 audio_urls 必填' });
    }

    const audio_url = audio_urls[0];

    // 下载到本地临时盘
    const img = await downloadToTmp(image_url, 'png');
    const aud = await downloadToTmp(audio_url, 'mp3');

    const { filter } = buildFilter(resolution, fps, motion);

    // 输出文件名（完整 URL 用这个）
    const filename = `${outfile_prefix}_${Date.now()}.mp4`;
    const outPath  = path.join(OUTPUT_DIR, filename);

    // 编码参数（保守默认，避免 OOM）
    const preset  = video.preset  || 'veryfast';
    const crf     = (video.crf ?? 23);
    const threads = video.threads || 1;
    const bitrate = video.bitrate; // 可选

    // 组织 ffmpeg 参数
    const args = [
      '-y',
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',

      // 输入
      '-loop', '1', '-i', img,
      '-i', aud,

      // 复杂滤镜：video 走 [v]
      '-filter_complex', filter,

      // 输出映射
      '-map', '[v]',
      '-map', '1:a',

      // 编码器 & 参数
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-threads', String(threads),
    ];

    if (bitrate) args.push('-b:v', String(bitrate));

    // 音频
    args.push('-c:a', 'aac', '-b:a', '128k');

    // 与最短输入对齐，避免音频结束后黑帧
    args.push('-shortest');

    // 输出
    args.push(outPath);

    // 运行 ffmpeg
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.stdout.on('data', () => {}); // 忽略

    p.on('error', (e) => {
      console.error('spawn error:', e);
    });

    p.on('close', (code) => {
      // 清理临时文件
      fs.unlink(img, () => {});
      fs.unlink(aud, () => {});

      if (code !== 0) {
        console.error('ffmpeg exit', code, '\n', stderr);
        return res.status(500).json({ error: 'ffmpeg exit ' + code, detail: stderr.split('\n').slice(-8) });
      }

      const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const file_url = `${base}/output/${filename}`;
      console.log(`[done] ${filename} in ${Date.now() - startedAt}ms`);
      res.json({ file_url });
    });

  } catch (err) {
    console.error('make/segments error:', err);
    res.status(500).json({ error: 'internal', detail: String(err && err.message || err) });
  }
});

// —— 健康检查 —— //
app.get('/healthz', (req, res) => res.json({ ok: true }));

// —— 兜底错误与未捕获 —— //
app.use((err, req, res, next) => {
  console.error('express error:', err);
  res.status(500).json({ error: 'internal', detail: String(err) });
});
process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ready] listening on ${PORT}`);
});
