import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import { exec } from "child_process";
import path from "path";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json({ limit: "20mb" }));

// 输出目录
const OUTPUT_DIR = "/opt/render/project/src/output";
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 基础 URL（从环境变量取）
const BASE_URL = process.env.PUBLIC_BASE_URL || "";

// 下载远程文件到 /tmp
async function downloadToTmp(url, ext = "") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `/tmp/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  fs.writeFileSync(tmp, buf);
  return tmp;
}

// -------------------- 路由 --------------------

// 健康检查
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// 根路径
app.get("/", (_req, res) => res.status(200).send("FFmpeg service is running"));

// 制作视频
app.post("/make/segments", async (req, res) => {
  try {
    const { image_url, audio_urls, outfile_prefix, style, subtitles } = req.body;
    if (!image_url || !audio_urls || audio_urls.length === 0) {
      return res.status(400).json({ error: "image_url and audio_urls required" });
    }

    // 下载图像
    const imgFile = await downloadToTmp(image_url, path.extname(image_url) || ".png");

    // 合并多个音频
    let audioFile;
    if (audio_urls.length === 1) {
      audioFile = await downloadToTmp(audio_urls[0], ".mp3");
    } else {
      const parts = [];
      for (const u of audio_urls) {
        parts.push(await downloadToTmp(u, ".mp3"));
      }
      const listFile = `/tmp/list_${Date.now()}.txt`;
      fs.writeFileSync(listFile, parts.map(p => `file '${p}'`).join("\n"));
      audioFile = `/tmp/concat_${Date.now()}.mp3`;
      await new Promise((resolve, reject) => {
        exec(`ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy ${audioFile}`, (err) => {
          if (err) reject(err); else resolve();
        });
      });
    }

    // 基本参数
    const scaleFactor = style?.scaleFactor || 1.0;
    const panXSlow = style?.panXSlow || 0;
    const panXFast = style?.panXFast || 0;
    const panYSlow = style?.panYSlow || 0;
    const panYFast = style?.panYFast || 0;
    const rotSlow = style?.rotSlow || 0;
    const rotFast = style?.rotFast || 0;
    const contrast = style?.contrast ?? 1.0;
    const brightness = style?.brightness ?? 0.0;
    const saturation = style?.saturation ?? 1.0;
    const noiseStrength = style?.noiseStrength || 0;
    const rgbShift = style?.rgbShift || 0;
    const vignette = style?.vignette || 0;
    const vignetteSoft = style?.vignetteSoft || 0.5;
    const fps = style?.fps || 30;
    const crf = style?.crf || 20;
    const audio_bitrate = style?.audio_bitrate || "192k";

    // 构建 filter_complex
    let filters = `[0:v]scale=ceil(1080*${scaleFactor}):ceil(1920*${scaleFactor}),`;
    filters += `crop=1080:1920:x='(in_w-out_w)/2 + ${panXSlow}*sin(t*0.25) + ${panXFast}*sin(t*4.2)':`;
    filters += `y='(in_h-out_h)/2 + ${panYSlow}*sin(t*0.20) + ${panYFast}*sin(t*3.5)',`;
    filters += `rotate='${rotSlow}*sin(2*t)+${rotFast}*cos(7*t)',`;
    filters += `eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation}`;
    if (noiseStrength > 0) filters += `,noise=alls=${noiseStrength}:allf=t`;
    if (rgbShift > 0) filters += `,rgbashift=rh=${rgbShift}:rv=${rgbShift}:gh=-${rgbShift}:gv=-${rgbShift}`;
    if (vignette > 0) filters += `,vignette=${vignette}:${vignetteSoft}`;
    filters += `,fps=${fps},format=yuv420p[v]`;

    // 输出文件名
    const outName = `${outfile_prefix || "out"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
    const outPath = path.join(OUTPUT_DIR, outName);

    // 临时字幕文件
    let subsCmd = "";
    if (subtitles?.srt_url || subtitles?.srt_text) {
      const srtFile = `/tmp/subs_${Date.now()}.srt`;
      if (subtitles.srt_url) {
        const subsRes = await fetch(subtitles.srt_url);
        if (!subsRes.ok) throw new Error("Subtitle download failed");
        fs.writeFileSync(srtFile, Buffer.from(await subsRes.arrayBuffer()));
      } else if (subtitles.srt_text) {
        fs.writeFileSync(srtFile, subtitles.srt_text);
      }
      const styleOpts = subtitles.ass_style
        ? Object.entries(subtitles.ass_style).map(([k, v]) => `${k}=${v}`).join(",")
        : "";
      subsCmd = `-vf "subtitles=${srtFile}${styleOpts ? `:force_style='${styleOpts}'` : ""}"`;
    }

    // 拼 ffmpeg 命令
    const cmd = `ffmpeg -y -i ${imgFile} -i ${audioFile} -filter_complex "${filters}" -map "[v]" -map 1:a -c:v libx264 -preset veryfast -crf ${crf} -c:a aac -b:a ${audio_bitrate} -shortest ${subsCmd} ${outPath}`;

    await new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) reject(stderr || err); else resolve(stdout);
      });
    });

    const fullUrl = BASE_URL ? `${BASE_URL}/output/${outName}` : `/output/${outName}`;
    res.json({ ok: true, file: `/output/${outName}`, full_url: fullUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// 静态文件（视频输出目录）
app.use("/output", express.static(OUTPUT_DIR));

// 启动
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FFmpeg service on ${PORT}`);
});
