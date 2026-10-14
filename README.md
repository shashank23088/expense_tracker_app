# Expense Tracker App

Offline expense tracker for Android with a local-AI coach. No account, no cloud, no tracking: your data lives in a file on your phone.

## Install (with automatic updates, recommended)
1. Install **Obtainium** from F-Droid or https://github.com/ImranR98/Obtainium/releases
2. In Obtainium: **Add App** → paste `https://github.com/shashank23088/expense_tracker_app` → **Add** → **Install**.
3. Obtainium checks this repo's Releases and offers each new version. Updates install over the old app and keep your data.

## Install manually
Download https://github.com/shashank23088/expense_tracker_app/releases/latest/download/ExpenseTracker.apk on your phone,
open it and allow "install unknown apps". To update later, install the new APK over the old one. **Don't uninstall first**,
because uninstalling deletes the app's data.

## Features
- Daily entry by category (expenses + income), with monthly recurring items (rent, EMI, salary, SIP)
- Month / Quarter / Year views, Indian FY (Apr–Mar) option, trend charts, category × month tables
- Per-category monthly budgets, with "suggest from history" (needs = 3-month avg, wants = −15%)
- Rule-based analysis that always works offline: pace/projection, budget overruns, category spikes, savings rate,
  50/30/20 split, unusual transactions, habit spends, weekend effect, subscriptions, no-spend days
- AI coach chat over any **local** OpenAI-compatible model (Ollama, llama.cpp `llama-server`, LM Studio)
- Light / dark / follow-system theme
- Export backup JSON / CSV to Downloads, import backup

## Local AI setup (free, open source)
**On the phone:** Termux from F-Droid, then
```
pkg update && pkg install ollama
ollama serve &
ollama pull qwen2.5:1.5b      # 0.5b for weak phones, 3b for flagships
```
App → Settings → AI coach: `http://127.0.0.1:11434`, model `qwen2.5:1.5b`.

**On a PC (same Wi-Fi):** `OLLAMA_HOST=0.0.0.0 ollama serve`, `ollama pull qwen2.5:7b`, then URL `http://<PC-IP>:11434`.

## Releasing a new version
```
git tag v1.2.0 && git push origin v1.2.0
```
`.github/workflows/release.yml` builds and signs the APK and publishes it as a GitHub Release. Obtainium users get it automatically.
It needs one repo secret, `KEYSTORE_B64` (`base64 -w0 release.keystore`), plus `KEYSTORE_PASSWORD` if the key isn't the default.

## Build locally
`./build.sh` (Ubuntu) uses apt's Android SDK packages, with no Gradle or Android Studio. See the header of build.sh.
`release.keystore` is deliberately **not** in this repo (it's public, and anyone with the key could sign a fake update).
Keep your copy safe. An APK signed with a different key won't install over the existing app.
