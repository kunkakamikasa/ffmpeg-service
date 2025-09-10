/* Minimal, stable baseline: image + audio -> mp4 (shake/pan/zoom optional; SRT optional) */
const express = require('express');
const morgan = require('morgan');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));

const TMP = '/tmp';
const PORT = process.env.PORT || 10000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function uid() {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function downloadToTmp(url, forcedExt = '') {
  if (!url) throw new Error('empty url');
  const u = new URL(url);
  const ext = forcedExt || path.extname(u.pathname) || '';
  const outfile = path.join(TMP, `${uid()}${ext}`);
  const res = await fetch(url);

  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }

  const nodeReadable = Readable.fromWeb(res.body);
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outfile);
    nodeReadable.pipe(w);
    nodeReadable.on('error', reject);
    w.on('finish', resolve);
    w.on('error', reject);
  });

  return outfile;
}

function buildFilter({ W, H, fps, motion, srtPath }) {
  let chain;
  if (motion === 'shake') {
    chain = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=cover,` +
            `crop=${W}:${H}:x=(in_w-out_w)/2+12*sin(2*t):y=(in_h-out_h)/2+12*sin(1.5*t),` +
            `fps=${fps}`;
  } else if (motion === 'pan') {
    chain = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=cover,` +
            `crop=${W}:${H}:x=(in_w-out_w)/2+150*sin(0.3*t):y=(in_h-out_h)/2,` +
            `fps=${fps}`;
  } else if (motion === 'zoom') {
    // 轻微放大至 1.12 倍；zoompan 自带输出尺寸 s=WxH
    chain = `[0:v]zoompan=z='min(zoom+0.002,1.12)':d=1:` +
            `x='iw/2-(iw/2)/zoom':y='ih/2-(ih/2)/zoom':s=${W}x${H},fps=${fps}`;
  } else {
    // 默认不动，只做 cover & 裁切
    chain = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=cover,crop=${W}:${H},fps=${fps}`;
  }

  if (srtPath) {
    // 路径转义（冒号/反斜杠/单引号）
    const esc = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    chain += `,subtitles='${esc}':force_style='Fontsize=28,Outline=1,Shadow=0'`;
  }

  chain += ',format=yuv420p[v]';
  return chain;
}

app.get('/', (_, res) => res.type('text/plain').send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

// 列目录调试（看到 files 就说明静态托管在工作）
app.get('/__debug__/ls', (_, res) => {
  const files = fs.readdirSync(TMP).sort().slice(-50);
  res.json({ files });
});

// 静态托管 /tmp 到 /output
app.use('/output', express.static(TMP, { fallthrough: false }));

app.post('/make/segments', async (req, res) => {
  const t0 = Date.now();
  try {
    const {
      image_url,
      audio_urls,
      outfile_prefix = 'out',
      resolution = '1080x1920',
      fps = 30,
      motion = 'none',
      video = {},
      srt_url // 可选
    } = req.body || {};

    if (!image_url || !audio_urls || !audio_urls.length) {
      return res.status(400).json({ error: 'image_url & audio_urls are required' });
    }

    const [W, H] = String(resolution).split('x').map(n => parseInt(n, 10));
    if (!W || !H) return res.status(400).json({ error: 'bad resolution' });

    // 先把远端资源拉到 /tmp，避免 ffmpeg 直连外网导致不稳定
    const [imgLocal, audLocal] = await Promise.all([
      downloadToTmp(image_url),
      downloadToTmp(audio_urls[0])
    ]);
    const srtLocal = srt_url ? await downloadToTmp(srt_url, '.srt') : null;

    const outFile = path.join(TMP, `${outfile_prefix}_${Date.now()}.mp4`);
    const filter = buildFilter({ W, H, fps, motion, srtPath: srtLocal });

    const args = [
      '-y',
      '-loop', '1', '-i', imgLocal,
      '-i', audLocal,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', video.preset || 'veryfast',
      '-crf', String(video.crf ?? 20),
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      '-threads', String(video.threads ?? 1),
      outFile
    ];

    console.log('[ffmpeg args]', args.join(' '));

    const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    ff.stdout.on('data', d => console.log('[ffmpeg]', d.toString().trim()));
    ff.stderr.on('data', d => console.log('[ffmpeg]', d.toString().trim()));

    const code = await new Promise((resolve) => ff.on('close', resolve));

    if (code !== 0) {
      return res.status(500).json({ error: `ffmpeg exit ${code}` });
    }

    const file_url = `${req.protocol}://${req.get('host')}/output/${path.basename(outFile)}`;
    res.json({ file_url, took_ms: Date.now() - t0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[ready] listening on ${PORT}`);
});
