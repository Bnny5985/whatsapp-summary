//! Phone app for WhatsApp Summary.
//!
//! First launch: a Hebrew pairing screen (ui/index.html) scans the QR code shown on the computer and runs the one-time
//! pairing handshake over Iroh. After that the app opens straight into the computer's dashboard: a local proxy on
//! 127.0.0.1 (proxy.rs) carries every request over an Iroh QUIC connection (link.rs) to p2p-bridge on the computer.
//! The dashboard page itself never gets access to the app's commands: only the bundled pairing screen does.
// Public only so the integration tests (tests/) can drive the network layer without a WebView.
#[doc(hidden)]
pub mod link;
#[doc(hidden)]
pub mod proxy;
#[doc(hidden)]
pub mod store;

use std::sync::{Arc, OnceLock};

use serde_json::{Value, json};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

struct AppState {
    store: store::Store,
    endpoint: iroh::Endpoint,
    proxy: Arc<proxy::Proxy>,
    /// Where the bundled pairing screen lives (tauri://localhost/... or http://tauri.localhost/...).
    app_url: OnceLock<Url>,
}

type Shared = Arc<AppState>;

async fn start_link(state: &AppState, desktop: &store::Desktop) -> Result<(), String> {
    let link = link::Link::start(state.endpoint.clone(), desktop).map_err(|e| e.to_string())?;
    if let Some(old) = state.proxy.link.write().await.replace(link) {
        old.shutdown().await;
    }
    Ok(())
}

/// Called by the pairing screen on load: paired already? then where to go.
#[tauri::command]
async fn status(state: tauri::State<'_, Shared>) -> Result<Value, String> {
    let desktop = state.store.desktop();
    Ok(json!({
        "paired": desktop.is_some(),
        "url": desktop.map(|_| state.proxy.launch_url()),
        "mobile": cfg!(mobile),
    }))
}

/// `payload` is the QR code's text. Returns the address to open on success.
#[tauri::command]
async fn pair(state: tauri::State<'_, Shared>, payload: String, name: String) -> Result<String, String> {
    let desktop = link::pair(&state.endpoint, &payload, &name).await.map_err(|e| e.to_string())?;
    state.store.save_desktop(&desktop).map_err(|e| e.to_string())?;
    start_link(&state, &desktop).await?;
    Ok(state.proxy.launch_url())
}

/// "החלף מחשב / נתק חיבור": forget the computer and go back to the pairing screen.
fn unpair(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Shared>().inner().clone();
        let _ = state.store.forget_desktop();
        if let Some(link) = state.proxy.link.write().await.take() {
            link.shutdown().await;
        }
        if let (Some(win), Some(url)) = (app.get_webview_window("main"), state.app_url.get()) {
            let _ = win.navigate(url.clone());
        }
    });
}

/// Injected into every page. Acts only on the dashboard served by our proxy: adds the iOS/Android top safe area
/// and the "computer not available" banner with retry / switch-computer buttons.
fn overlay_script(origin: &str) -> String {
    include_str!("overlay.js").replace("__ORIGIN__", origin)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .invoke_handler(tauri::generate_handler![status, pair])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = store::Store::new(data_dir);
            let handle = app.handle().clone();
            let state = tauri::async_runtime::block_on(async {
                let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0).secret_key(store.key()?).bind().await?;
                let proxy = proxy::Proxy::start(store.proxy_port(), move || unpair(handle.clone())).await?;
                store.save_proxy_port(proxy.port);
                let state = Arc::new(AppState { store, endpoint, proxy, app_url: OnceLock::new() });
                if let Some(d) = state.store.desktop() {
                    let _ = start_link(&state, &d).await;
                }
                anyhow::Ok(state)
            })?;
            let origin = state.proxy.origin();
            let allowed_origin = origin.clone();
            app.manage(state.clone());

            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script(overlay_script(&origin))
                // Only the bundled screens and our own proxy; links to other sites don't open inside the app.
                .on_navigation(move |url| {
                    let o = url.origin().ascii_serialization();
                    o == allowed_origin || matches!(url.scheme(), "tauri" | "asset") || url.host_str() == Some("tauri.localhost")
                });
            #[cfg(desktop)]
            let builder = builder.title("סיכומי וואטסאפ").inner_size(430.0, 880.0);
            let win = builder.build()?;
            if let Ok(url) = win.url() {
                let _ = state.app_url.set(url);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|_app, _event| {
            // Back in the foreground: the network may have changed while the phone slept. Check the connection now.
            #[cfg(mobile)]
            if matches!(_event, tauri::RunEvent::Resumed | tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Resumed, .. }) {
                let state = _app.state::<Shared>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(link) = state.proxy.link.read().await.clone() {
                        link.probe().await;
                    }
                });
            }
        });
}
