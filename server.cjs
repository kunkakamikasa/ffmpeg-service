const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(morgan('tiny'));
app.use(bodyParser.json({ limit: '1mb' }));

// 输出目录
const OUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// 静态托管输出文件
app.use('/output', express.static(OUT_DIR, { fallthrough: false }));

// 健康检查
app.get('/healthz', (_, res) => res.json({ ok: true }));

// 小工具：下载到本地临时文件（给字幕用；图片/音频我们可直接用 URL）
async function downloadToTemp(url, suffix = '') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = await res.buffer();
  const tmpPath = path.join('/tmp', `${uuidv4()}${suffix}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

// 构造动效 filter（基于竖屏/横屏都可）
function buildMotionFilter(motion, w, h) {
  // 统一思路：先略微放大（给裁剪留空间），然后 crop+偏移 或 zoom
  // 注意 crop 里的 x/y 需要一起写在 crop=...:x=...:y=... 的同一个滤镜里
  const scaleUp = `scale=ceil(${w}*1.08):ceil(${h}*1.08)`;
  const baseFmt = `format=yuv420p,fps=30`;

  if (!motion || motion === 'none') {
    return `${scaleUp},crop=${w}:${h}:(in_w-out_w)/2:(in_h-out_h)/2,${baseFmt}`;
  }

  if (motion === 'shake') {
    // 轻微抖动：正弦左右/上下 + 小幅旋转
    return [
      scaleUp,
      `crop=${w}:${h}:x='(in_w-out_w)/2 + 8*sin(2*t)':y='(in_h-out_h)/2 + 6*sin(1.4*t)'`,
      `rotate='0.004*sin(2*t)'`,
      baseFmt
    ].join(',');
  }

  if (motion === 'pan') {
    // 水平平移+回摆
    return [
      scaleUp,
      `crop=${w}:${h}:x='(in_w-out_w)/2 + 20*sin(0.3*t)':y='(in_h-out_h)/2'`,
      baseFmt
    ].join(',');
  }

  if (motion === 'zoom') {
    // 轻微缩放进出（用更简单的 scale+crop 组合模拟）
    return [
      `scale=ceil(${w}*(1.05+0.03*sin(0.5*t))):ceil(${h}*(1.05+0.03*sin(0.5*t)))`,
      `crop=${w}:${h}:(in_w-out_w)/2:(in_h-out_h)/2`,
      baseFmt
    ].join(',');
  }

  // 未知动效就退回默认
  return `${scaleUp},crop=${w}:${h}:(in_w-out_w)/2:(in_h-out_h)/2,${baseFmt}`;
}

// 主接口：图片+音频+（可选）SRT → 视频
app.post('/make/segments', async (req, res) => {
  try {
    const {
      image_url,
      audio_urls,          // 数组或单个 audio_url
      audio_url,
      srt_url,             // 可选：字幕 SRT 的直链（建议 UTF-8）
      outfile_prefix = 'out',
      resolution = '1080x1920',
      fps = 30,            // 目前我们在滤镜里固定用 fps=30，这里先接收以便后面扩展
      motion = 'none',     // none | shake | pan | zoom
      video = {}           // { preset, crf, threads }
    } = req.body || {};

    if (!image_url) return res.status(400).json({ ok: false, error: 'image_url is required' });
    const audios = Array.isArray(audio_urls) ? audio_urls : (audio_url ? [audio_url] : null);
    if (!audios || !audios.length) return res.status(400).json({ ok: false, error: 'audio_urls (or audio_url) is required' });

    const [W, H] = resolution.split('x').map(n => parseInt(n, 10));
    if (!W || !H) return res.status(400).json({ ok: false, error: 'resolution should look like 1080x1920' });

    // 输出文件名 & 路径
    const stamp = Date.now();
    const outName = `${outfile_prefix}_${stamp}.mp4`;
    const outPath = path.join(OUT_DIR, outName);

    // 构造 filter_complex：图像动效 + （可选）字幕
    let vf = buildMotionFilter(motion, W, H);

    // 如果有字幕，下载到本地，并在末尾追加 subtitles=
    // 注意：subtitles 滤镜必须放在最后（或至少在 format 之前移除），这里追加在末尾更直观
    let srtPath = null;
    if (srt_url) {
      srtPath = await downloadToTemp(srt_url, '.srt');
      // 避免空格、括号，做个安全转义
      const safeSrt = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/'/g, "\\'");
      vf = `${vf},subtitles='${safeSrt}'`;
    }

    // 准备 ffmpeg 输入
    // 0:v = image_url， 1:a = 第一段音频。若你需要多段拼接，可以后续再扩展。
    const args = [
      '-y',
      '-loop', '1',
      '-i', image_url,
      '-i', audios[0],
      '-shortest',
      '-filter_complex', `[0:v]${vf}[v]`,
      '-map', '[v]',
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', video.preset || 'veryfast',
      '-crf', (video.crf != null ? String(video.crf) : '20'),
      '-c:a', 'aac', '-b:a', '192k'
    ];

    if (video.threads) {
      args.push('-threads', String(video.threads));
    }
    args.push(outPath);

    // 调 ffmpeg
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let ffOut = '', ffErr = '';
    ff.stdout.on('data', d => { ffOut += d.toString(); });
    ff.stderr.on('data', d => { ffErr += d.toString(); });

    ff.on('close', code => {
      // 清理字幕临时文件
      if (srtPath) { try { fs.unlinkSync(srtPath); } catch (_) {} }

      if (code !== 0) {
        return res.status(500).json({ ok: false, code, stderr: ffErr.split('\n').slice(-30).join('\n') });
      }
      const fullUrl = `${(req.headers['x-forwarded-proto'] || req.protocol)}://${req.get('host')}/output/${outName}`;
      res.json({ ok: true, file_url: fullUrl });
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// 根路由：友好提示
app.get('/', (_, res) => res.type('text').send('FFmpeg service is up. Try POST /make/segments'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[ready] listening on ${PORT}`);
});
