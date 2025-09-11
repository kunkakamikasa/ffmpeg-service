// server.cjs — single-audio only
const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "4mb" }));

const OUT_DIR = "/tmp/output";
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- utils ----
function uid(n = 6) { return crypto.randomBytes(n).toString("hex"); }
function baseUrl() {
  return process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
}
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
  const pre = `scale=${W * 1.06}:${H * 1.06},setsar=1`;
  if (motion === "shake") {
    return `${pre},crop=${W}:${H}:x='(in_w-${W})/2+5*sin(2*t)':y='(in_h-${H})/2+5*sin(1.5*t)'`;
  }
  if (motion === "pan") {
    return `${pre},crop=${W}:${H}:x='(in_w-${W})/2+20*sin(0.3*t)':y='(in_h-${H})/2'`;
  }
  if (motion === "zoom") {
    const zoom = `zoompan=z='1+0.05*sin(0.5*t)':d=1:x='iw/2-(iw/${W})*0.5':y='ih/2-(ih/${H})*0.5'`;
    return `${pre},${zoom},scale=${W}:${H}`;
  }
  return `${pre},crop=${W}:${H}`;
}
async function ensureSrtFromCaptions(captions) {
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
  const p = path.join(os.tmpdir(), `caps_${uid()}.srt`);
  await fsp.writeFile(p, srt);
  return p;
}

// ---- routes ----
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use("/output", express.static(OUT_DIR, { fallthrough: false }));

app.post("/make/segments", async (req, res) => {
  const startedAt = Date.now();
  try {
    const {
      image_url,
      audio_url,
      outfile_prefix = "out",
      resolution = "720x1280",
      fps = 24,
      motion = "none",
      video = {},    // { preset, crf, threads }
      filters = {},  // { rgbashift, tmix, glitchOverlay, vignette }
      subtitle_url,  // 可选：SRT 链接
      captions,      // 可选：[{text,start,end}]
      sub_fontsize,
      sub_outline,
    } = req.body || {};

    if (!image_url) return res.status(400).json({ error: "image_url required" });
    if (!audio_url) return res.status(400).json({ error: "audio_url required" });

    // 下载
    const imgPath = path.join(os.tmpdir(), `img_${uid()}.png`);
    const audPath = path.join(os.tmpdir(), `a_${uid()}.mp3`);
    await downloadTo(image_url, imgPath);
    await downloadTo(audio_url, audPath);

    // 字幕
    let srtPath = null;
    if (subtitle_url) {
      srtPath = path.join(os.tmpdir(), `sub_${uid()}.srt`);
      await downloadTo(subtitle_url, srtPath);
    } else if (Array.isArray(captions) && captions.length) {
      srtPath = await ensureSrtFromCaptions(captions);
    }

    const { W, H } = parseResolution(resolution);
    const outName = `${outfile_prefix}_${Date.now()}.mp4`;
    const outPath = path.join(OUT_DIR, outName);

    // 构造 filter
    let vchain = `[0:v]${buildMotion({ motion }, W, H)}`;
    if (filters.rgbashift) {
      const amt = typeof filters.rgbashift === "number" ? filters.rgbashift : 2;
      vchain += `,rgbashift=rg=${amt}:bg=${amt}:rb=${amt}:bb=${amt}`;
    }
    if (filters.tmix) {
      const frames = Math.max(2, Math.min(5, Number(filters.tmix) || 2));
      vchain += `,tmix=frames=${frames}`;
    }
    if (filters.glitchOverlay) {
      vchain += `,noise=alls=10:allf=t+u`;
    }
    if (filters.vignette) {
      const strength = Math.min(1, Math.max(0, Number(filters.vignette)));
      if (strength > 0) vchain += `,vignette=PI/5:${strength}`;
    }
    if (srtPath) {
      const esc = srtPath.replace(/'/g, "\\\\'").replace(/:/g, "\\\\:");
      const style = `Fontsize=${sub_fontsize || 28},Outline=${sub_outline || 1},PrimaryColour=&H00FFFFFF&`;
      vchain += `,subtitles='${esc}':force_style='${style}'`;
    }
    vchain += `,fps=${fps},format=yuv420p[v]`;

    const achain = `[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
                   `aresample=44100,pan=stereo|c0=c0|c1=c0[aud]`;

    const filterComplex = `${vchain};${achain}`;

    const args = [
      "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
      "-loop", "1", "-i", imgPath,
      "-i", audPath,
      "-filter_complex", filterComplex,
      "-map", "[v]", "-map", "[aud]",
      "-c:v", "libx264",
      "-preset", String(video.preset || "veryfast"),
      "-crf", String(video.crf ?? 23),
      "-pix_fmt", "yuv420p",
      "-threads", String(video.threads || 1),
      "-c:a", "aac", "-b:a", "128k",
      "-shortest", outPath,
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    await new Promise((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });

    const url = baseUrl() ? `${baseUrl()}/output/${outName}` : `/output/${outName}`;
    res.json({ ok: true, file_url: url, took_ms: Date.now() - startedAt });
  } catch (err) {
    res.status(500).json({ error: "ffmpeg failed", detail: String(err.message || err) });
  }
});

// ---- start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[ready] listening on ${PORT}`));
