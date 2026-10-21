//! Tray menu and summon entry point. Native messages distinguish user close from swap WM_CLOSE.
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::{tray_config::{parse_chord, WindowTrayCfg}, tray_native};

/// Tauri API only: it updates tao's VISIBLE flag, so a hidden window's show() is not a no-op.
fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let result = window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus());
        if let Err(error) = result {
            eprintln!("show Vidar: {error}");
        }
    }
}

/// Call on the window thread in setup, after main exists. A failed tray leaves close unchanged.
/// User close and tray Quit ignore close lock: it guards swap and agent closes, not the user's.
pub fn install(app: &AppHandle, cfg: WindowTrayCfg) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("tray requires the main window")?;
    if app.tray_by_id("vidar-window").is_some() {
        return Err("window tray is already installed".into());
    }
    // Bad chords do not disable the tray or change the default close behaviour.
    let chord = match parse_chord(&cfg.summon_hotkey) {
        Ok(chord) => chord,
        Err(error) => { eprintln!("summon hotkey: {error}"); None }
    };
    let show_item = MenuItem::with_id(app, "vidar-show", "Show Vidar", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(app, "vidar-quit", "Quit", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item]).map_err(|e| e.to_string())?;
    let icon = tauri::image::Image::new(include_bytes!("../icons/titlebar-32.rgba"), 32, 32);
    TrayIconBuilder::with_id("vidar-window")
        .icon(icon)
        .tooltip("Vidar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "vidar-show" => show(app),
            "vidar-quit" => {
                // Same WM_CLOSE path as swap: geometry save, bus drain and shutdown backstop.
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.close() {
                        eprintln!("quit Vidar: {error}");
                    }
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click {
                button: MouseButton::Left, button_state: MouseButtonState::Up, ..
            }) {
                show(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    // The subclass fires inside the window procedure; each action hops to a thread so the Tauri
    // call is proxied through the event loop instead of re-entering it mid-message.
    let hide_window = window.clone();
    let hide: tray_native::Action = Box::new(move || {
        let window = hide_window.clone();
        std::thread::spawn(move || {
            if let Err(error) = window.hide() {
                eprintln!("hide Vidar: {error}");
            }
        });
    });
    let summon_app = app.clone();
    let summon: tray_native::Action = Box::new(move || {
        let app = summon_app.clone();
        std::thread::spawn(move || show(&app));
    });
    let installed = window.hwnd().map_err(|e| e.to_string())
        .and_then(|hwnd| tray_native::install(hwnd, cfg.close_to_tray, chord, hide, summon));
    if let Err(error) = installed {
        app.remove_tray_by_id("vidar-window");
        return Err(error);
    }
    Ok(())
}
