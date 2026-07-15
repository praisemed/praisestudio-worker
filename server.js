import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

// ---------- Config (set these as environment variables on Railway) ----------
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TMP_DIR = "/tmp/praisestudio";

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// ---------- Helpers ----------

// Report job status back to Lovable, using the callbackUrl + callbackSecret
// that Lovable sent us for THIS specific job (not a fixed env var anymore).
async function reportStatus(callbackUrl, callbackSecret, jobId, status, extra = {}) {
  if (!callbackUrl) {
    console.log(`[job ${jobId}] ${status}`, extra);
    return;
  }
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
    console.error(`Failed to report status for job ${jobId}:`, err.message);
  }
}

// Buckets are PRIVATE, so we can't use getPublicUrl(). We upload the file,
// then create a time-limited signed URL for whoever needs to fetch it next.
// Signed URL expires in 7 days — plenty of time for the frontend to load it
// once, but the frontend should re-request a fresh one for long-term storage.
async function uploadToSupabase(localFilePath, bucket, destFileName) {
  if (!supabase) throw new Error("Supabase not configured on worker");
  const fileBuffer = fs.readFileSync(localFilePath);
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(destFileName, fileBuffer, { upsert: true });
  if (uploadError) throw uploadError;

  const { data: signedData, error: signError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(destFileName, 60 * 60 * 24 * 7); // 7 days
  if (signError) throw signError;

  // Store the raw storage path too — the frontend can re-sign this anytime
  // via Supabase's client SDK without needing the worker involved again.
  return { signedUrl: signedData.signedUrl, storagePath: `${bucket}/${destFileName}` };
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
// Lovable calls: POST /dispatch-download  { jobId, params, callbackUrl, callbackSecret }
// params: { url, quality, format }
app.post("/dispatch-download", async (req, res) => {
  const { jobId, params = {}, callbackUrl, callbackSecret } = req.body;
  const { url, quality = "1080", format = "mp4" } = params;

  if (!jobId || !url) {
    return res.status(400).json({ error: "jobId and params.url are required" });
  }
  res.status(202).json({ jobId, status: "queued" });

  (async () => {
    try {
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 10 });
      const outPath = path.join(TMP_DIR, `${jobId}.${format}`);

      const cmd = `yt-dlp -f "bestvideo[height<=${quality}]+bestaudio/best" --merge-output-format ${format} -o "${outPath}" "${url}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 70 });
      const { signedUrl, storagePath } = await uploadToSupabase(outPath, "raw-uploads", `${jobId}.${format}`);

      fs.unlinkSync(outPath);
      await reportStatus(callbackUrl, callbackSecret, jobId, "done", {
        progress: 100,
        output_url: signedUrl,
        storage_path: storagePath,
      });
    } catch (err) {
      console.error(err);
      await reportStatus(callbackUrl, callbackSecret, jobId, "failed", { error_message: err.message });
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
    try {
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 10 });

      const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
      const outputPath = path.join(TMP_DIR, `${jobId}-out.${format}`);
      await downloadToLocal(input_url, inputPath);

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 40 });

      const cmd = `ffmpeg -y -i "${inputPath}" -vf scale=${resolution.replace("x", ":")} -c:v libx264 -c:a aac "${outputPath}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 80 });
      const { signedUrl, storagePath } = await uploadToSupabase(outputPath, "processed-videos", `${jobId}.${format}`);

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
      await reportStatus(callbackUrl, callbackSecret, jobId, "done", {
        progress: 100,
        output_url: signedUrl,
        storage_path: storagePath,
      });
    } catch (err) {
      console.error(err);
      await reportStatus(callbackUrl, callbackSecret, jobId, "failed", { error_message: err.message });
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
    try {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set on worker");
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 10 });

      const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
      await downloadToLocal(input_url, inputPath);

      const audioPath = path.join(TMP_DIR, `${jobId}.mp3`);
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
      const srtPath = path.join(TMP_DIR, `${jobId}.srt`);
      fs.writeFileSync(srtPath, srtText);

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 80 });
      const { signedUrl, storagePath } = await uploadToSupabase(srtPath, "processed-videos", `${jobId}.srt`);

      fs.unlinkSync(inputPath);
      fs.unlinkSync(audioPath);
      fs.unlinkSync(srtPath);
      await reportStatus(callbackUrl, callbackSecret, jobId, "done", {
        progress: 100,
        output_url: signedUrl,
        storage_path: storagePath,
      });
    } catch (err) {
      console.error(err);
      await reportStatus(callbackUrl, callbackSecret, jobId, "failed", { error_message: err.message });
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
    try {
      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 10 });

      const inputPath = path.join(TMP_DIR, `${jobId}-input.mp4`);
      const outputPath = path.join(TMP_DIR, `${jobId}-clean.mp4`);
      await downloadToLocal(input_url, inputPath);

      const filters = masks.map((m) => `delogo=x=${m.x}:y=${m.y}:w=${m.width}:h=${m.height}`).join(",");
      const vf = filters || "null";

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 40 });
      const cmd = `ffmpeg -y -i "${inputPath}" -vf "${vf}" -c:a copy "${outputPath}"`;
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

      await reportStatus(callbackUrl, callbackSecret, jobId, "processing", { progress: 80 });
      const { signedUrl, storagePath } = await uploadToSupabase(outputPath, "processed-videos", `${jobId}-clean.mp4`);

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
      await reportStatus(callbackUrl, callbackSecret, jobId, "done", {
        progress: 100,
        output_url: signedUrl,
        storage_path: storagePath,
      });
    } catch (err) {
      console.error(err);
      await reportStatus(callbackUrl, callbackSecret, jobId, "failed", { error_message: err.message });
    }
  })();
});

app.listen(PORT, () => {
  console.log(`PraiseStudio worker listening on port ${PORT}`);
});
