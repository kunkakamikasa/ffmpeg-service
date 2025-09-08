// server.cjs  —— CommonJS 版本（require 可用）
// 作用：提供 /make/segments 生成视频；/output 静态托管；/healthz 与调试列表

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));

// 让 /output 指向 /tmp，用于直接访问 ffmpeg 输出文件
const OUTPUT_DIR = '/tmp';
app.use('/output', express.static(OUTPUT_DIR, { fallthrough: false }));

// 健康检查
app.get('/healthz', (req, res) => res.json({ ok: true }));

// 根路由
app.get('/', (req, res) => {
  res.json({ ok: true, msg: 'ffmpeg-service is running', routes: ['/make/segments (POST)', '/output/<file>', '/__debug__/ls'] });
});

// 列出 /tmp 下的媒体文件，便于调试
app.get('/__debug__/ls', (req, res) => {
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => /\.(mp4|mov|m4a|mp3|aac|srt|vtt)$/i.test(f));
  res.json({ dir: OUTPUT_DIR, files });
});

// 小工具：构造运动风格对应的滤镜片段
function motionToFilter(motion, resW, resH, fps) {
  // 给几个常用档位；不传则返回基础缩放裁剪
  const base =
    `scale=${resW}:${resH}:force_original_aspect_ratio=increase,` +
    `crop=${resW}:${resH},fps=${fps}`;

  if (!motion || motion === 'none') return base;

  if (motion === 'verticalSubtle') {
    return (
      base +
      `,scale=ceil(${resW}*1.18):ceil(${resH}*1.18),` + // 放大给抖动留空间
      `crop=${resW}:${resH}:` +
      `x='(in_w-out_w)/2 + 22*sin(t*0.22) + 4*sin(t*3.5)':` +
      `y='(in_h-out_h)/2 + 16*sin(t*0.19) + 3*sin(t*2.8)',` +
      `rotate='0.004*sin(2*t)+0.002*cos(7*t)',` +
      `eq=contrast=1.06:brightness=-0.04:saturation=0.92,` +
      `noise=alls=9:allf=t,rgbashift=rh=2:rv=2:gh=-2:gv=-2`
    );
  }

  if (motion === 'psychoFlicker') {
    return (
      base +
      `,scale=ceil(${resW}*1.22):ceil(${resH}*1.22),` +
      `crop=${resW}:${resH}:` +
      `x='(in_w-out_w)/2 + 20*sin(t*0.25) + 5*sin(t*4.2)':` +
      `y='(in_h-out_h)/2 + 16*sin(t*0.20) + 4*sin(t*3.5)',` +
      `rotate='0.005*sin(1.7*t)+0.002*cos(9*t)',` +
      `eq=contrast=1.12:brightness='-0.06+0.04*sin(13*t)':saturation=0.8,` +
      `tmix=frames=4:weights=1 1.5 1.5 1,` +
      `rgbashift=rh=4:rv=3:gh=-4:gv=-3`
    );
  }

  // 未知值兜底
  return base;
}

// 生成视频
app.post('/make/segments', async (req, res) => {
  try {
    const {
      image_url,
      audio_urls = [],
      outfile_prefix = 'out',
      resolution = '1080x1920',
      fps = 30,
      motion = 'verticalSubtle',
      // 可扩展的音频效果开关（可选）
      audio_fx = { highpass: true, lowpass: true, echo: true, limiter: 0.9 },
      // 可选字幕（srt/vtt 的直链）
      subtitle_url
    } = req.body || {};

    if (!image_url || !audio_urls.length) {
      return res.status(400).json({ error: 'image_url 和 audio_urls 必填' });
    }

    const [resW, resH] = resolution.split('x').map(Number);
    if (!resW || !resH) {
      return res.status(400).json({ error: 'resolution 格式应为 1080x1920 这种' });
    }

    // 输出文件名
    const ts = Date.now();
    const outName = `${outfile_prefix}_${ts}.mp4`;
    const outPath = path.join(OUTPUT_DIR, outName);

    // 组装 ffmpeg 参数
    const args = [];

    // 输入：图片（循环一帧做底）
    args.push('-y', '-loop', '1', '-i', image_url);

    // 输入：音频，取第一条（如需拼接多条可按你以前的做法扩展）
    args.push('-i', audio_urls[0]);

    // 视频滤镜
    const vf = motionToFilter(motion, resW, resH, fps);
    args.push('-filter_complex', `[0:v]${vf},format=yuv420p[v]`);
    args.push('-map', '[v]');
    args.push('-map', '1:a');

    // 视频编码
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18');

    // 音频滤镜
    const af = [];
    if (audio_fx?.highpass) af.push('highpass=f=120');
    if (audio_fx?.lowpass) af.push('lowpass=f=6000');
    if (audio_fx?.echo) af.push('aecho=0.7:0.88:45:0.25');
    const lim = Number(audio_fx?.limiter || 0);
    if (lim && lim >= 0.0625 && lim <= 1) af.push(`alimiter=limit=${lim}`);
    if (af.length) {
      args.push('-af', af.join(','));
    }

    // 音频编码
    args.push('-c:a', 'aac', '-b:a', '192k');

    // 字幕（外挂到 mp4 容器里；注：很多平台更喜欢烧录字幕或生成双版本）
    if (subtitle_url) {
      // 注意：这会当作“软字幕”轨；如果你想“烧录”请改为在 filter_complex 中使用 subtitles=。
      args.push('-i', subtitle_url);
      args.push('-c:s', 'mov_text');      // mp4 的字幕编码
      args.push('-map', '2:0');           // 将第三个输入作为字幕
    }

    args.push('-shortest', outPath);

    // 启动 ffmpeg
    console.log('Running ffmpeg:', 'ffmpeg', args.join(' '));
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // 把日志打到 Render logs 方便你观察
    ff.stdout.on('data', (d) => process.stdout.write(d));
    ff.stderr.on('data', (d) => process.stderr.write(d));

    ff.on('close', (code) => {
      if (code === 0) {
        // 返回可直接访问的完整 URL
        const file_url = `${process.env.RENDER_EXTERNAL_URL || ''}/output/${outName}`;
        return res.json({ file_url, name: outName });
      }
      return res.status(500).json({ error: 'ffmpeg failed', code });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  }
});

// Render 注入端口（本地运行用 10000）
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[ready] listening on ${PORT}`);
});
