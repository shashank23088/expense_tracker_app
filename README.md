# Expense Tracker App

Offline expense tracker for Android with local-AI insights. No account, no cloud, no tracking.

## Install
Copy `dist/ExpenseTracker.apk` to your phone, open it, and allow "install unknown apps" when asked.
Android 7+ supported.

## Features
- Daily entry by category (expenses + income), monthly recurring items (rent, EMI, salary, SIP)
- Month / Quarter / Year views, Indian FY (Apr–Mar) option, 12-month & 6-quarter trends, category × month tables
- Per-category monthly budgets, with "suggest from history" (needs = 3-month avg, wants = −15%)
- Rule-based analysis that always works offline: pace/projection, budget overruns, category spikes, savings rate,
  50/30/20 split, unusual transactions, small-spend leaks, weekend effect, subscriptions, no-spend days
- AI coach chat, using any **local** OpenAI-compatible LLM (Ollama, llama.cpp `llama-server`, LM Studio)
- Export backup JSON / CSV to Downloads, import backup

## Local AI setup (free, open source)
**On the phone:** Termux from F-Droid, then
```
pkg update && pkg install ollama
ollama serve &
ollama pull qwen2.5:1.5b      # 0.5b for weak phones, 3b for flagships
```
App → Settings → Local AI: `http://127.0.0.1:11434`, model `qwen2.5:1.5b`.

**On a PC (same Wi-Fi):** `OLLAMA_HOST=0.0.0.0 ollama serve`, `ollama pull qwen2.5:7b`, then URL `http://<PC-IP>:11434`.

## Build
`./build.sh` (Ubuntu): uses apt's Android SDK packages, with no Gradle or Android Studio. See the header of build.sh.
`release.keystore` is deliberately **not** in this repo (it's public, and anyone with the key could sign a fake update).
Keep your copy safe: `build.sh` generates a new key if it's missing, and an APK signed with a different key
won't install over the old app. Uninstalling to switch keys deletes the app's data. **Export a backup before reinstalling.**

## Web / PWA version
`web/` is the same app as an installable PWA (data stays in browser storage). Host it free on GitHub Pages,
Cloudflare Pages or Netlify, or run `python3 -m http.server -d web` locally.

## Hosted version (claude.ai artifact)
`python3 web/build_artifact.py` builds `dist/expense-tracker.html`, a single file with CSS and JS inlined.
Hosted, data lives in a private per-user store and the AI coach uses Claude, because the page can't reach localhost.
