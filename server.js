// server.js
const express = require("express");
const cors = require("cors");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// 把 /tmp 作为静态目录暴露出来，便于直接访问产物
app.use("/output", express.static("/tmp"));

app.get("/", (_, res) => res.type("text/plain").send("ok"));
app.get("/healthz", (_, res) => res.type("text/plain").send("ok"));

/**
 * 构建最小可跑的 FFmpeg 命令（竖屏 1080x1920，轻微运动+暗角等）
 * 你之前的“恐怖风格参数化”版本还能继续叠加，这里保留基础款，确保服务可跑。
 */
function buildFfmpegArgs({ imageUrl, audioUrl, outFile }) {
  const filter =
    "[0:v]" +
    "scale=ceil(1080*1.18):ceil(1920*1.18)," +
    "crop=1080:1920:" +
    "x='(in_w-out_w)/2 + 22*sin(t*0.22) + 4*sin(t*3.5)'" +
    ":y='(in_h-out_h)/2 + 16*sin(t*0.19) + 3*sin(t*2.8)'," +
    "rotate='0.004*sin(2*t)+0.002*cos(7*t)'," +
    "eq=contrast=1.06:brightness=-0.04:saturation=0.92," +
    "noise=alls=9:allf=t," +
    "rgbashift=rh=2:rv=2:gh=-2:gv=-2," +
    "vignette=0.12:0.65," +
    "fps=30,format=yuv420p[v]";

  return [
    "-y",
    "-loop", "1",
    "-i", imageUrl,
    "-i", audioUrl,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "1:a",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outFile
  ];
}

/**
 * 同步跑：等 FFmpeg 完成再一次性返回
 */
function runFfmpegBuffered(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.stdout.on("data", () => {}); // 忽略
    proc.on("close", (code) => {
      if (code === 0) resolve({ code, stderr });
      else reject(new Error(`ffmpeg exit ${code}\n${stderr}`));
    });
  });
}

/**
 * 流式跑：把 FFmpeg stderr 实时写回响应（curl 能立刻看到）
 */
function runFfmpegStream(args, res, finalUrl) {
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.write(`# FFmpeg started\n\n$ ffmpeg ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}\n\n`);

  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  proc.stdout.on("data", (d) => {
    // ffmpeg基本不往stdout写，这里留着以防万一
    res.write(d.toString());
  });
  proc.stderr.on("data", (d) => {
    res.write(d.toString());
  });
  proc.on("close", (code) => {
    if (code === 0) {
      res.write(`\n\n[DONE] code=${code}\nURL: ${finalUrl}\n`);
      res.end();
    } else {
      res.write(`\n\n[ERROR] ffmpeg exit ${code}\n`);
      res.end();
    }
  });
}

app.post("/make/segments", async (req, res) => {
  try {
    const body = req.body || {};
    const imageUrl = body.image_url;
    const audioUrls = Array.isArray(body.audio_urls) ? body.audio_urls : [];
    const audioUrl = audioUrls[0];
    const prefix = body.outfile_prefix || "out";
    const ts = Date.now();
    const outFile = path.join("/tmp", `${prefix}_${ts}.mp4`);
    const finalUrl = `${req.protocol}://${req.get("host")}/output/${path.basename(outFile)}`;

    if (!imageUrl || !audioUrl) {
      return res.status(400).json({ error: "image_url 和 audio_urls[0] 必填" });
    }

    const args = buildFfmpegArgs({ imageUrl, audioUrl, outFile });

    // ?stream=1 开启流式日志
    if (String(req.query.stream || "") === "1") {
      return runFfmpegStream(args, res, finalUrl);
    }

    // 默认：缓冲执行，完成后返回 JSON
    await runFfmpegBuffered(args);
    return res.json({ outfile: finalUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[ready] listening on ${PORT}`);
});
