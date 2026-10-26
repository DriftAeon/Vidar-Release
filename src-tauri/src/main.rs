#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod bare;
mod bang;
mod bridge;
#[cfg(test)]
mod bridge_golden;
mod build_guard;
mod build_stamp;
mod caption;
mod changes;
mod changes_p4;
mod characters;
mod chrome;
mod codex_config;
mod codex_cwd;
mod codex_models;
mod codex_threads;
mod claude_auth;
mod claude_login;
mod claude_version;
mod config;
mod control;
mod credman;
mod deps;
mod driver_mode;
mod dispatch_bridge;
mod editor;
mod falcon;
mod flow;
mod flow_output;
mod flow_store;
mod folder_pick;
mod fsx;
mod gitreview;
mod gitrun;
mod jira;
mod job;
mod lab;
mod listen;
mod listen_sidecar;
mod lmstudio;
mod loadout;
mod mcp;
mod modules;
mod net;
mod notion;
mod open;
mod paths;
mod ocr;
mod colour_sample;
mod proc_job;
mod procs;
mod pty;
mod recent_meta;
mod release_build;
mod release_check;
mod review;
mod rules;
mod runlog;
mod settings;
mod slack;
mod state;
mod speak;
mod stages;
mod status;
mod stt_warm;
mod swap_button;
mod tray;
mod tray_config;
mod tray_native;
mod unreal;
mod vidar_worktree;
mod usage_ledger;
mod voice;
mod voice_slots;
mod which;
mod winreg_env;

use tauri::Manager;

