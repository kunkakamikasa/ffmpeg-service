// server.js
// FFmpeg web service with motion effects + optional subtitles (SRT)
// Works on Render free tier. Requires ffmpeg in PATH (Render has it).
// Make sure to set BASE_URL in Render Environment to your service URL,
// e.g. https://ffmpeg-service-xxxxx.onrender.com

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import axios from "axios";
import crypto from "crypto";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configs & Paths ---
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, "output");

// IMPORTANT: set this in Render -> Environment
const BASE_URL =
  process.env.BASE_URL || "http://localhost:" + PORT; // fallback for local

// Ensure output exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Serve static files from /output so returned URLs are directly playable
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use("/output", express.static(OUTPUT_DIR, { maxAge: "30d", index: false }));

// ---------- Utility helpers ----------
const tmpDir = path.join(os.tmpdir(), "ffmpeg-svc");
fs.mkdirSync(tmpDir, { recursive: true });

function uid(n = 8) {
  return crypto.randomBytes(n).toString("hex");
}

function safeName(s) {
  return String(s || "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 64);
}

async function downloadToFile(url, extHint = "") {
  const id = uid();
  const ext =
    extHint ||
    (new URL(url).pathname.split(".").pop() || "").toLowerCase().split("?")[0];
  const file = path.join(tmpDir, `${id}.${safeName(ext) || "bin"}`);

  const res = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(file, Buffer.from(res.data));
  return file;
}

function runFFmpeg(args, logTag = "ffmpeg") {
  return new Promise((resolve, reject) => {
    const p = execFile("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += d.toString();
      // Optionally log concise progress:
      // process.stderr.write(".");
    });
    p.on("close", (code) => {
      if (code === 0) resolve({ code, stderr });
      else reject(new Error(`[${logTag}] exit ${code}\n${stderr}`));
    });
  });
}

// Build default subtle horror motion filter for 1080x1920
function buildMotionFilter(opts = {}) {
  const {
    width = 1080,
    height = 1920,
    scaleFactor = 1.22, // 1.1~1.3
    panXSlow = 20, // px amplitude
    panXFast = 5,
    panYSlow = 16,
    panYFast = 4,
    rotSlow = 0.005, // radians amplitude
    rotFast = 0.002,
    contrast = 1.06,
    brightness = -0.04,
    saturation = 0.92,
    noiseStrength = 9, // 0~10
    rgbShift = 2, // 0~6
    vignette = 0.12, // 0~0.6
    vignetteSoft = 0.65,
    fps = 30,
    // switches
    enableNoise = true,
    enableRgbShift = true,
    enableVignette = true,
  } = opts;

  const scaleW = `ceil(${width}*${scaleFactor})`;
  const scaleH = `ceil(${height}*${scaleFactor})`;

  const pieces = [
    `scale=${scaleW}:${scaleH}`,
    `crop=${width}:${height}:x='(in_w-out_w)/2 + ${panXSlow}*sin(t*0.25) + ${panXFast}*sin(t*4.2)':y='(in_h-out_h)/2 + ${panYSlow}*sin(t*0.20) + ${panYFast}*sin(t*3.5)'`,
    `rotate='${rotSlow}*sin(1.7*t)+${rotFast}*cos(9*t)'`,
    `eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation}`,
  ];

  if (enableNoise) pieces.push(`noise=alls=${noiseStrength}:allf=t`);
  if (enableRgbShift)
    pieces.push(`rgbashift=rh=${rgbShift}:rv=${rgbShift}:gh=-${rgbShift}:gv=-${rgbShift}`);
  if (enableVignette) pieces.push(`vignette=${vignette}:${vignetteSoft}`);

  pieces.push(`fps=${fps}`, `format=yuv420p`);

  // Output label [v] for mapping
  return `${pieces.join(",")}[v]`;
}

// Optional: subtitles force_style
function buildAssStyle(style = {}) {
  // libass style keys
  const {
    Fontname = "Arial",
    Fontsize = 36,
    PrimaryColour = "&H00FFFFFF&", // white
    OutlineColour = "&H00000000&", // black
    BackColour = "&H64000000&", // shadow
    BorderStyle = 1, // 1 = outline + shadow
    Outline = 2,
    Shadow = 1,
    Alignment = 2, // 2 bottom-center
    MarginV = 48,
    Bold = 0,
    Italic = 0,
  } = style;

  return [
    `Fontname=${Fontname}`,
    `Fontsize=${Fontsize}`,
    `PrimaryColour=${PrimaryColour}`,
    `OutlineColour=${OutlineColour}`,
    `BackColour=${BackColour}`,
    `BorderStyle=${BorderStyle}`,
    `Outline=${Outline}`,
    `Shadow=${Shadow}`,
    `Alignment=${Alignment}`,
    `MarginV=${MarginV}`,
    `Bold=${Bold}`,
    `Italic=${Italic}`,
  ].join(",");
}

