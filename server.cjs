// server.cjs
// FFmpeg micro-service (Render friendly, low-memory safe)
// Features:
// - image + multi-audio concat -> video
// - motions: none | shake | pan | zoom
// - filters: rgbashift | tmix | glitchOverlay(noise) | vignette
// - subtitles: SRT URL or captions array (auto SRT)
// - returns full URL to /output/<file>.mp4
//
// Requirements on Render:
// - Web Service (Node)
// - Start command: node server.cjs
// - Environment: PUBLIC_BASE_URL=https://<your-service>.onrender.com
//
// Note: writes to /tmp only (ephemeral on Render)

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);

// Node 18+ has global fetch; if not, uncomment node-fetch
// const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json({ limit: "4mb" }));

const OUT_DIR = "/tmp/output";
const TMP_DIR = "/tmp";
fs.mkdirSync(OUT_DIR, { recursive: true });

function baseUrl() {
  // Prefer env, fallback to Render provided host header at runtime
  return process.env.PUBLIC_BASE_URL || "";
}
function uid(n = 6) {
  return crypto.randomBytes(n).toString("hex");
}
async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  await streamPipeline(res.body, fs.createWriteStream(destPath));
  return destPath;
}

function parseResolution(s = "720x1280") {
  const m = String(s).match(/^(\d+)x(\d+)$/i);
  if (!m) return { W: 720, H: 1280 };
  return { W: parseInt(m[1], 10), H: parseInt(m[2], 10) };
}

function buildMotion({ motion = "none" }, W, H) {
  // Base: make the image slightly larger then crop to W×H with motion
  // Safer path (no force_original_aspect_ratio flags that differ by ffmpeg build):
  // 1) scale to fit (cover) by overscaling 1.06 and center-cropping with expressions
  // 2) add motion via crop x/y or zoompan
  const pre = `scale=${W * 1.06}:${H * 1.06},setsar=1`;
  if (motion === "shake") {
    const crop = `crop=${W}:${H}:x='(in_w-${W})/2+5*sin(2*t)':y='(in_h-${H})/2+5*sin(1.5*t)'`;
    return `${pre},${crop}`;
  }
  if (motion === "pan") {
    // 左->右缓慢平移
    const crop = `crop=${W}:${H}:x='(in_w-${W})/2+20*sin(t*0.3)':y='(in_h-${H})/2'`;
    return `${pre},${crop}`;
  }
  if (motion === "zoom") {
    // 温柔缩放 1.0~1.05 来回
    const zoom = `zoompan=z='1+0.05*sin(t*0.5)':d=1:x='iw/2-(iw/${W})*0.5':y='ih/2-(ih/${H})*0.5'`;
    // zoompan 输出尺寸不固定，这里再强行裁到目标
    return `${pre},${zoom},scale=${W}:${H}`;
  }
  return `${pre},crop=${W}:${H}`;
}

