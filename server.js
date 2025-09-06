
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));

// On Render, prefer /tmp/output to ensure a writable path
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.get('/health', (req, res) => res.json({ ok: true }));

async function downloadToTemp(url, suffix = '') {
  const tmp = path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`);
  const writer = fs.createWriteStream(tmp);
  const resp = await axios.get(url, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  return tmp;
}

function sh(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || stdout || err.message));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * POST /make/story
 * body: {
 *   image_url: string,
 *   audio_urls: string[],
 *   resolution?: string (default "1280x720"),
 *   fps?: number (default 30),
 *   pad_between_ms?: number (default 0),
 *   outfile?: string
 * }
 */
app.post('/make/story', async (req, res) => {
  const { image_url, audio_urls, resolution = '1280x720', fps = 30, pad_between_ms = 0, outfile } = req.body || {};
  if (!image_url || !Array.isArray(audio_urls) || audio_urls.length === 0) {
    return res.status(400).json({ error: 'image_url 和 audio_urls 必填，且 audio_urls 至少包含 1 个音频 URL' });
  }
  const [w, h] = resolution.split('x').map(Number);
  if (!w || !h) return res.status(400).json({ error: 'resolution 格式应为 例如 1280x720' });

  const jobId = Date.now() + '_' + Math.random().toString(36).slice(2);
  const outName = (outfile?.replace(/[^a-zA-Z0-9_-]/g, '') || `story_${jobId}`) + '.mp4';
  const outPath = path.join(OUTPUT_DIR, outName);

  try {
    const imagePath = await downloadToTemp(image_url, path.extname(new URL(image_url).pathname) || '.jpg');

    const segmentPaths = [];
    for (let i = 0; i < audio_urls.length; i++) {
      const au = audio_urls[i];
      const audioPath = await downloadToTemp(au, path.extname(new URL(au).pathname) || '.mp3');
      const segPath = path.join(os.tmpdir(), `seg_${jobId}_${i}.mp4`);

      const cmd = [
        'ffmpeg -y',
        `-loop 1 -i "${imagePath}"`,
        `-i "${audioPath}"`,
        `-r ${fps}`,
        `-vf "scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p"`,
        '-c:v libx264 -tune stillimage -preset veryfast -crf 18',
        '-c:a aac -b:a 192k',
        '-shortest',
        `"${segPath}"`
      ].join(' ');
      await sh(cmd);
      segmentPaths.push(segPath);

      if (pad_between_ms > 0 && i < audio_urls.length - 1) {
        const padDur = (pad_between_ms / 1000).toFixed(3);
        const padSeg = path.join(os.tmpdir(), `pad_${jobId}_${i}.mp4`);
        const padCmd = [
          'ffmpeg -y',
          `-loop 1 -i "${imagePath}"`,
          `-f lavfi -t ${padDur} -i anullsrc=channel_layout=stereo:sample_rate=44100`,
          `-r ${fps}`,
          `-vf "scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p"`,
          '-c:v libx264 -preset veryfast -crf 18',
          '-c:a aac -b:a 192k',
          `"${padSeg}"`
        ].join(' ');
        await sh(padCmd);
        segmentPaths.push(padSeg);
      }
    }

    const inputs = segmentPaths.map(p => `-i "${p}"`).join(' ');
    const n = segmentPaths.length;
    const concatCmd = [
      'ffmpeg -y',
      inputs,
      `-filter_complex "${Array.from({ length: n }, (_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${n}:v=1:a=1[v][a]"`,
      '-map "[v]" -map "[a]"',
      '-c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 192k',
      `"${outPath}"`
    ].join(' ');
    await sh(concatCmd);

    const baseUrl = process.env.PUBLIC_BASE_URL || '';
    const videoUrl = baseUrl ? `${baseUrl}/output/${outName}` : `/output/${outName}`;
    return res.json({ ok: true, video_url: videoUrl, filename: outName });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * POST /make/segments
 * body: {
 *   image_url: string,
 *   audio_urls: string[],
 *   resolution?: string ("1280x720"),
 *   fps?: number (30),
 *   kenburns?: boolean (false),
 *   outfile_prefix?: string
 * }
 */
app.post('/make/segments', async (req, res) => {
  const { image_url, audio_urls, resolution = '1280x720', fps = 30, kenburns = false, outfile_prefix } = req.body || {};
  if (!image_url || !Array.isArray(audio_urls) || audio_urls.length === 0) {
    return res.status(400).json({ error: 'image_url 和 audio_urls 必填，且 audio_urls 至少 1 个' });
  }
  const [w, h] = resolution.split('x').map(Number);
  if (!w || !h) return res.status(400).json({ error: 'resolution 应为 例如 1280x720' });

  const jobId = Date.now() + '_' + Math.random().toString(36).slice(2);
  const prefix = (outfile_prefix?.replace(/[^a-zA-Z0-9_-]/g, '') || `seg_${jobId}`);

  try {
    const imagePath = await downloadToTemp(image_url, path.extname(new URL(image_url).pathname) || '.jpg');
    const urls = [];
    for (let i = 0; i < audio_urls.length; i++) {
      const au = audio_urls[i];
      const audioPath = await downloadToTemp(au, path.extname(new URL(au).pathname) || '.mp3');
      const outName = `${prefix}_${String(i + 1).padStart(2, '0')}.mp4`;
      const outPath = path.join(OUTPUT_DIR, outName);

      const vf = kenburns
        ? `-vf "scale=${w}:${h}:force_original_aspect_ratio=decrease,zoompan=z='min(zoom+0.0005,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=125*${fps},pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p"`
        : `-vf "scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p"`;

      const cmd = [
        'ffmpeg -y',
        `-loop 1 -i "${imagePath}"`,
        `-i "${audioPath}"`,
        `-r ${fps}`,
        vf,
        '-c:v libx264 -tune stillimage -preset veryfast -crf 18',
        '-c:a aac -b:a 192k',
        '-shortest',
        `"${outPath}"`
      ].join(' ');
      await sh(cmd);

      const baseUrl = process.env.PUBLIC_BASE_URL || '';
      const videoUrl = baseUrl ? `${baseUrl}/output/${outName}` : `/output/${outName}`;
      urls.push(videoUrl);
    }

    return res.json({ ok: true, video_urls: urls, count: urls.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.use('/output', express.static(OUTPUT_DIR, { maxAge: '7d' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`FFmpeg service listening on :${PORT}`));
