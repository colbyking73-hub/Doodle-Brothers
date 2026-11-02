package com.colbyking.doodlebrothers;

// DOODLE BROTHERS for Android: one full-screen WebView running the same game files as the PC version.
//  - Controllers are read HERE (Android's own controller events) and handed to the game as JSON every frame
//    (AndroidBridge.pads()), so any Bluetooth controller works no matter what the phone's WebView supports.
//  - The game files come from the APK (assets/www), but QUICK UPDATES (android.js downloads the changed files into
//    the app's storage, "game/") override them. Installing a new APK clears those (they were for the old one).
//  - Every page load of index.html gets android.js put in at the top (it hooks the game's update screen up to
//    the quick updates, and tells the game it's on Android).

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

public class MainActivity extends Activity {
    private WebView web;
    private File overlay;
    private final Pads pads = new Pads();

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {                              // draw right up to (and round) the camera cut-out too
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        overlay = new File(getFilesDir(), "game");
        // a NEW APK: the quick updates downloaded for the old one are thrown away
        long vc = versionCode();
        SharedPreferences prefs = getSharedPreferences("doodle", MODE_PRIVATE);
        if (prefs.getLong("versionCode", -1) != vc) {
            deleteAll(overlay);
            prefs.edit().putLong("versionCode", vc).apply();
        }
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder().addPathHandler("/", new GameFiles()).build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);
        web.loadUrl("https://appassets.androidplatform.net/index.html");
        hideSystemBars();
    }

    // ---------- the game files: a quick update's copy if there is one, otherwise the APK's ----------
    private class GameFiles implements WebViewAssetLoader.PathHandler {
        @Override
        public WebResourceResponse handle(String path) {
            if (path == null || path.isEmpty()) path = "index.html";
            path = path.replace("\\", "/");
            if (path.contains("..")) return null;
            try {
                File f = new File(overlay, path);
                InputStream in = f.isFile() ? new FileInputStream(f) : getAssets().open("www/" + path);
                if (path.equals("index.html")) {                       // android.js goes in first, every time
                    String html = new String(readAll(in), StandardCharsets.UTF_8);
                    int at = html.indexOf("<head>");
                    String tag = "<script src=\"android.js\"></script>";
                    html = at >= 0 ? html.substring(0, at + 6) + tag + html.substring(at + 6) : tag + html;
                    in = new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8));
                }
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-cache");
                headers.put("Access-Control-Allow-Origin", "*");
                return new WebResourceResponse(mime(path), mime(path).startsWith("text") || path.endsWith(".js") || path.endsWith(".json") ? "utf-8" : null,
                        200, "OK", headers, in);
            } catch (Exception e) {
                return null;
            }
        }
    }

    private static String mime(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".css")) return "text/css";
        return "application/octet-stream";
    }

    // ---------- what the game can ask Android for ----------
    private class Bridge {
        @JavascriptInterface public String pads() { return pads.json(); }
        @JavascriptInterface public String info() {
            return "{\"versionName\":\"" + versionName() + "\",\"versionCode\":" + versionCode() + "}";
        }
        // a quick update: each new game file (base64) is saved into a STAGING folder first...
        @JavascriptInterface public boolean writeFile(String rel, String b64) {
            if (rel == null || rel.contains("..")) return false;
            try {
                File f = new File(staging(), rel);
                File dir = f.getParentFile();
                if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return false;
                FileOutputStream out = new FileOutputStream(f);
                out.write(Base64.decode(b64, Base64.DEFAULT));
                out.close();
                return true;
            } catch (Exception e) {
                return false;
            }
        }
        // ...and only once every file is in (and checked) do they all move over at once - a half-finished
        // download can never leave the game with a mix of old and new files
        @JavascriptInterface public boolean commitUpdate() {
            try { moveAll(staging(), overlay); deleteAll(staging()); return true; } catch (Exception e) { return false; }
        }
        @JavascriptInterface public void clearStaged() { deleteAll(staging()); }
        @JavascriptInterface public void clearUpdates() { deleteAll(overlay); deleteAll(staging()); }
        @JavascriptInterface public void openUrl(String url) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
        }
        @JavascriptInterface public void reload() { runOnUiThread(() -> web.reload()); }
    }

    // ---------- CONTROLLERS ----------
    // Each controller (Android "input device") gets a small number, in the order they're first seen, and the game
    // gets its buttons in the standard layout and its two sticks.
    private static class Pad {
        final String name;
        final float[] buttons = new float[17];
        final float[] axes = new float[4];
        float hatX, hatY;
        boolean hatUsed;
        Pad(String n) { name = n; }
    }
    private static class Pads {
        private final LinkedHashMap<Integer, Pad> byDevice = new LinkedHashMap<>();
        private final HashMap<Integer, Integer> index = new HashMap<>();
        private int next = 0;

        synchronized Pad get(InputDevice d) {
            int id = d.getId();
            Pad p = byDevice.get(id);
            if (p == null) {
                p = new Pad(d.getName());
                byDevice.put(id, p);
                int i = 0;                                              // smallest free number
                while (index.containsValue(i)) i++;
                index.put(id, i);
            }
            return p;
        }

        synchronized String json() {
            // controllers that have gone away are dropped
            for (Integer id : byDevice.keySet().toArray(new Integer[0])) {
                if (InputDevice.getDevice(id) == null) { byDevice.remove(id); index.remove(id); }
            }
            StringBuilder b = new StringBuilder("[");
            boolean first = true;
            for (Map.Entry<Integer, Pad> e : byDevice.entrySet()) {
                Pad p = e.getValue();
                if (!first) b.append(',');
                first = false;
                b.append("{\"index\":").append(index.get(e.getKey()))
                 .append(",\"id\":\"").append(p.name.replace("\\", "").replace("\"", "'")).append("\",\"buttons\":[");
                for (int k = 0; k < p.buttons.length; k++) { if (k > 0) b.append(','); b.append(p.buttons[k]); }
                b.append("],\"axes\":[");
                for (int k = 0; k < p.axes.length; k++) { if (k > 0) b.append(','); b.append(p.axes[k]); }
                b.append("]}");
            }
            return b.append(']').toString();
        }

        static int button(int code) {
            switch (code) {
                case KeyEvent.KEYCODE_BUTTON_A: return 0;
                case KeyEvent.KEYCODE_BUTTON_B: return 1;
                case KeyEvent.KEYCODE_BUTTON_X: return 2;
                case KeyEvent.KEYCODE_BUTTON_Y: return 3;
                case KeyEvent.KEYCODE_BUTTON_L1: return 4;
                case KeyEvent.KEYCODE_BUTTON_R1: return 5;
                case KeyEvent.KEYCODE_BUTTON_L2: return 6;
                case KeyEvent.KEYCODE_BUTTON_R2: return 7;
                case KeyEvent.KEYCODE_BUTTON_SELECT: case KeyEvent.KEYCODE_BACK: return 8;
                case KeyEvent.KEYCODE_BUTTON_START: case KeyEvent.KEYCODE_MENU: return 9;
                case KeyEvent.KEYCODE_BUTTON_THUMBL: return 10;
                case KeyEvent.KEYCODE_BUTTON_THUMBR: return 11;
                case KeyEvent.KEYCODE_DPAD_UP: return 12;
                case KeyEvent.KEYCODE_DPAD_DOWN: return 13;
                case KeyEvent.KEYCODE_DPAD_LEFT: return 14;
                case KeyEvent.KEYCODE_DPAD_RIGHT: return 15;
                case KeyEvent.KEYCODE_BUTTON_MODE: case KeyEvent.KEYCODE_HOME: return 16;
                default: return -1;
            }
        }
        synchronized boolean key(KeyEvent e) {
            int b = button(e.getKeyCode());
            if (b < 0 || e.getDevice() == null) return false;
            Pad p = get(e.getDevice());
            if (e.getAction() == KeyEvent.ACTION_DOWN) p.buttons[b] = 1f;
            else if (e.getAction() == KeyEvent.ACTION_UP) p.buttons[b] = 0f;
            return true;
        }
        private static float axis(MotionEvent e, InputDevice d, int a) {
            InputDevice.MotionRange r = d.getMotionRange(a, e.getSource());
            if (r == null) return 0f;
            float v = e.getAxisValue(a);
            return Math.abs(v) > r.getFlat() ? v : 0f;
        }
        synchronized void motion(MotionEvent e) {
            InputDevice d = e.getDevice();
            if (d == null) return;
            Pad p = get(d);
            p.axes[0] = axis(e, d, MotionEvent.AXIS_X);
            p.axes[1] = axis(e, d, MotionEvent.AXIS_Y);
            // the right stick: Z / RZ on most controllers, RX / RY on some
            boolean zrz = d.getMotionRange(MotionEvent.AXIS_Z, e.getSource()) != null && d.getMotionRange(MotionEvent.AXIS_RZ, e.getSource()) != null;
            p.axes[2] = axis(e, d, zrz ? MotionEvent.AXIS_Z : MotionEvent.AXIS_RX);
            p.axes[3] = axis(e, d, zrz ? MotionEvent.AXIS_RZ : MotionEvent.AXIS_RY);
            // analog triggers = ZL / ZR (LT / RT)
            float lt = Math.max(axis(e, d, MotionEvent.AXIS_LTRIGGER), axis(e, d, MotionEvent.AXIS_BRAKE));
            float rt = Math.max(axis(e, d, MotionEvent.AXIS_RTRIGGER), axis(e, d, MotionEvent.AXIS_GAS));
            if (d.getMotionRange(MotionEvent.AXIS_LTRIGGER, e.getSource()) != null || d.getMotionRange(MotionEvent.AXIS_BRAKE, e.getSource()) != null) p.buttons[6] = lt;
            if (d.getMotionRange(MotionEvent.AXIS_RTRIGGER, e.getSource()) != null || d.getMotionRange(MotionEvent.AXIS_GAS, e.getSource()) != null) p.buttons[7] = rt;
            // a D-pad "hat" (some controllers send the D-pad this way instead of as buttons)
            if (d.getMotionRange(MotionEvent.AXIS_HAT_X, e.getSource()) != null) {
                float hx = e.getAxisValue(MotionEvent.AXIS_HAT_X), hy = e.getAxisValue(MotionEvent.AXIS_HAT_Y);
                if (hx != 0 || hy != 0 || p.hatUsed) {
                    p.hatUsed = true;
                    p.buttons[12] = hy < -0.5f ? 1f : 0f; p.buttons[13] = hy > 0.5f ? 1f : 0f;
                    p.buttons[14] = hx < -0.5f ? 1f : 0f; p.buttons[15] = hx > 0.5f ? 1f : 0f;
                }
            }
        }
    }

    private static boolean isController(InputDevice d) {
        if (d == null || d.isVirtual()) return false;
        int s = d.getSources();
        return (s & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD || (s & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (isController(e.getDevice()) && pads.key(e)) return true;   // (a controller's buttons are the game's - never "back")
        return super.dispatchKeyEvent(e);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent e) {
        if (isController(e.getDevice()) && (e.getSource() & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
                && e.getAction() == MotionEvent.ACTION_MOVE) { pads.motion(e); return true; }
        return super.dispatchGenericMotionEvent(e);
    }

    // ---------- full screen, landscape, awake ----------
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
    @Override public void onWindowFocusChanged(boolean has) { super.onWindowFocusChanged(has); if (has) hideSystemBars(); }
    @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); hideSystemBars(); }
    @Override public void onBackPressed() { /* (the phone's back button doesn't close the game by accident) */ }

    // ---------- bits ----------
    @SuppressWarnings("deprecation")
    private long versionCode() {
        try {
            PackageInfo i = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? i.getLongVersionCode() : i.versionCode;
        } catch (Exception e) { return 0; }
    }
    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }
    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }
    private File staging() { return new File(getFilesDir(), "game-next"); }
    private static void moveAll(File from, File to) throws java.io.IOException {
        File[] kids = from.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            File dest = new File(to, k.getName());
            if (k.isDirectory()) { if (!dest.isDirectory() && !dest.mkdirs()) throw new java.io.IOException("mkdir " + dest); moveAll(k, dest); }
            else {
                File parent = dest.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new java.io.IOException("mkdir " + parent);
                if (dest.exists() && !dest.delete()) throw new java.io.IOException("delete " + dest);
                if (!k.renameTo(dest)) throw new java.io.IOException("move " + k);
            }
        }
    }
    private static void deleteAll(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteAll(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