/// The one startup failure the user has to see. Release/fast builds run
/// with `windows_subsystem = "windows"`, so stderr alone is invisible there.
fn fatal_box(msg: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    eprintln!("{msg}");
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let body = wide(&format!("{msg}\n\nRun vidar.exe from the Vidar folder, next to tools\\."));
    let title = wide("Vidar Can't Find Its Folder");
    unsafe {
        MessageBoxW(None, PCWSTR(body.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR);
    }
}

fn dev_refused_box() {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let msg = "This exe was built without tauri/custom-protocol, so it would load its UI from the dev server. Rebuild with the release scripts, or set VIDAR_DEV_RUN=1 to run it on purpose.";
    eprintln!("{msg}");
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let body = wide(msg);
    let title = wide("Dev Build Refused");
    unsafe {
        MessageBoxW(None, PCWSTR(body.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR);
    }
}

fn main() {
    build_guard::keep_marker();
    if build_guard::dev_run_refused(
        tauri::is_dev(),
        cfg!(debug_assertions),
        std::env::var("VIDAR_DEV_RUN").ok().as_deref(),
    ) {
        dev_refused_box();
        std::process::exit(1);
    }
    if let Err(msg) = paths::init() {
        fatal_box(&msg);
        std::process::exit(1);
    }
    runlog::init(&paths::agent_log_dir(), "vidar");
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(pty::PtyManager::default())
        .manage(agent::AgentManager::default())
        .manage(voice::VoiceState::default())
        .manage(listen::ListenState::default())
        .manage(state::WinTracker::default())
        .manage(review::ReviewState::default())
        .manage(std::sync::Arc::new(falcon::Falcon::new(paths::root())))
        .manage(open::OpenState::default())
        .manage(control::ControlState::default())
        .manage(control::card::CardState::default())
        .manage(control::policy::PolicyState::default())
        .manage(speak::SpeakState::default())
        .manage(flow::FlowManager::default())
        .invoke_handler(tauri::generate_handler![
            deps::detect_dependencies,
            deps::updates::check_cli_updates,
            deps::updates::update_cli,
            deps::updates::skew::codex_skew,
            modules::modules_list,
            modules::module_art,
            modules::module_trust_current,
            pty::spawn_pty,
            pty::write_pty,
            pty::pty_has_descendant,
            review::review_ready,
            review::review_result,
            open::open_ready,
            open::open_result,
            control::control_result,
            control::pending_ask::list_pending_asks,
            control::pending_ask::claim_pending_ask,
            control::pending_ask::release_pending_ask,
            control::pending_ask::settle_pending_ask,
            pty::resize_pty,
            pty::pty_flow,
            pty::kill_pty,
            pty::adopt_session,
            agent::spawn_codex_appserver,
            codex_models::codex_list_models,
            rules::rules_prepare,
            rules::catalog::runes_catalog,
            rules::loaded::runes_loaded,
            rules::load_history::runes_load_history,
            rules::import::commands::rules_import_sources,
            rules::import::commands::rules_import_scan,
            rules::import::commands::rules_import_apply,
            rules::generate::commands::rules_generate,
            rules::generate::commands::rules_generate_cancel,
            rules::import::local::bare_local_sources,
            bare::item_import::bare_items_import,
            bare::bundles::bare_module_bundles,
            rules::fork::bare_set_fork,
            bare::kit::bare_kit_create,
            bare::kit::bare_kit_item_create,
            bare::kit::bare_library_files,
            bare::sets_list::bare_sets_list,
            bare::manifest::bare_launch,
            bare::vault::rune_vault_list,
            bare::vault::rune_vault_read,
            bare::vault::rune_vault_create,
            bare::vault::rune_vault_edit,
            bare::vault::rune_vault_lock,
            bare::vault::rune_vault_session,
            bare::vault::rune_vault_defaults,
            bare::vault::rune_vault_default_set,
            bare::vault::rune_vault_session_move,
            bare::vault::rune_vault_library_runes,
            lab::lab_item,
            agent::agent_send,
            agent::kill_agent,
            bare::codex_trust::codex_trust_offer,
            bare::codex_trust::codex_trust_folder,
            vidar_worktree::vidar_worktree_open,
            agent::agent_reap_all,
            codex_threads::list_codex_threads,
            status::list_external_sessions,
            status::list_recent_sessions,
            recent_meta::read_session_meta,
            status::read_codex_model,
            status::read_codex_limits,
            status::codex_rollout_threads,
            status::status_snapshot,
            chrome::open_folder,
            folder_pick::pick_folder,
            chrome::open_document,
            chrome::open_in_browser,
            claude_version::claude_installed_version,
            claude_auth::claude_auth_status,
            claude_auth::claude_auth_status_bare,
            claude_login::claude_login_run,
            claude_login::claude_login_cancel,
            gitreview::review_workspace,
            changes::changes_status,
            changes_p4::changes_p4_status,
            changes::changes_act,
            changes::changes_commit,
            changes::changes_sync,
            changes::changes_rename_branch,
            unreal::unreal_status,
            jira::commands::jira_status,
            jira::commands::jira_connect,
            jira::commands::jira_disconnect,
            jira::commands::jira_issues,
            jira::commands::jira_types,
            jira::commands::jira_projects,
            jira::commands::jira_issue,
            jira::commands::jira_comments,
            notion::commands::notion_status,
            notion::commands::notion_connect,
            notion::commands::notion_disconnect,
            notion::commands::notion_search,
            notion::commands::notion_source,
            notion::commands::notion_query,
            notion::commands::notion_page,
            notion::commands::notion_blocks,
            slack::commands::slack_status,
            slack::commands::slack_connect,
            slack::commands::slack_disconnect,
            slack::commands::slack_inbox,
            bang::bang_run,
            bridge::save_clip,
            bridge::write_workbench_entry,
            bridge::delete_workbench_entry,
            bridge::archive_workbench_entry,
            bridge::list_workbench_entries,
            bridge::write_workbench_png,
            bridge::read_workbench_png,
            bridge::save_clip_image,
            bridge::read_drop_text,
            bridge::read_drop_png,
            bridge::read_character_model,
            characters::list_characters,
            characters::add_character,
            characters::repin_character,
            characters::update_character,
            characters::remove_character,
            characters::set_default_character,
            stages::list_stages,
            stages::read_stage_asset,
            bridge::list_documents,
            bridge::read_document,
            bridge::stat_document,
            bridge::create_document,
            bridge::write_document,
            bridge::read_comments,
            bridge::save_comments,
            bridge::read_display_file,
            bridge::read_display_png,
            bridge::list_display,
            bridge::save_display_decision,
            bridge::read_display_decision,
            bridge::archive_display_file,
            bridge::delete_display_file,
            chrome::set_caption_color,
            caption::caption_metrics,
            chrome::open_url,
            build_stamp::build_stamp,
            release_check::check_release,
            config::read_config,
            config::read_default_cwd,
            codex_cwd::codex_cwd_refused,
            config::save_locations,
            config::save_shortcuts,
            config::save_voice,
            config::save_character_view,
            settings::switches::read_switch,
            settings::switches::set_switch,
            swap_button::swap_pending,
            swap_button::swap_state,
            swap_button::swap_start,
            release_build::release_build_catalog,
            release_build::release_build_start,
            release_build::release_build_cancel,
            release_build::release_build_state,
            settings::commands::patch_settings,
            settings::commands::reload_config,
            settings::state::read_state,
            settings::state::patch_state,
            editor::open_in_editor,
            falcon::falcon_available,
            falcon::falcon_spawn,
            falcon::falcon_send,
            falcon::falcon_kill,
            falcon::falcon_list,
            falcon::falcon_adopt,
            falcon::falcon_detach,
            falcon::falcon_retract,
            falcon::falcon_steer,
            falcon::falcon_show,
            falcon::falcon_hosted_session,
            falcon::falcon_hosted_held,
            driver_mode::driver_mode_get,
            driver_mode::driver_mode_set,
            falcon::falcon_handoff_write,
            falcon::falcon_handoff_peek,
            falcon::falcon_handoff_clear,
            loadout::read_loadout,
            loadout::codex::read_codex_loadout,
            loadout::file_kb,
            mcp::read_mcp_servers,
            mcp::codex::read_codex_mcp_servers,
            mcp::list_mcp_tools,
            mcp::list_mcp_tools_stdio,
            mcp::proxy_status,
            lmstudio::lmstudio_status,
            ocr::ocr_begin,
            ocr::ocr_cancel,
            ocr::ocr_capture,
            colour_sample::colour_sample,
            voice::voice_devices,
            voice::voice_register,
            voice::voice_start,
            voice::voice_stop,
            speak::speak_last,
            speak::speak_stop,
            speak::speak_arm,
            speak::speak_status,
            speak::speak_off,
            listen::listen_start,
            listen::listen_stop,
            listen::listen_status,
            listen::listen_delivered,
            stt_warm::stt_warm_status,
            voice_slots::voice_slots_status,
            voice_slots::voice_slots_status_one,
            voice_slots::voice_slots_trust,
            voice_slots::write::voice_slots_pick,
            config::save_wakeword,
            flow::flow_run_node,
            flow::permission::flow_permission_modes,
            flow::flow_answer_permission,
            flow::flow_cancel_node,
            flow::flow_cancel_run,
            flow_store::flow_store_open,
            flow_store::flow_store_write,
            flow_output::flow_output_read
        ])
        .on_window_event(|window, event| {
            // Main window only. Auxiliary windows (the marquee overlay) must
            // not feed the geometry tracker — the overlay is set to the whole
            // virtual screen, and that rect was getting saved as Vidar's.
            if window.label() != "main" {
                return;
            }
            // OS file drops: Rust-side proof for Document (documents.rs `note_dropped`).
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                bridge::note_dropped(paths);
            }
            let tracker = window.app_handle().state::<state::WinTracker>();
            state::on_window_event(window, event, &tracker);
            // Main gone = Vidar gone. Tauri only exits when the LAST window
            // closes, so any auxiliary window (the marquee overlay) left a
            // process alive with no UI, and the next launch collided with it.
            // The overlay is also an OWNED window (ocr.rs) so Windows destroys
            // it with main; this is the backstop. Off-thread on purpose:
            // driving windows from inside this callback can deadlock the loop.
            //
            // With the marquee overlay open, closing main
            // deadlocks the event loop somewhere in the two-window teardown
            // (process stays alive, not responding, next launch collides on the
            // WebView2 profile). Asking Tauri nicely (close the others, exit on
            // Destroyed) did not survive that. So: state is already on disk
            // from CloseRequested above; give the loop a moment to exit
            // cleanly, then end the process ourselves. ConPTY children die
            // with us; WebView2 tolerates host death.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Stamped into vidar.log (runlog redirects stderr): pairs with swap-release's
                // "WM_CLOSE posted" line to show whether a slow close was a blocked loop
                // or an ask that never arrived.
                eprintln!("close requested at {}", runlog::utc_stamp());
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    // Answer every parked `ctl.*` request `err bus gone` before
                    // exiting (Falcon outlives us; its clients would otherwise run
                    // to their own timeouts). Own thread, bounded: a stuck publish
                    // must not hold the close. Not in `RunEvent::Exit`, which races
                    // the hard exit below.
                    let (done_tx, done_rx) = std::sync::mpsc::channel();
                    let drain_app = app.clone();
                    std::thread::spawn(move || {
                        control::drain_pending(&drain_app, "bus gone");
                        let _ = done_tx.send(());
                    });
                    let _ = done_rx.recv_timeout(std::time::Duration::from_millis(300));
                    app.exit(0);
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    std::process::exit(0);
                });
            }
        })
        .setup(|app| {
            let handle = app.app_handle().clone();
            // Before any window or launch: Bare rows and the retired home-wide lists become Rune
            // Vaults; vidar.json last (run 2026-10-25-rune-vault, L4c).
            bare::vault::migrate::run_at_startup();
            bridge::ensure_dirs();
            bridge::sweep_review_artefacts();
            bridge::purge_workbench_archive();
            status::reset_dir();
            review::quarantine_stale();
            open::quarantine_stale();
            status::start_status_poller(handle.clone());
            bridge::start_display_poller(handle.clone());
            open::start_dispatch_poller(handle.clone());
            review::start_dispatch_poller(handle.clone());
            // Started unconditionally: asks must always reach the card, so a
            // subscribed Vidar pins the Falcon host for its lifetime.
            let bus_handle = handle.clone();
            let falcon_bus = handle.state::<std::sync::Arc<falcon::Falcon>>().inner().clone();
            falcon_bus.bus_subscribe(vec!["ask.open".to_string(), control::TOPIC.to_string()], move |frame| {
                let topic = frame.get("topic").and_then(serde_json::Value::as_str).unwrap_or("");
                if topic.starts_with("ctl.") {
                    control::route(&bus_handle, &frame);
                } else {
                    open::handle_bus_ask(&bus_handle, &frame);
                }
            });
            // The main window is described in tauri.conf.json but built here
            // (`create: false`): enable_clipboard_access() makes wry grant
            // CLIPBOARD_READ in its PermissionRequested handler, so the Ctrl+V
            // text paste (sessions/terminal-body.ts) never raises WebView2's allow/block prompt.
            let main_cfg = app.config().app.windows.iter()
                .find(|w| w.label == "main").cloned()
                .expect("tauri.conf.json: no window labelled main");
            // The stored theme, injected before first paint as
            // `window.__vidarPrepaintTheme`, which index.html's pre-paint
            // inline script reads (it no longer reads localStorage); theme.ts
            // corrects it from the state file after boot, since a webview
            // reload re-injects this startup value. Any read/parse failure
            // (including a fresh install, NotFound = {}) leaves this `null` —
            // same as "no theme saved".
            let prepaint_theme = settings::state::load()
                .ok()
                .and_then(|v| v.get("theme").cloned())
                .unwrap_or(serde_json::Value::Null);
            let prepaint_script = format!(
                "window.__vidarPrepaintTheme = {};",
                serde_json::to_string(&prepaint_theme).unwrap_or_else(|_| "null".into())
            );
            // `--no-activate` (swap-release.ps1 -Background): focused(false)
            // makes tao's show use SW_SHOWNOACTIVATE and skips wry's initial
            // WebView2 MoveFocus, so the launch never takes the foreground.
            let no_activate = state::no_activate();
            let mut main_builder = tauri::WebviewWindowBuilder::from_config(app, &main_cfg)?
                .enable_clipboard_access()
                .initialization_script(&prepaint_script);
            if no_activate {
                main_builder = main_builder.focused(false);
            }
            main_builder.build()?;
            if let Some(win) = app.get_webview_window("main") {
                chrome::set_titlebar_icon(&win);
                state::restore(&win, no_activate);
                // After restore: its outer-minus-inner chrome is measured on the native frame.
                caption::install(&win);
            }
            // After main exists: a failed tray leaves close behaviour unchanged.
            if let Err(error) = tray::install(&handle, config::load().config.window) {
                eprintln!("window tray: {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building vidar")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(falcon) = app_handle.try_state::<std::sync::Arc<falcon::Falcon>>() {
                    falcon.stop_bus_subscribe();
                }
            }
        });
}
