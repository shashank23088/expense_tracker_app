#!/usr/bin/env bash
# Builds dist/ExpenseTracker.apk with Ubuntu's packaged Android SDK — no Gradle, no Android Studio.
#   sudo apt-get install -y android-sdk-build-tools android-sdk-platform-23 apksigner zipalign dalvik-exchange openjdk-17-jdk
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD; B=$ROOT/build; A=$ROOT/android
JAR=/usr/lib/android-sdk/platforms/android-23/android.jar
DX=/usr/lib/android-sdk/build-tools/debian/dx
VERSION_NAME=${VERSION_NAME:-1.0.0}; VERSION_CODE=${VERSION_CODE:-1}

rm -rf "$B"; mkdir -p "$B"/{gen,classes,assets/www} dist
cp web/index.html web/app.css web/app.js web/icon-192.png "$B/assets/www/"

aapt package -f -M "$A/AndroidManifest.xml" -S "$A/res" -A "$B/assets" -I "$JAR" -J "$B/gen" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -F "$B/unsigned.apk"
javac -nowarn -Xlint:-options --release 8 -cp "$JAR" -d "$B/classes" \
  $(find "$B/gen" -name R.java) $(find "$A/src" -name '*.java')
"$DX" --dex --min-sdk-version=24 --output="$B/classes.dex" "$B/classes"
(cd "$B" && aapt add unsigned.apk classes.dex >/dev/null)
zipalign -f -p 4 "$B/unsigned.apk" "$B/aligned.apk"

# Keep this keystore! Updates must be signed with the same key or Android refuses to install over the old app.
KS=$ROOT/release.keystore
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -alias expenses -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass expenses -keypass expenses -dname "CN=Local Expense Tracker" >/dev/null 2>&1
apksigner sign --ks "$KS" --ks-pass pass:expenses --key-pass pass:expenses --out dist/ExpenseTracker.apk "$B/aligned.apk"
apksigner verify --print-certs dist/ExpenseTracker.apk | head -2
ls -lh dist/ExpenseTracker.apk
