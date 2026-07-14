import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

// ---------- Config (set these as environment variables on your host) ----------
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LOVABLE_WEBHOOK_URL = process.env.LOVABLE_WEBHOOK_URL; // e.g. https://your-app.lovable.app/api/job-update
const TMP_DIR = "/tmp/praisestudio";

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// ---------- Helpers ----------

// Tell the Lovable app how a job is going (queued/processing/done/failed)
async function notifyLovable(jobId, status, extra = {}) {
  if (!LOVABLE_WEBHOOK_URL) {
    console.log(`[job ${jobId}] ${status}`, extra);
    return;
  }
  try {
    await fetch(LOVABLE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, status, ...extra }),
    });
  } catch (err) {
    console.error("Failed to notify Lovable webhook:", err.message);
  }
}

// Upload a processed file to Supabase Storage and return its public URL
async function uploadToSupabase(localFilePath, bucket, destFileName) {
  if (!supabase) throw new Error("Supabase not configured on worker");
  const fileBuffer = fs.readFileSync(localFilePath);
  const { error } = await supabase.storage
    .from(bucket)
    .upload(destFileName, fileBuffer, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(destFileName);
  return data.publicUrl;
}

// ---------- Health check ----------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "PraiseStudio worker is running" });
});

// ---------- 1. DOWNLOAD (yt-dlp) ----------
app.post("/download", async (req, res) => {
  const { job_id, url, quality = "1080", format = "mp4" } = req.body;
  const jobId = job_id || uuidv4();
  res.status(202).json({ job_id: jobId, status: "queued" });

  (async () => {
    try {
      await notifyLovable(jobId, "processing", { progress: 10 });
      const outPath = path.join(TMP_DIR, `${jobId}.${format}`);

      const cmd = `yt-dlp -f "bestvideo[height<=${quality}]+bestaudio/best" --merge-output-format ${format} -o "${outPath}" "${url}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await notifyLovable(jobId, "processing", { progress: 70 });
      const publicUrl = await uploadToSupabase(
        outPath,
        "raw-uploads",
        `${jobId}.${format}`
      );

      fs.unlinkSync(outPath);
      await notifyLovable(jobId, "done", { progress: 100, output_url: publicUrl });
    } catch (err) {
      console.error(err);
      await notifyLovable(jobId, "failed", { error_message: err.message });
    }
  })();
});

// ---------- 2. EXPORT (ffmpeg encode) ----------
app.post("/export", async (req, res) => {
  const {
    job_id,
    input_url,
    resolution = "1920x1080",
    format = "mp4",
  } = req.body;
  const jobId = job_id || uuidv4();
  res.status(202).json({ job_id: jobId, status: "queued" });

  (async () => {
    try {
      await notifyLovable(jobId, "processing", { progress: 10 });

      const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
      const outputPath = path.join(TMP_DIR, `${jobId}-out.${format}`);

      // download the source file first
      const resp = await fetch(input_url);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(inputPath, buffer);

      await notifyLovable(jobId, "processing", { progress: 40 });

      const cmd = `ffmpeg -y -i "${inputPath}" -vf scale=${resolution.replace(
        "x",
        ":"
      )} -c:v libx264 -c:a aac "${outputPath}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await notifyLovable(jobId, "processing", { progress: 80 });
      const publicUrl = await uploadToSupabase(
        outputPath,
        "processed-videos",
        `${jobId}.${format}`
      );

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
      await notifyLovable(jobId, "done", { progress: 100, output_url: publicUrl });
    } catch (err) {
      console.error(err);
      await notifyLovable(jobId, "failed", { error_message: err.message });
    }
  })();
});

// ---------- 3. ADD SUBTITLES (OpenAI Whisper API) ----------
app.post("/add-subtitles", async (req, res) => {
  const { job_id, input_url, language = "en" } = req.body;
  const jobId = job_id || uuidv4();
  res.status(202).json({ job_id: jobId, status: "queued" });

  (async () => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not set on worker");
      }
      await notifyLovable(jobId, "processing", { progress: 10 });

      const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
      const resp = await fetch(input_url);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(inputPath, buffer);

      // extract audio for smaller upload
      const audioPath = path.join(TMP_DIR, `${jobId}.mp3`);
      await execAsync(`ffmpeg -y -i "${inputPath}" -vn -acodec libmp3lame "${audioPath}"`);

      await notifyLovable(jobId, "processing", { progress: 50 });

      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(audioPath)]), "audio.mp3");
      form.append("model", "whisper-1");
      form.append("language", language);
      form.append("response_format", "srt");

      const whisperResp = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: form,
        }
      );
      const srtText = await whisperResp.text();
      const srtPath = path.join(TMP_DIR, `${jobId}.srt`);
      fs.writeFileSync(srtPath, srtText);

      await notifyLovable(jobId, "processing", { progress: 80 });
      const publicUrl = await uploadToSupabase(
        srtPath,
        "processed-videos",
        `${jobId}.srt`
      );

      fs.unlinkSync(inputPath);
      fs.unlinkSync(audioPath);
      fs.unlinkSync(srtPath);
      await notifyLovable(jobId, "done", { progress: 100, output_url: publicUrl });
    } catch (err) {
      console.error(err);
      await notifyLovable(jobId, "failed", { error_message: err.message });
    }
  })();
});

// ---------- 4. REMOVE WATERMARK (basic ffmpeg delogo — placeholder for real inpainting) ----------
app.post("/remove-watermark", async (req, res) => {
  const { job_id, input_url, masks = [] } = req.body;
  const jobId = job_id || uuidv4();
  res.status(202).json({ job_id: jobId, status: "queued" });

  (async () => {
    try {
      await notifyLovable(jobId, "processing", { progress: 10 });

      const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
      const outputPath = path.join(TMP_DIR, `${jobId}-clean.mp4`);
      const resp = await fetch(input_url);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(inputPath, buffer);

      // Basic delogo filter per mask region (blur-based, not true inpainting)
      // masks: [{ x, y, width, height }, ...]
      const filters = masks
        .map((m) => `delogo=x=${m.x}:y=${m.y}:w=${m.width}:h=${m.height}`)
        .join(",");
      const vf = filters || "null";

      await notifyLovable(jobId, "processing", { progress: 40 });
      const cmd = `ffmpeg -y -i "${inputPath}" -vf "${vf}" -c:a copy "${outputPath}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await notifyLovable(jobId, "processing", { progress: 80 });
      const publicUrl = await uploadToSupabase(
        outputPath,
        "processed-videos",
        `${jobId}-clean.mp4`
      );

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
      await notifyLovable(jobId, "done", { progress: 100, output_url: publicUrl });
    } catch (err) {
      console.error(err);
      await notifyLovable(jobId, "failed", { error_message: err.message });
    }
  })();
});

app.listen(PORT, () => {
  console.log(`PraiseStudio worker listening on port ${PORT}`);
});
