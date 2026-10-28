# Deploying to App Platform

This folder (`voice-assistant-demo/`) is a complete, self-contained Node.js
web app — `server.js` + `package.json` — ready to deploy as-is.

## 1. Push this code to GitHub (or GitLab)

App Platform deploys from a git repo, not a local folder.

```bash
cd voice-assistant-demo
git init
git add .
git commit -m "Voice assistant demo"
git branch -M main
git remote add origin https://github.com/<your-username>/voice-assistant-demo.git
git push -u origin main
```

With this layout — this folder *is* the repo root — `app.yaml`'s
`source_dir` line should stay commented out/deleted, which it already is.

If you'd rather push this as a subfolder of a bigger repo, uncomment
`source_dir: /voice-assistant-demo` (or whatever path you used) in
`app.yaml`.

## 2. Fill in `app.yaml`

Edit `app.yaml` in this folder:

- `github.repo`: set to `<your-username>/voice-assistant-demo`
- `github.branch`: usually `main`
- `MODEL_ACCESS_KEY` value: leave the placeholder for your first deploy —
  `DRY_RUN=true` means it isn't needed yet. Set the real value later via
  the Control Panel or `doctl`, not by committing it to git.
- `CHAT_MODEL` / `TTS_MODEL` / `TTS_VOICE`: defaults are reasonable for a
  first deploy; change if you want a different conversational model or
  voice.

## 3. Deploy

**Using `doctl`:**

```bash
doctl apps create --spec app.yaml
```

This comes up with `DRY_RUN=true` — safe, no key needed, no spend — so you
can confirm the deploy works before adding real credentials.

**Using the Control Panel:**

Apps → Create App → GitHub → pick the repo/branch → App Platform
auto-detects Node.js from `package.json` → on the review screen, paste in
`app.yaml`'s contents (Edit Your App Spec) or set `http_port: 8080` and the
env vars manually → Create Resources.

## 4. Verify the dry-run deploy

Open `https://<your-app>.ondigitalocean.app/` in **Chrome or Edge** (for mic
support — App Platform serves over HTTPS by default, which the browser
requires for microphone access):

- You should see the "dry run" badge in the header.
- Tap a quick-start chip (or type a message and hit send) — a mock reply
  should appear within a second, followed by a short chime sound (not real
  speech — that's expected in dry-run mode).
- Tap the mic button and speak — you should see live interim text appear as
  you talk, then your message sent automatically once you stop.
- `/healthz` should return `ok`.

## 5. Go live

1. Get a real model access key: Control Panel → **Inference** →
   **Model Access Keys** → Create Model Access Key.
2. Confirm the team's Inference & Agents balance is positive (Serverless
   Inference is prepaid).
3. In the app's Settings → `web` component → Environment Variables:
   - Set `MODEL_ACCESS_KEY` to the real key (mark it **Encrypted**).
   - Set `DRY_RUN` to `false`.
4. Save — App Platform redeploys automatically.
5. Reload the app and try it again. This now sends real requests to
   `https://inference.do-ai.run/v1/chat/completions` and
   `https://inference.do-ai.run/v1/audio/speech`, and you should hear an
   actual synthesized voice reply.

## Notes

- `instance_size_slug: apps-s-1vcpu-1gb` is the smallest paid tier — plenty
  for this app.
- `deploy_on_push: true` means every push to `branch` auto-redeploys; turn
  it off in `app.yaml` for manual control.
- As shipped, `/api/respond` has no auth and no rate limiting beyond
  message-size caps — fine for a guided demo, but add basic auth or an
  allowlist before leaving it publicly reachable with a live key for an
  extended period, since every exchange is a billed chat + TTS call.
- Microphone access is a browser permission the visitor grants per-site;
  there's nothing to configure server-side for it, but make sure whoever is
  demoing live has granted mic permission to the app's domain beforehand.
