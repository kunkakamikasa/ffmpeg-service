// server.cjs
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// 输出目录
const OUTDIR = '/tmp';
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

// 工具函数：下载远程文件到本地临时目录
async function downloadFile(url, suffix) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${url}`);
  const filePath = path.join(OUTDIR, `${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`);
  const buf = await res.buffer();
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// 构造滤镜链
function buildFilter({ W, H, fps, motion, srtPath }) {
  let chain;
  if (motion === 'shake') {
    chain =
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H}:x=(in_w-out_w)/2+12*sin(2*t):y=(in_h-out_h)/2+12*sin(1.5*t),` +
      `fps=${fps}`;
  } else if (motion === 'pan') {
    chain =
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H}:x=(in_w-out_w)/2+150*sin(0.3*t):y=(in_h-out_h)/2,` +
      `fps=${fps}`;
  } else if (motion === 'zoom') {
    chain =
      `[0:v]zoompan=z='min(zoom+0.002,1.12)':d=1:` +
      `x='iw/2-(iw/2)/zoom':y='ih/2-(ih/2)/zoom':s=${W}x${H},fps=${fps}`;
  } else {
    // 静止图 + 裁切
    chain =
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},fps=${fps}`;
  }

  // 如果有字幕
  if (srtPath) {
    const esc = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    chain += `,subtitles='${esc}':force_style='Fontsize=28,Outline=1,Shadow=0'`;
  }

  chain += ',format=yuv420p[v]';
  return chain;
}

// 路由：生成视频
app.post('/make/segments', async (req, res) => {
  try {
    const {
      image_url,
      audio_urls,
      outfile_prefix = 'out',
      resolution = '720x1280',
      fps = 30,
      motion = 'none',
      srt_url,
      video = {}
    } = req.body;

    if (!image_url || !audio_urls || !audio_urls.length) {
      return res.status(400).json({ error: 'image_url and audio_urls required' });
    }

    const [W, H] = resolution.split('x').map(Number);

    // 下载输入文件
    const imgPath = await downloadFile(image_url, path.extname(image_url) || '.png');
    const audioPaths = [];
    for (const url of audio_urls) {
      audioPaths.push(await downloadFile(url, '.mp3'));
    }
    let srtPath = null;
    if (srt_url) srtPath = await downloadFile(srt_url, '.srt');

    const outfile = path.join(OUTDIR, `${outfile_prefix}_${Date.now()}.mp4`);

    // 构建 filter
    const filter = buildFilter({ W, H, fps, motion, srtPath });

    // ffmpeg 参数
    const args = [
      '-y',
      '-loop', '1',
      '-i', imgPath,
      '-i', audioPaths[0], // 先只支持单音轨
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', video.preset || 'veryfast',
      '-crf', video.crf || '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      outfile
    ];

    console.log('Running ffmpeg', args.join(' '));

    const ff = spawn('ffmpeg', args);
    ff.stderr.on('data', d => console.log('[ffmpeg]', d.toString()));
    ff.on('close', code => {
      if (code !== 0) {
        return res.status(500).json({ error: `ffmpeg exit ${code}` });
      }
      const fileUrl = `${req.protocol}://${req.get('host')}/output/${path.basename(outfile)}`;
      res.json({ file_url: fileUrl });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 静态文件托管
app.use('/output', express.static(OUTDIR));

// 健康检查
app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('FFmpeg service running on', PORT));
