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
  const tmp = path.join(
    os.tmpdir(),
    `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  );
  const resp = await axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    maxRedirects: 5,
  });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    resp.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  return tmp;
}

// —— 生成 ffmpeg 滤镜串 —— //
// 返回：{ filter, outW, outH, outFPS }
function buildFilter(resolution, fps, motion) {
  const [W, H] = (resolution || '').split('x').map(n => parseInt(n, 10) || 0);
  const outW = Math.max(16, W || 720);
  const outH = Math.max(16, H || 1280);
  const outFPS = fps || 24;

  let cropXY = `x='(in_w-out_w)/2':y='(in_h-out_h)/2'`;
  if (motion === 'shake') {
    cropXY = `x='(in_w-out_w)/2 + 6*sin(2*t)':y='(in_h-out_h)/2 + 6*sin(1.7*t)'`;
  } else if (motion === 'pan') {
    cropXY = `x='(in_w-out_w)/2 + 20*sin(0.3*t)':y='(in_h-out_h)/2'`;
  } else if (motion === 'zoom') {
    // 轻微呼吸式缩放（幅度小，避免黑边）
  }

  const zoomPrefix = (motion === 'zoom')
    ? `scale=${outW}*1.08:${outH}*1.08:flags=bicubic,`
    : '';

  const filter =
    `[0:v]` +
    `${zoomPrefix}` +
    `scale=${outW}:${outH}:force_original_aspect_ratio=increase,` +
    `crop=${outW}:${outH}:${cropXY},` +
    `fps=${outFPS},format=yuv420p[v0]`;

  return { filter, outW, outH, outFPS };
}

// —— 合成接口（支持 subtitle_url + 可选样式 + FX） —— //
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
      video = {},             // 编码参数
      subtitle_url = null,    // 字幕直链（.srt 或 .ass）
      subtitles = {},         // 可选：{ charenc, force_style, fontsdir }
      fx = {}                 // ★ 新增：伪特效参数
    } = req.body || {};

    if (!image_url || !audio_urls.length) {
      return res.status(400).json({ error: 'image_url 和 audio_urls 必填' });
    }

    const audio_url = audio_urls[0];

    // 下载素材
    const img = await downloadToTmp(image_url, 'png');
    const aud = await downloadToTmp(audio_url, 'mp3');

    // 视频基础滤镜（中间标签 [v0]）
    const { filter } = buildFilter(resolution, fps, motion);

    // ★★★ 基于 fx 组装一段可选的滤镜链（从 [v0] 出发，输出 [vfx]）★★★
    let baseLabel = '[v0]';
    let fxParts = [];

    // 颜色/对比预设
    const preset = (fx.preset || '').toLowerCase();
    if (preset === 'horror_cold') {
      fxParts.push(`eq=saturation=0.65:contrast=1.12:brightness=-0.02:gamma=0.95`);
      fxParts.push(`colorchannelmixer=rr=0.95:gg=1.00:bb=1.08:rb=0:gb=0:br=0`);
    } else if (preset === 'horror_bloody') {
      fxParts.push(`eq=saturation=0.80:contrast=1.20:brightness=-0.015:gamma=0.98`);
      fxParts.push(`colorchannelmixer=rr=1.06:gg=0.98:bb=0.95:rg=0.02:bg=0.00:rb=0.02`);
    } else if (preset === 'nightmare') {
      fxParts.push(`eq=saturation=0.60:contrast=1.10:brightness=-0.03:gamma=0.90`);
      fxParts.push(`colorchannelmixer=rr=0.95:gg=1.02:bb=0.98:rb=0.00:bg=0.02`);
    } else if (preset === 'mono') {
      fxParts.push(`hue=s=0`);
    }

    // 晕影（使用默认形状）
    if (typeof fx.vignette === 'number' && fx.vignette > 0) {
      fxParts.push(`vignette=PI/5`);
    }

    // 颗粒（noise 的稳定写法）
    if (typeof fx.grain === 'number' && fx.grain > 0) {
      const g = Math.min(30, Math.max(1, fx.grain|0));
      fxParts.push(`noise=alls=${g}:allf=u`);
    }

    // 色差
    if (typeof fx.aberration_px === 'number' && fx.aberration_px > 0) {
      const px = Math.min(6, Math.max(1, fx.aberration_px|0));
      fxParts.push(`chromashift=cbh=${px}:crh=-${px}`);
    }

    // 轻微模糊
    if (typeof fx.blur === 'number' && fx.blur > 0) {
      const b = Math.min(3, Math.max(0.3, fx.blur));
      fxParts.push(`gblur=sigma=${b.toFixed(2)}`);
    }

    // 闪烁（正弦调亮度）
    if (typeof fx.flicker_amp === 'number' && fx.flicker_amp > 0) {
      const amp = Math.min(0.15, Math.max(0.01, fx.flicker_amp));
      const freq = (typeof fx.flicker_freq === 'number' && fx.flicker_freq > 0) ? fx.flicker_freq : 1.3;
      fxParts.push(`eq=brightness='${amp}*sin(2*PI*${freq}*t)'`);
    }

    let finalFilter = filter;
    if (fxParts.length) {
      finalFilter = `${filter};[v0]${fxParts.join(',')}[vfx]`;
      baseLabel = '[vfx]';
    }

    // （可选）下载字幕：保留原后缀（srt/ass），避免识别错误
    let subPath = null;
    let subIsASS = false;
    if (subtitle_url) {
      try {
        let guessed = 'srt';
        try {
          const p = new URL(subtitle_url).pathname;
          const ext = (path.extname(p) || '').slice(1).toLowerCase();
          if (ext === 'ass') guessed = 'ass';
        } catch {}
        subIsASS = (guessed === 'ass');
        subPath = await downloadToTmp(subtitle_url, guessed);
      } catch (e) {
        console.warn('subtitle download failed:', e?.message || e);
      }
    }

    // （可选）串接字幕（接在 FX 之后）
    let finalVideoLabel = baseLabel;
    if (subPath) {
      const charenc = (subtitles.charenc || 'UTF-8').trim();
      const forceStyle =
        (subIsASS && !subtitles.force_style)
          ? null
          : (subtitles.force_style || 'FontName=Arial,Fontsize=22,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=80');
      const fontsdir = subtitles.fontsdir ? String(subtitles.fontsdir) : null;

      const subOpts = [`'${subPath}'`];
      if (charenc) subOpts.push(`charenc='${charenc}'`);
      if (fontsdir) subOpts.push(`fontsdir='${fontsdir}'`);
      if (forceStyle) subOpts.push(`force_style='${forceStyle}'`);

      const subFilter = `subtitles=${subOpts.join(':')}`;
      finalFilter = `${finalFilter};${baseLabel}${subFilter},format=yuv420p[v]`;
      finalVideoLabel = '[v]';
    }

    // 输出文件
    const filename = `${outfile_prefix}_${Date.now()}.mp4`;
    const outPath  = path.join(OUTPUT_DIR, filename);

    // 编码参数（保守默认，避免 OOM）
    const preset  = video.preset  || 'veryfast';
    const crf     = (video.crf ?? 23);
    const threads = video.threads || 1;
    const bitrate = video.bitrate; // 可选

    // ffmpeg 参数
    const args = [
      '-y',
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',
      '-loop', '1', '-i', img,  // 0:v
      '-i', aud,                // 1:a
      '-filter_complex', finalFilter,
      '-map', finalVideoLabel,
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-threads', String(threads),
    ];
    if (bitrate) args.push('-b:v', String(bitrate));
    args.push('-c:a', 'aac', '-b:a', '128k');
    args.push('-shortest', outPath);

    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.stdout.on('data', () => {});

    p.on('error', (e) => {
      console.error('spawn error:', e);
    });

    p.on('close', (code) => {
      // 清理临时文件
      fs.unlink(img, () => {});
      fs.unlink(aud, () => {});
      if (subPath) fs.unlink(subPath, () => {});

      if (code !== 0) {
        console.error('ffmpeg exit', code, '\n', stderr);
        return res
          .status(500)
          .json({ error: 'ffmpeg exit ' + code, detail: stderr.split('\n').slice(-12) });
      }

      const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const file_url = `${base}/output/${filename}`;
      console.log(`[done] ${filename} in ${Date.now() - startedAt}ms`);
      res.json({ file_url });
    });

  } catch (err) {
    console.error('make/segments error:', err);
    res.status(500).json({ error: 'internal', detail: String(err?.message || err) });
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
