# Phone app (Android + iOS)

A thin [Tauri v2](https://v2.tauri.app) app. On first launch it shows a Hebrew pairing screen (`ui/index.html`) that
scans the QR code from the computer (Settings → גישה מהטלפון → צמד טלפון חדש). After that it opens straight into the
computer's dashboard.

```
WebView ──http──▶ 127.0.0.1:<port> (proxy.rs, on the phone) ══ Iroh QUIC, E2EE ══▶ p2p-bridge (computer) ──▶ web.js
```

| File | What |
|---|---|
| `ui/index.html` | pairing screen (RTL): QR scan, or paste the code when there is no camera |
| `src-tauri/src/lib.rs` | app setup, `status` / `pair` commands, foreground (`Resumed`) handling |
| `src-tauri/src/link.rs` | pairing handshake; one QUIC connection to the computer, reconnecting with backoff (1s to 30s) |
| `src-tauri/src/proxy.rs` | local proxy for the WebView: one QUIC stream per request, offline page, `/__wa/*` endpoints |
| `src-tauri/src/overlay.js` | injected into the dashboard page: top safe area + the "המחשב לא זמין כרגע" banner |
| `src-tauri/src/store.rs` | the phone's key and the paired computer, in the app's private data folder |

**Security.** The pairing screen is the only page that can call the app's commands. The dashboard page gets none:
the capabilities in `src-tauri/capabilities/` apply to the bundled screen, not to `http://127.0.0.1`. The local proxy
accepts only its own `Host`, plus a per-launch HttpOnly cookie that the WebView gets from `/__wa/auth?k=…`. Other apps
on the phone can reach 127.0.0.1, but they cannot use it. The cookie never leaves the phone. Links to other sites don't
open inside the app.

## Prerequisites

- Rust through [rustup](https://rustup.rs), not a system or Homebrew Rust, because the mobile targets come from rustup.
- The Tauri CLI: `cargo install tauri-cli --version "^2" --locked`.
- **Android:** Android Studio (SDK, Platform-Tools, **NDK**), a JDK (the one that comes with Android Studio works), and:
  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
  ```
  Set `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME` as described in the
  [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android).
- **iOS (macOS only):** full Xcode with an iOS platform installed (Xcode → Settings → Components), CocoaPods, and:
  ```bash
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
  ```

## Build and run

Run all of these from `mobile/src-tauri`.

```bash
cargo tauri android init
```

```bash
cargo tauri android dev
```

```bash
cargo tauri android build --apk
```

```bash
cargo tauri ios init
```

```bash
cargo tauri ios dev
```

```bash
cargo tauri ios build
```

After `android init`, one manual step: let the WebView load the dashboard from the app's own `http://127.0.0.1`.
Traffic to the computer is still end-to-end encrypted by Iroh. Copy the file
`android/network_security_config.xml` (next to this README) to `gen/android/app/src/main/res/xml/`, and in
`gen/android/app/src/main/AndroidManifest.xml` add this to `<application>`:
```xml
android:networkSecurityConfig="@xml/network_security_config"
```

On iOS, `src-tauri/Info.ios.plist` is merged automatically. It adds the camera message and `NSAllowsLocalNetworking`
(which allows the local http proxy).

## Run and test on a computer

The same code runs as a desktop app, which is handy for testing without a phone. There is no camera on desktop, so the
pairing screen offers "הדבק את הקוד" (paste the code) instead. To get the code's text, use the computer's
`POST /api/p2p/pair` → `qr`.

```bash
cargo run
```

```bash
cargo test
```

`cargo test` runs the whole network layer against the real bridge, so build `../../p2p-bridge` first. It covers pairing,
the cookie and `Host` checks, header rewriting, the offline page, reconnecting after the computer comes back,
revocation and unpairing.

## Builds in GitHub Actions

`.github/workflows/android.yml` builds a signed arm64 APK. On a `v*` tag it attaches the APK to that release. A manual
run with a tag builds `main` and attaches the APK to that existing release. Signing uses the repository secrets
`ANDROID_KEYSTORE_B64` (base64 PKCS12, alias `wasummary`) and `ANDROID_KEYSTORE_PASSWORD`. Keep a copy of that key
outside the repository: without it, a new version can't be installed over an old one. If the secrets are missing, the
run signs with a one-off key and shows a warning. `.github/workflows/mobile.yml` runs the tests and checks the iOS
build. An iOS build for testers (TestFlight) needs an Apple Developer account.

## Not verified yet

The desktop build has been run end to end against the real dashboard over Iroh, and the tests pass. The Android and
iOS builds (camera scanning, the `Resumed` event, the safe areas on a real notch) have not yet been run on a device or
simulator in this repository's CI.