// -------- Main route (compatible with your current workflow) --------
// POST /make/segments
// Body:
// {
//   "image_url": "<url>",
//   "audio_urls": ["<url1>", "<url2>", ...] | "<single>",
//   "outfile_prefix": "demo_dropbox",
//   "style": { ... optional motion params ... },
//   "subtitles": {
//      "srt_url": "<url>" | null,
//      "srt_text": "1\n00:00:00,000 --> 00:00:01,000\n...", // 二选一
//      "ass_style": { Fontsize, MarginV, Alignment, ... } // 可选
//   }
// }
app.post("/make/segments", async (req, res) => {
  try {
    const startedAt = Date.now();
    const {
      image_url,
      audio_urls,
      outfile_prefix = "seg",
      style = {},
      subtitles = null,
    } = req.body || {};

    if (!image_url || !audio_urls || (Array.isArray(audio_urls) && audio_urls.length === 0)) {
      return res.status(400).json({
        error: "image_url 和 audio_urls 必填，且 audio_urls 至少 1 个",
      });
    }

    // -------- 1) Download inputs --------
    const imgFile = await downloadToFile(image_url, "png");

    const audioList = Array.isArray(audio_urls) ? audio_urls : [audio_urls];
    const localAudios = [];
    for (let i = 0; i < audioList.length; i++) {
      localAudios.push(await downloadToFile(audioList[i], "mp3"));
    }

    // If multiple audio segments, concat to one
    let audioFile = localAudios[0];
    if (localAudios.length > 1) {
      const listFile = path.join(tmpDir, `concat_${uid()}.txt`);
      fs.writeFileSync(
        listFile,
        localAudios.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n")
      );
      const concatOut = path.join(tmpDir, `aud_${uid()}.mp3`);
      await runFFmpeg(
        ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", concatOut],
        "concat"
      );
      audioFile = concatOut;
    }

    // -------- 2) Optional: subtitles (download or inline) --------
    let srtFile = null;
    let subtitlesFilter = ""; // appended inside -filter_complex when present
    if (subtitles && (subtitles.srt_url || subtitles.srt_text)) {
      if (subtitles.srt_url) {
        srtFile = await downloadToFile(subtitles.srt_url, "srt");
      } else if (subtitles.srt_text) {
        srtFile = path.join(tmpDir, `sub_${uid()}.srt`);
        fs.writeFileSync(srtFile, subtitles.srt_text);
      }

      const forceStyle = buildAssStyle(subtitles.ass_style || {});
      // subtitles= reads file internally; chain it after we produce [v0]
      // We'll produce v0 then subtitles -> [v]
      // buildMotionFilter will output [v0] instead of [v] if subtitles are used
      subtitlesFilter = `,subtitles='${srtFile.replace(/'/g, "'\\''")}':force_style='${forceStyle.replace(
        /'/g,
        "\\'"
      )}'`;
    }

    // -------- 3) Build filters & run ffmpeg --------
    const id = `${outfile_prefix}_${startedAt}_${uid(6)}`;
    const outFile = path.join(OUTPUT_DIR, `${safeName(id)}.mp4`);

    // If we have subtitles, we first label to [v0], then add subtitles -> [v]
    const motion = buildMotionFilter(style);
    const filter = subtitles
      ? motion.replace(/\[v\]$/, "[v0]") + `${subtitlesFilter}[v]`
      : motion;

    const args = [
      "-y",
      "-loop",
      "1",
      "-i",
      imgFile,
      "-i",
      audioFile,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(style.crf || 20),
      "-c:a",
      "aac",
      "-b:a",
      String(style.audio_bitrate || "192k"),
      "-shortest",
      outFile,
    ];

    await runFFmpeg(args, "render");

    const fullUrl = `${BASE_URL.replace(/\/+$/, "")}/output/${path.basename(outFile)}`;

    // -------- 4) Respond --------
    return res.json({
      ok: true,
      file: `/output/${path.basename(outFile)}`, // 相对路径（兼容旧用法）
      full_url: fullUrl, // 新增：完整 URL（Make 里可直接用）
      duration_hint: "matches audio duration",
      width: 1080,
      height: 1920,
      style_used: style || {},
      subtitles: !!subtitles,
      id,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "FFmpeg process failed",
      detail: (err && err.message) || String(err),
    });
  }
});

// Health
app.get("/", (_req, res) => {
  res.type("text").send("FFmpeg service is up. Try POST /make/segments");
});

// Start
app.listen(PORT, () => {
  console.log(`✅ FFmpeg service listening on :${PORT}`);
  console.log(`   OUTPUT_DIR: ${OUTPUT_DIR}`);
  console.log(`   BASE_URL:   ${BASE_URL}`);
});
