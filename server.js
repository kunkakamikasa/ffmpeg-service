import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const app = express();
const execAsync = promisify(exec);

app.use(express.json());

/**
 * 健康检查
 */
app.get(["/", "/health", "/healthz"], (req, res) => {
  res.type("text").send("ok");
});

/**
 * 构造滤镜字符串
 */
function buildFilter(opts = {}) {
  const {
    resolution = "1280x720",
    fps = 30,
    contrast,
    brightness,
    saturation,
    vignette,
    noise,
    rgbashift,
    rotate,
  } = opts;

  let filters = [];

  // 基础
  filters.push(`scale=${resolution.split("x")[0]}:${resolution.split("x")[1]}`);
  filters.push(`fps=${fps}`);
  filters.push("format=yuv420p");

  // 样式参数
  if (contrast || brightness || saturation) {
    filters.push(
      `eq=${contrast ? `contrast=${contrast}:` : ""}${
        brightness ? `brightness=${brightness}:` : ""
      }${saturation ? `saturation=${saturation}` : ""}`
        .replace(/:+$/, "") // 去掉多余的冒号
    );
  }

  if (vignette) filters.push(`vignette=${vignette}`);
  if (noise) filters.push(`noise=alls=${noise}:allf=t`);
  if (rgbashift)
    filters.push(
      `rgbashift=rh=${rgbashift.rh || 0}:rv=${rgbashift.rv || 0}:gh=${
        rgbashift.gh || 0
      }:gv=${rgbashift.gv || 0}`
    );
  if (rotate) filters.push(`rotate='${rotate}'`);

  return `[0:v]${filters.join(",")}[v]`;
}

/**
 * 生成视频 /make/segments
 */
app.post("/make/segments", async (req, res) => {
  try {
    const {
      image_url,
      audio_urls,
      outfile_prefix = "output",
      resolution = "1280x720",
      fps = 30,
      style = {},
      subtitle_url,
    } = req.body;

    if (!image_url || !audio_urls || audio_urls.length === 0) {
      return res.status(400).json({
        error: "image_url 和 audio_urls 必填，且 audio_urls 至少 1 个",
      });
    }

    const safeName = `${outfile_prefix}_${Date.now()}`;
    const outFile = `/tmp/${safeName}.mp4`;

    // 构造输入
    let inputs = [`-loop 1 -i "${image_url}"`];
    audio_urls.forEach((url) => inputs.push(`-i "${url}"`));

    // 构造滤镜
    const filterComplex = buildFilter({ resolution, fps, ...style });

    // 基础命令
    let cmd = `ffmpeg -y ${inputs.join(" ")} -filter_complex "${filterComplex}" -map "[v]" -map 1:a -c:v libx264 -preset veryfast -crf 18 -c:a aac -shortest ${outFile}`;

    // 如果有字幕
    if (subtitle_url) {
      cmd = `ffmpeg -y ${inputs.join(
        " "
      )} -filter_complex "${filterComplex}" -map "[v]" -map 1:a -vf "subtitles='${subtitle_url}'" -c:v libx264 -preset veryfast -crf 18 -c:a aac -shortest ${outFile}`;
    }

    console.log("Running:", cmd);
    await execAsync(cmd);

    // 输出目录
    const outDir = "/tmp/output";
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    fs.renameSync(outFile, path.join(outDir, `${safeName}.mp4`));

    // 返回完整 URL
    const publicBase = process.env.PUBLIC_BASE_URL || "";
    const fileUrl = `${publicBase}/output/${safeName}.mp4`;

    return res.json({ file_url: fileUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 静态托管
 */
app.use("/output", express.static("/tmp/output"));

// 启动
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[ready] listening on ${PORT}`);
});
