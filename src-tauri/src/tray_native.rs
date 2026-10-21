//! Window-thread subclass: SC_CLOSE hides, direct WM_CLOSE (including swap) continues to Tauri.
//! Hide and summon run through callbacks into the Tauri window API: a raw ShowWindow would leave
//! tao's VISIBLE flag set, and tao's later show() would then skip the SW_SHOW as a no-op diff.
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{SC_CLOSE, WM_HOTKEY, WM_NCDESTROY, WM_SYSCOMMAND},
    },
};

const SUBCLASS_ID: usize = 0x56494441;
const HOTKEY_ID: i32 = 0xb1da;

/// Window actions the subclass triggers; supplied by `tray.rs` so tao's state stays in sync.
pub(crate) type Action = Box<dyn Fn()>;

struct Hook {
    close_to_tray: bool,
    hotkey_registered: bool,
    hide: Action,
    summon: Action,
}

pub(crate) fn install(hwnd: HWND, close_to_tray: bool, chord: Option<(u32, u32)>, hide: Action, summon: Action) -> Result<(), String> {
    let hook = Box::into_raw(Box::new(Hook { close_to_tray, hotkey_registered: false, hide, summon }));
    unsafe {
        if !SetWindowSubclass(hwnd, Some(callback), SUBCLASS_ID, hook as usize).as_bool() {
            drop(Box::from_raw(hook));
            return Err("cannot install window tray subclass".into());
        }
        if let Some((mods, key)) = chord {
            match RegisterHotKey(Some(hwnd), HOTKEY_ID, HOT_KEY_MODIFIERS(mods), key) {
                Ok(()) => (*hook).hotkey_registered = true,
                Err(error) => eprintln!("summon hotkey unavailable: {error}"),
            }
        }
    }
    Ok(())
}

unsafe extern "system" fn callback(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, id: usize, data: usize) -> LRESULT {
    let hook = data as *mut Hook;
    // User close always proceeds: close lock guards swap and agent closes, never the user's own.
    if message == WM_SYSCOMMAND && wparam.0 & 0xfff0 == SC_CLOSE as usize && (*hook).close_to_tray {
        // No CloseRequested event: the binary's shutdown backstop must not run on hide.
        ((*hook).hide)();
        return LRESULT(0);
    }
    if message == WM_HOTKEY && wparam.0 == HOTKEY_ID as usize && (*hook).hotkey_registered {
        ((*hook).summon)();
        return LRESULT(0);
    }
    if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(callback), id);
        let hook = Box::from_raw(hook);
        if hook.hotkey_registered {
            let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
        }
        drop(hook);
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};
    use windows::{core::w, Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, IsWindow, SendMessageW, WINDOW_EX_STYLE, WM_CLOSE, WS_OVERLAPPEDWINDOW,
    }};

    // Hidden native test window; no Vidar process, webview or global chord is launched.
    unsafe fn test_window(close_to_tray: bool) -> (HWND, Rc<Cell<u32>>) {
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), w!("Tray Close Test"),
            WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, None, None, None, None).unwrap();
        let hides = Rc::new(Cell::new(0));
        let counter = hides.clone();
        install(hwnd, close_to_tray, None, Box::new(move || counter.set(counter.get() + 1)), Box::new(|| {})).unwrap();
        (hwnd, hides)
    }

    #[test]
    fn tray_user_close_hides_but_swap_wm_close_destroys_hidden_window() {
        unsafe {
            let (hwnd, hides) = test_window(true);
            SendMessageW(hwnd, WM_SYSCOMMAND, Some(WPARAM(SC_CLOSE as usize | 3)), Some(LPARAM(0)));
            assert!(IsWindow(Some(hwnd)).as_bool());
            assert_eq!(hides.get(), 1, "user close routes through the hide action");
            SendMessageW(hwnd, WM_CLOSE, None, None);
            assert!(!IsWindow(Some(hwnd)).as_bool());
        }
    }

    #[test]
    fn tray_default_close_destroys_window() {
        unsafe {
            let (hwnd, hides) = test_window(false);
            SendMessageW(hwnd, WM_SYSCOMMAND, Some(WPARAM(SC_CLOSE as usize)), None);
            assert!(!IsWindow(Some(hwnd)).as_bool());
            assert_eq!(hides.get(), 0);
        }
    }
}
