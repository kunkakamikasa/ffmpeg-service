import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// 静态目录，暴露 public/output
const outputDir = path.join(__dirname, "public/output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}
app.use("/output", express.static(outputDir));

// 获取基础 URL（Render 会自动带 RENDER_EXTERNAL_URL）
function getBaseUrl(req) {
  return (
    process.env.BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `${req.protocol}://${req.get("host")}`
  );
}

// /make 接口：拼接图片+音频 → 视频
app.post("/make", async (req, res) => {
  try {
    const { image_url, audio_url, out_name, duration = 0 } = req.body;
    if (!image_url || !audio_url || !out_name) {
      return res.status(400).json({ ok: false, error: "缺少必要字段" });
    }

    const outPath = path.join(outputDir, out_name);

    // 下载输入文件到 /tmp
    const imgPath = `/tmp/${Date.now()}_img.png`;
    const audPath = `/tmp/${Date.now()}_aud.mp3`;

    const downloadFile = async (url, dest) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`下载失败: ${url}`);
      const buf = await res.buffer();
      fs.writeFileSync(dest, buf);
    };
    await downloadFile(image_url, imgPath);
    await downloadFile(audio_url, audPath);

    // ffmpeg 合成命令
    const ffmpegCmd = `ffmpeg -y -loop 1 -i "${imgPath}" -i "${audPath}" -c:v libx264 -c:a aac -shortest "${outPath}"`;

    exec(ffmpegCmd, (err) => {
      if (err) {
        console.error("FFmpeg 错误：", err);
        return res.status(500).json({ ok: false, error: "FFmpeg 执行失败" });
      }

      const fileUrl = `${getBaseUrl(req)}/output/${out_name}`;
      res.json({ ok: true, video_urls: [fileUrl], count: 1 });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 启动
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FFmpeg 服务运行在 http://localhost:${PORT}`);
});
