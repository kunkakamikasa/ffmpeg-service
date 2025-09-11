// server.cjs
// FFmpeg micro-service (Render friendly, low-memory safe)
// Features:
// - image + multi-audio concat -> video
// - motions: none | shake | pan | zoom
// - filters: rgbashift | tmix | glitchOverlay(noise) | vignette
// - subtitles: SRT URL or captions array (auto SRT)
// - returns full URL to /output/<file>.mp4
//
// Render settings (example):
// - Start command: node server.cjs
// - ENV: PUBLIC_BASE_URL=https://<your-service>.onrender.com
//
// NOTE: writes only to /tmp (ephemeral on Render)

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);
const axios = require("axios"); // ← use axios for robust streaming downloads

const app = express();
app.use(express.json({ limit: "4mb" }));

const OUT_DIR = "/tmp/output";
const TMP_DIR = "/tmp";
fs.mkdirSync(OUT_DIR, { recursive: true });

// Prefer user-provided public URL; fall back to Render's external URL if available
function baseUrl() {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ""
  );
}
function uid(n = 6) {
  return crypto.randomBytes(n).toString("hex");
}

// --- robust downloader using axios stream (works on any Node) ---
async function downloadTo(url, destPath) {
  const resp = await axios.get(url, {
    responseType: "stream",
    timeout: 30000,
    maxRedirects: 5,
    headers: { "User-Agent": "ffmpeg-service/1.0" },
  });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    resp.data.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
  return destPath;
}

function parseResolution(s = "720x1280") {
  const m = String(s).match(/^(\d+)x(\d+)$/i);
  if (!m) return { W: 720, H: 1280 };
  return { W: parseInt(m[1], 10), H: parseInt(m[2], 10) };
}

function buildMotion({ motion = "none" }, W, H) {
  // 先轻微放大，再裁切 + 伪动销（避免黑边 & 兼容不同 ffmpeg build）
  const pre = `scale=${W * 1.06}:${H * 1.06},setsar=1`;
  if (motion === "shake") {
    const crop = `crop=${W}:${H}:x='(in_w-${W})/2+5*sin(2*t)':y='(in_h-${H})/2+5*sin(1.5*t)'`;
    return `${pre},${crop}`;
  }
  if (motion === "pan") {
    const crop = `crop=${W}:${H}:x='(in_w-${W})/2+20*sin(t*0.3)':y='(in_h-${H})/2'`;
    return `${pre},${crop}`;
  }
  if (motion === "zoom") {
    const zoom = `zoompan=z='1+0.05*sin(t*0.5)':d=1:x='iw/2-(iw/${W})*0.5':y='ih/2-(ih/${H})*0.5'`;
    return `${pre},${zoom},scale=${W}:${H}`;
  }
  return `${pre},crop=${W}:${H}`;
}

function buildFilterChain(options, W, H, fps, inputs) {
  // inputs: { audioCount: N }
  // 视频链从 [0:v] 开始
  let chain = `[0:v]${buildMotion(options, W, H)}`;

  // 滤镜（可选）
  const f = options.filters || {};
  if (f.rgbashift) {
    const amt = typeof f.rgbashift === "number" ? f.rgbashift : 2;
    chain += `,rgbashift=rg=${amt}:bg=${amt}:rb=${amt}:bb=${amt}`;
  }
  if (f.tmix) {
    const frames = typeof f.tmix === "number" ? f.tmix : 2;
    chain += `,tmix=frames=${Math.max(2, Math.min(5, frames))}`;
  }
  if (f.glitchOverlay) {
    chain += `,noise=alls=10:allf=t+u`;
  }
  if (f.vignette) {
    const strength = Math.min(1, Math.max(0, Number(f.vignette)));
    if (strength > 0) chain += `,vignette=PI/5:${strength}`;
  }

  // 帧率 & 像素格式
  chain += `,fps=${fps},format=yuv420p[v]`;

  // 音频链：多段顺连拼接；单段做规范化；无音频则 anullsrc
  const aCount = inputs.audioCount || 0;
  let afilters = "";
  if (aCount === 0) {
    afilters = `anullsrc=r=44100:cl=mono[aud]`;
  } else if (aCount === 1) {
    afilters = `[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,aresample=44100,pan=stereo|c0=c0|c1=c0[aud]`;
  } else {
    const normSeq = Array.from({ length: aCount }, (_, i) => i + 1)
      .map(
        (idx) =>
          `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,aresample=44100[a${idx}]`
      )
      .join(";");
    const refs = Array.from({ length: aCount }, (_, i) => `[a${i + 1}]`).join("");
    afilters = `${normSeq};${refs}concat=n=${aCount}:v=0:a=1[aud]`;
  }

  // 字幕（若提供 SRT）
  if (options._srtPath) {
    const esc = options._srtPath.replace(/'/g, "\\\\'").replace(/:/g, "\\\\:");
    chain = chain.replace(
      "[v]",
      `,subtitles='${esc}':force_style='Fontsize=${options.sub_fontsize || 28},Outline=${options.sub_outline || 1},PrimaryColour=&H00FFFFFF&'[v]`
    );
  }

  const filterComplex = `${chain};${afilters}`;
  return { filterComplex, vOut: "[v]", aOut: "[aud]" };
}

async function ensureSrtFromCaptions(captions) {
  // captions: [{text, start, end}]  start/end 可以是秒数或 "00:00:02,000"
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

      // 字幕输入（二选一）
      subtitle_url, // 外部 SRT 直链
      captions, // [{text,start,end}] 自动转 SRT
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
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",

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
      "-pix_fmt",
      "yuv420p",
      "-threads",
      String(video.threads || 1),

      "-c:a",
      "aac",
      "-b:a",
      "128k",

      // 与最短输入对齐，避免拖尾
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

    const url = baseUrl()
      ? `${baseUrl()}/output/${outName}`
      : `/output/${outName}`;

    res.json({
      ok: true,
      file_url: url,
      took_ms: Date.now() - startedAt,
    });
  } catch (err) {
    // 精简返回 + 附带最后若干行 stderr/stack，方便排错
    let detail = "";
    try {
      detail = String(err.stack || err.message || err)
        .split("\n")
        .slice(-20)
        .join("\n");
    } catch {}
    return res.status(500).json({
      error: "ffmpeg failed",
      detail: detail.slice(-1500),
    });
  }
});

// Bind to Render's PORT or 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[ready] listening on ${PORT}`);
});
