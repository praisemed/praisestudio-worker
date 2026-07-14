# PraiseStudio Worker — Deployment Guide (Zero Experience Needed)

This folder is a small server that does the actual video work (download, encode,
subtitles, watermark removal) that Lovable itself cannot do. Follow these steps
exactly and you'll have it live in about 15–20 minutes.

---

## Step 1 — Create a GitHub account and repo (5 min)

1. Go to https://github.com and sign up if you don't have an account.
2. Click the **+** icon top-right → **New repository**.
3. Name it `praisestudio-worker`, keep it **Private**, click **Create repository**.
4. On the new repo page, click **uploading an existing file**.
5. Drag in every file from this folder (`server.js`, `package.json`, `Dockerfile`,
   `.env.example`, `README.md`) and click **Commit changes**.

## Step 2 — Deploy it on Railway (10 min)

Railway is a hosting service that can run this server 24/7. It has a free trial.

1. Go to https://railway.app and sign up (use "Continue with GitHub" — easiest).
2. Click **New Project** → **Deploy from GitHub repo**.
3. Pick the `praisestudio-worker` repo you just created.
4. Railway will detect the `Dockerfile` automatically and start building. Let it finish
   (watch the "Deployments" tab — wait for a green checkmark).
5. Click on the deployed service → **Settings** tab → **Networking** → **Generate Domain**.
   This gives you a public URL like `https://praisestudio-worker-production.up.railway.app`.
   **This is your `WORKER_API_URL`.** Copy it.

## Step 3 — Add environment variables in Railway

Still in Railway, click your service → **Variables** tab → add these one at a time:

| Variable | Where to get it |
| --- | --- |
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API → "Project URL" |
| `SUPABASE_SERVICE_KEY` | Supabase dashboard → Project Settings → API → "service_role" key (keep this secret, never share it) |
| `LOVABLE_WEBHOOK_URL` | Your Lovable app's URL + `/api/job-update`, e.g. `https://your-app.lovable.app/api/job-update` |
| `OPENAI_API_KEY` | https://platform.openai.com/api-keys → create a new key (only needed for the subtitles feature) |

After adding these, Railway will automatically redeploy the service.

## Step 4 — Create the Supabase storage buckets

1. In Supabase dashboard → **Storage** → **New bucket**.
2. Create three buckets, all set to **Public**:
   - `raw-uploads`
   - `processed-videos`
   - `thumbnails`

## Step 5 — Give the URL to Lovable

1. Go back to Lovable and open your project settings / environment variables.
2. Add `WORKER_API_URL` = the Railway URL you copied in Step 2.
3. Ask Lovable to redeploy.

## Step 6 — Test it

1. In your PraiseStudio app, paste a YouTube URL into the Download stage and submit.
2. Check Railway's **Deployments → Logs** tab — you should see it running `yt-dlp`.
3. After a minute or two, check the `raw-uploads` bucket in Supabase — the downloaded
   file should appear there, and your app's job status should flip to "done".

---

## What each endpoint does

| Endpoint | What it runs | Needs |
| --- | --- | --- |
| `POST /download` | `yt-dlp` to fetch video from URL | — |
| `POST /export` | `ffmpeg` to re-encode/resize | — |
| `POST /add-subtitles` | Extracts audio, sends to OpenAI Whisper, returns `.srt` | `OPENAI_API_KEY` |
| `POST /remove-watermark` | Basic `ffmpeg delogo` blur over masked regions | — |

**Note on watermark removal:** the current version uses a basic blur filter
(`ffmpeg delogo`), not true AI inpainting. It will visibly blur the watermark
area rather than seamlessly reconstruct what's behind it. True inpainting
(e.g. via a hosted LaMa model on Replicate) is a further upgrade — ask me
when you're ready to add it.

## Costs to expect

- **Railway**: free trial credit, then usage-based (~$5–20/month depending on
  how much video processing you run).
- **OpenAI Whisper**: ~$0.006 per minute of audio transcribed.
- **Supabase**: free tier covers storage up to 1GB; video files will likely
  push you into their paid tier (~$25/month) fairly quickly given file sizes.

## If something breaks

Check Railway's **Logs** tab first — every error from `yt-dlp`/`ffmpeg`/Whisper
gets printed there. Most common issues:
- "yt-dlp: command not found" → the Docker build didn't finish; redeploy.
- Job stuck on "processing" forever → check `LOVABLE_WEBHOOK_URL` is correct
  and that your Lovable `/api/job-update` endpoint actually exists.
- "Supabase not configured" → double check `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`
  variables in Railway.
