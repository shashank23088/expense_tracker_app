package com.local.expensetracker;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;

/** Thin native shell: WebView UI from assets + file-backed storage + export. */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.parseColor("#2a78d6"));
        web = new WebView(this);
        web.setBackgroundColor(isNight() ? Color.parseColor("#111110") : Color.parseColor("#f4f4f1")); // no white flash in dark mode
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        // Lets the bundled page call a local LLM server without CORS setup. Only our own assets are ever loaded.
        s.setAllowUniversalAccessFromFileURLs(true);

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                Uri u = Uri.parse(url);
                if ("file".equals(u.getScheme())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // external links → browser
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(Intent.createChooser(i, "Choose backup"), PICK_FILE);
                return true;
            }
        });
        web.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK_FILE && fileCallback != null) {
            Uri[] r = (res == RESULT_OK && data != null && data.getData() != null) ? new Uri[]{data.getData()} : null;
            fileCallback.onReceiveValue(r);
            fileCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__onBack ? window.__onBack() : false", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if (!"true".equals(handled)) MainActivity.super.onBackPressed();
            }
        });
    }

    /** WebView's prefers-color-scheme follows the app theme (always light here), so JS asks this instead. */
    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        web.setBackgroundColor(isNight() ? Color.parseColor("#111110") : Color.parseColor("#f4f4f1"));
        web.evaluateJavascript("window.__onSystemTheme && window.__onSystemTheme()", null);
    }

    private File dataFile() { return new File(getFilesDir(), "data.json"); }

    private static String readAll(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), UTF8);
        } finally { in.close(); }
    }

    class Bridge {
        @JavascriptInterface
        public boolean isNightMode() { return isNight(); }

        @JavascriptInterface
        public String load() {
            try {
                File f = dataFile();
                if (f.exists()) return readAll(f);
                File bak = new File(getFilesDir(), "data.json.bak");
                return bak.exists() ? readAll(bak) : null;
            } catch (Exception e) { return null; }
        }

        /** Atomic write: tmp file → keep previous as .bak → rename. */
        @JavascriptInterface
        public synchronized boolean save(String json) {
            try {
                File dir = getFilesDir(), f = dataFile();
                File tmp = new File(dir, "data.json.tmp"), bak = new File(dir, "data.json.bak");
                FileOutputStream out = new FileOutputStream(tmp);
                try { out.write(json.getBytes(UTF8)); out.getFD().sync(); } finally { out.close(); }
                if (f.exists()) { bak.delete(); f.renameTo(bak); }
                return tmp.renameTo(f);
            } catch (Exception e) { return false; }
        }

        /** Save to public Downloads (Android 10+). Returns "ok" or an error; JS falls back to share. */
        @JavascriptInterface
        public String saveFile(String name, String mime, String text) {
            if (Build.VERSION.SDK_INT < 29) return "unsupported";
            try {
                ContentResolver cr = getContentResolver();
                ContentValues v = new ContentValues();
                v.put("_display_name", name);
                v.put("mime_type", mime);
                v.put("relative_path", "Download/");
                Uri uri = cr.insert(Uri.parse("content://media/external/downloads"), v);
                if (uri == null) return "insert failed";
                OutputStream out = cr.openOutputStream(uri);
                try { out.write(text.getBytes(UTF8)); } finally { out.close(); }
                return "ok";
            } catch (Exception e) { return "error: " + e.getMessage(); }
        }

        @JavascriptInterface
        public void share(final String title, final String text) {
            runOnUiThread(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_SUBJECT, title);
                    i.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(i, title));
                }
            });
        }
    }
}
