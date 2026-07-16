import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import "dotenv/config";

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const TMP_DIR = "/tmp/praisestudio";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// No Supabase env vars needed anymore — the worker never talks to
// Supabase directly. It sends finished files to Lovable's own
// /api/upload-job-result endpoint instead, and Lovable does the storage.

// ---------- Helpers ----------

// Report progress/failure status back to Lovable's /api/job-update.
async function reportStatus(callbackUrl, callbackSecret, jobId, status, extra = {}) {
  if (!callbackUrl) {
    console.log(`[job ${jobId}] ${status}`, extra);
    return;
  }
  console.log(`[job ${jobId}] reporting "${status}" to callbackUrl: ${callbackUrl}`);
  try {
    await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${callbackSecret}`,
      },
      body: JSON.stringify({ jobId, status, ...extra }),
    });
  } catch (err) {
    console.error(`Failed to report status for job ${jobId} to ${callbackUrl}:`, err.message, err.cause || "");
  }
}

// Derive the /api/upload-job-result URL from whatever callbackUrl
// Lovable gave us (which points at /api/job-update).
function deriveUploadUrl(callbackUrl) {
  return callbackUrl.replace(/\/api\/job-update\/?$/, "/api/upload-job-result");
}

// Send the finished file straight to Lovable. Lovable itself uploads it to
// the right Supabase Storage bucket, generates the signed URL, and marks
// the job "done" -- so on success we don't need to call reportStatus again.
async function uploadResultToLovable(callbackUrl, callbackSecret, jobId, bucket, filename, localFilePath) {
  const uploadUrl = deriveUploadUrl(callbackUrl);
  const fileBuffer = fs.readFileSync(localFilePath);

  const form = new FormData();
  form.append("jobId", jobId);
  form.append("bucket", bucket);
  form.append("filename", filename);
  form.append("file", new Blob([fileBuffer]), filename);

  const resp = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${callbackSecret}` },
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`upload-job-result failed: ${resp.status} ${text}`);
  }
  return resp.json().catch(() => ({}));
}

// Downloads a (possibly signed) source URL to a local temp path
async function downloadToLocal(url, localPath) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch input file: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
}

// ---------- Health check ----------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "PraiseStudio worker is running" });
});

// ---------- 1. DOWNLOAD (yt-dlp) ----------
// params: { url, quality, format }
app.post("/dispatch-download", async (req, res) => {
  const { jobId, params = {}, callbackUrl, callbackSecret } = req.body;
  const { url, quality = "1080", format = "mp4" } = params;

  if (!jobId || !url) {
    return res.status(400).json({ error: "jobId and params.url are required" });
  }
  res.status(202).json({ jobId, status: "queued" });

  (async () => {
    const outPath = path.join(TMP_DIR, `${jobId}.${format}`);
    try {
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 10 });

      const cmd = `yt-dlp -f "bestvideo[height<=${quality}]+bestaudio/best" --merge-output-format ${format} -o "${outPath}" "${url}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 70 });
      await uploadResultToLovable(callbackUrl, callbackSecret, jobId, "raw-uploads", `${jobId}.${format}`, outPath);
      // upload-job-result marks the job "done" on Lovable's side automatically
    } catch (err) {
      console.error(err);
      await reportStatus(callbackUrl, callbackSecret, jobId, "failed", { error_message: err.message });
    } finally {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }
  })();
});

// ---------- 2. EXPORT (ffmpeg encode) ----------
// params: { input_url, resolution, format }
app.post("/export", async (req, res) => {
  const { jobId, params = {}, callbackUrl, callbackSecret } = req.body;
  const { input_url, resolution = "1920x1080", format = "mp4" } = params;

  if (!jobId || !input_url) {
    return res.status(400).json({ error: "jobId and params.input_url are required" });
  }
  res.status(202).json({ jobId, status: "queued" });

  (async () => {
    const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
    const outputPath = path.join(TMP_DIR, `${jobId}-out.${format}`);
    try {
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 10 });
      await downloadToLocal(input_url, inputPath);

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 40 });
      const cmd = `ffmpeg -y -i "${inputPath}" -vf scale=${resolution.replace("x", ":")} -c:v libx264 -c:a aac "${outputPath}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 80 });
      await uploadResultToLovable(callbackUrl, callbackSecret, jobId, "processed-videos", `${jobId}.${format}`, outputPath);
    } catch (err) {
      console.error(err);
      await reportStatus(callbackUrl, callbackSecret, jobId, "failed", { error_message: err.message });
    } finally {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  })();
});

// ---------- 3. ADD SUBTITLES (OpenAI Whisper API) ----------
// params: { input_url, language }
app.post("/add-subtitles", async (req, res) => {
  const { jobId, params = {}, callbackUrl, callbackSecret } = req.body;
  const { input_url, language = "en" } = params;

  if (!jobId || !input_url) {
    return res.status(400).json({ error: "jobId and params.input_url are required" });
  }
  res.status(202).json({ jobId, status: "queued" });

  (async () => {
    const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
    const audioPath = path.join(TMP_DIR, `${jobId}.mp3`);
    const srtPath = path.join(TMP_DIR, `${jobId}.srt`);
    try {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set on worker");
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 10 });
      await downloadToLocal(input_url, inputPath);

      await execAsync(`ffmpeg -y -i "${inputPath}" -vn -acodec libmp3lame "${audioPath}"`);
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 50 });

      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(audioPath)]), "audio.mp3");
      form.append("model", "whisper-1");
      form.append("language", language);
      form.append("response_format", "srt");

      const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });
      if (!whisperResp.ok) throw new Error(`Whisper API error: ${whisperResp.status}`);
      const srtText = await whisperResp.text();
      fs.writeFileSync(srtPath, srtText);

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 80 });
      await uploadResultToLovable(callbackUrl, callbackSecret, jobId, "processed-videos", `${jobId}.srt`, srtPath);
    } catch (err) {
      console.error(err);
      await reportStatus(callbackUrl, callbackSecret, jobId, "failed", { error_message: err.message });
    } finally {
      [inputPath, audioPath, srtPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
    }
  })();
});

// ---------- 4. REMOVE WATERMARK (basic ffmpeg delogo — placeholder for real inpainting) ----------
// params: { input_url, masks: [{x,y,width,height}, ...] }
app.post("/remove-watermark", async (req, res) => {
  const { jobId, params = {}, callbackUrl, callbackSecret } = req.body;
  const { input_url, masks = [] } = params;

  if (!jobId || !input_url) {
    return res.status(400).json({ error: "jobId and params.input_url are required" });
  }
  res.status(202).json({ jobId, status: "queued" });

  (async () => {
    const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
    const outputPath = path.join(TMP_DIR, `${jobId}-clean.mp4`);
    try {
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 10 });
      await downloadToLocal(input_url, inputPath);

      const filters = masks.map((m) => `delogo=x=${m.x}:y=${m.y}:w=${m.width}:h=${m.height}`).join(",");
      const vf = filters || "null";

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 40 });
      const cmd = `ffmpeg -y -i "${inputPath}" -vf "${vf}" -c:a copy "${outputPath}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 80 });
      await uploadResultToLovable(callbackUrl, callbackSecret, jobId, "processed-videos", `${jobId}-clean.mp4`, outputPath);
    } catch (err) {
      console.error(err);
      await reportStatus(callbackUrl, callbackSecret, jobId, "failed", { error_message: err.message });
    } finally {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  })();
});

app.listen(PORT, () => {
  console.log(`PraiseStudio worker listening on port ${PORT}`);
});
