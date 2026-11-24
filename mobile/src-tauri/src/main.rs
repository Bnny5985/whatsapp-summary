// Desktop entry point (macOS/Windows/Linux), used to run and test the app on a computer.
// On iOS and Android the entry point is `run()` in lib.rs (tauri::mobile_entry_point).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    wa_summary_mobile_lib::run()
}