function buildFilterChain(options, W, H, fps, inputs) {
  // inputs: { imgIndex: 0, audioCount: N }
  // 视频链从 [0:v] 开始
  const vLabels = [];
  let chain = `[0:v]${buildMotion(options, W, H)}`;

  // 滤镜
  const f = options.filters || {};
  // 提示：rgbashift 参数以像素为单位，这里给一个温和默认值
  if (f.rgbashift) {
    const amt = typeof f.rgbashift === "number" ? f.rgbashift : 2;
    chain += `,rgbashift=rg=${amt}:bg=${amt}:rb=${amt}:bb=${amt}`;
  }
  if (f.tmix) {
    const frames = typeof f.tmix === "number" ? f.tmix : 2; // 2~3 比较稳
    chain += `,tmix=frames=${Math.max(2, Math.min(5, frames))}`;
  }
  if (f.glitchOverlay) {
    // 用噪点模拟轻度“故障”叠加
    chain += `,noise=alls=10:allf=t+u`;
  }
  if (f.vignette) {
    const strength = Math.min(1, Math.max(0, Number(f.vignette)));
    if (strength > 0) chain += `,vignette=PI/5:${strength}`;
  }

  // 帧率 & 像素格式
  chain += `,fps=${fps},format=yuv420p[v]`;
  vLabels.push("[v]");

  // 音频链：如果多个音频输入，使用 concat 滤镜顺序拼接
  // 输入中，音频从 [1:a]...[N:a]
  const aCount = inputs.audioCount || 0;
  let audioMap = "1:a";
  let aLabel = "[aud]";
  let afilters = "";

  if (aCount === 0) {
    // 无音频就生成静音，防止某些播放器不兼容
    afilters = `anullsrc=r=44100:cl=mono[aud]`;
    aLabel = "[aud]";
  } else if (aCount === 1) {
    // 只有一个：标准化采样率/声道
    afilters = `[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,aresample=44100,pan=stereo|c0=c0|c1=c0[aud]`;
    aLabel = "[aud]";
  } else {
    // 多段音频：全部标准化再 concat
    // 构造 [1:a][2:a]...[N:a] -> concat=n=N:v=0:a=1[aud]
    const inputsSeq = Array.from({ length: aCount }, (_, i) => i + 1)
      .map((idx) => {
        return `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,aresample=44100[a${idx}]`;
      })
      .join(";");
    const refs = Array.from({ length: aCount }, (_, i) => `[a${i + 1}]`).join("");
    afilters = `${inputsSeq};${refs}concat=n=${aCount}:v=0:a=1[aud]`;
    aLabel = "[aud]";
  }

  // 字幕：若有 SRT 文件则在视频链尾部追加
  if (options._srtPath) {
    // 注意：路径要转义冒号、单引号
    const esc = options._srtPath.replace(/'/g, "\\\\'").replace(/:/g, "\\\\:");
    // 用 libass：可设置外观
    chain = chain.replace(
      "[v]",
      `,subtitles='${esc}':force_style='Fontsize=${options.sub_fontsize || 28},Outline=${options.sub_outline || 1},PrimaryColour=&H00FFFFFF&'[v]`
    );
  }

  // 汇总 filter_complex
  const fc = `${chain};${afilters}`;
  return { filterComplex: fc, vOut: vLabels[0], aOut: aLabel };
}

async function ensureSrtFromCaptions(captions) {
  // captions: [{text, start, end}]  start/end: 秒 或 "00:00:02,000" 皆可
  function toSrtTime(v) {
    if (typeof v === "number") {
      const ms = Math.max(0, Math.round(v * 1000));
      const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
      const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
      const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
      const mmm = String(ms % 1000).padStart(3, "0");
      return `${hh}:${mm}:${ss},${mmm}`;
    }
    return v;
  }
  const lines = [];
  (captions || []).forEach((c, i) => {
    lines.push(String(i + 1));
    lines.push(`${toSrtTime(c.start)} --> ${toSrtTime(c.end)}`);
    lines.push((c.text || "").replace(/\r?\n/g, "\n"));
    lines.push("");
  });
  const srt = lines.join("\n");
  const p = path.join(TMP_DIR, `caps_${uid()}.srt`);
  await fsp.writeFile(p, srt);
  return p;
}

// health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// debug: list saved files
app.get("/__debug__/ls", async (_req, res) => {
  try {
    const files = await fsp.readdir(OUT_DIR);
    res.json({ files: files.sort() });
  } catch (e) {
    res.json({ files: [], error: String(e) });
  }
});

// static output
app.use("/output", express.static(OUT_DIR, { fallthrough: false }));

// main
app.post("/make/segments", async (req, res) => {
  const startedAt = Date.now();
  try {
    const {
      image_url,
      audio_urls = [],
      outfile_prefix = "out",
      resolution = "720x1280",
      fps = 24,
      motion = "none",
      video = {},
      filters = {},

      // 字幕两种形态（二选一）
      subtitle_url, // 传 SRT 直链
      captions, // 传数组 [{text,start,end}]，自动转 SRT
      sub_fontsize,
      sub_outline,
    } = req.body || {};

    if (!image_url) {
      return res.status(400).json({ error: "image_url required" });
    }
    if (!Array.isArray(audio_urls) || audio_urls.length === 0) {
      return res.status(400).json({ error: "audio_urls required (>=1)" });
    }

    // 下载图片 & 多音频
    const imgPath = path.join(TMP_DIR, `img_${uid()}.png`);
    await downloadTo(image_url, imgPath);

    const audios = [];
    for (const u of audio_urls) {
      const p = path.join(TMP_DIR, `a_${uid()}.mp3`);
      await downloadTo(u, p);
      audios.push(p);
    }

    // 字幕（优先外部 SRT；否则 captions 生成）
    let srtPath = null;
    if (subtitle_url) {
      srtPath = path.join(TMP_DIR, `sub_${uid()}.srt`);
      await downloadTo(subtitle_url, srtPath);
    } else if (Array.isArray(captions) && captions.length) {
      srtPath = await ensureSrtFromCaptions(captions);
    }

    const { W, H } = parseResolution(resolution);
    const outName = `${outfile_prefix}_${Date.now()}.mp4`;
    const outPath = path.join(OUT_DIR, outName);

    // 组装 ffmpeg 参数
    const args = [
      "-y",
      "-loop",
      "1",
      "-i",
      imgPath,
      // 追加每个音频为独立输入
      ...audios.flatMap((p) => ["-i", p]),
      "-filter_complex",
      "", // 占位，稍后填入
      "-map",
      "", // v
      "-map",
      "", // a
      "-c:v",
      "libx264",
      "-preset",
      String(video.preset || "veryfast"),
      "-crf",
      String(video.crf ?? 23),
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      outPath,
    ];

    // 构造 filters & map
    const fcOpts = {
      motion,
      filters,
      _srtPath: srtPath || undefined,
      sub_fontsize,
      sub_outline,
    };
    const { filterComplex, vOut, aOut } = buildFilterChain(
      fcOpts,
      W,
      H,
      fps,
      { audioCount: audios.length }
    );

    // 回填 filter_complex 与 map
    const fi = args.indexOf("-filter_complex") + 1;
    args[fi] = filterComplex;
    const mi1 = args.indexOf("-map") + 1;
    args[mi1] = vOut;
    const mi2 = args.lastIndexOf("-map") + 1;
    args[mi2] = aOut;

    // 运行 ffmpeg
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.stdout.on("data", () => {});

    await new Promise((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}`));
      });
    });

    const url =
      (baseUrl() ? `${baseUrl()}/output/${outName}` : `/output/${outName}`);

    res.json({
      ok: true,
      file_url: url,
      took_ms: Date.now() - startedAt,
    });
  } catch (err) {
    // 精简返回 + 附带最后 20 行 stderr，方便排错
    let tail = "";
    try {
      tail = String(err.stack || err.message || err)
        .split("\n")
        .slice(-20)
        .join("\n");
    } catch {}
    return res
      .status(500)
      .json({ error: "ffmpeg failed", detail: tail.slice(-1500) });
  }
});

// Bind to Render's PORT or 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[ready] listening on ${PORT}`);
});
