// The native Windows pickers (IFileOpenDialog), owned by the main window so they are modal to
// Vidar. Folder mode (FOS_PICKFOLDERS): the launcher's Select Workspace row and the Browse
// button on Settings › Workspaces. File mode (`.glb` only): Settings › Characters, where Rust
// owns the pick so the webview never nominates a model path.
// Cancel is Ok(None), not an error.

use windows::core::{w, HSTRING, PWSTR};
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, FOS_FILEMUSTEXIST,
    FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
};

#[derive(Clone, Copy)]
enum Mode {
    Folder,
    Glb,
}

/// `start` pre-selects a folder when it exists (Browse on an existing workspace).
#[tauri::command]
pub async fn pick_folder(window: tauri::WebviewWindow, title: Option<String>, start: Option<String>) -> Result<Option<String>, String> {
    run(window, Mode::Folder, title.unwrap_or_else(|| "Select Workspace".into()), start).await
}

/// The `.glb` file sibling of `pick_folder`. Not a command: only the character pack store
/// calls it, so the chosen path goes straight from the dialog to the pin and never through
/// the webview. `start` is a folder or a file whose folder the dialog opens in.
pub(crate) async fn pick_glb(window: &tauri::WebviewWindow, title: &str, start: Option<String>) -> Result<Option<String>, String> {
    run(window.clone(), Mode::Glb, title.to_string(), start).await
}

async fn run(window: tauri::WebviewWindow, mode: Mode, title: String, start: Option<String>) -> Result<Option<String>, String> {
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    // A modal dialog blocks its thread and needs an STA: never on the async pool itself.
    tauri::async_runtime::spawn_blocking(move || pick(owner, mode, title, start))
        .await
        .map_err(|e| e.to_string())?
}

fn pick(owner: isize, mode: Mode, title: String, start: Option<String>) -> Result<Option<String>, String> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let out = show(owner, mode, &title, start);
        if init.is_ok() {
            CoUninitialize();
        }
        out
    }
}

unsafe fn show(owner: isize, mode: Mode, title: &str, start: Option<String>) -> Result<Option<String>, String> {
    let e = |e: windows::core::Error| e.to_string();
    let dlg: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(e)?;
    let opts = dlg.GetOptions().map_err(e)?;
    match mode {
        Mode::Folder => dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM).map_err(e)?,
        Mode::Glb => {
            dlg.SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST).map_err(e)?;
            let filters = [COMDLG_FILTERSPEC { pszName: w!("GLB Models"), pszSpec: w!("*.glb") }];
            dlg.SetFileTypes(&filters).map_err(e)?;
            dlg.SetDefaultExtension(w!("glb")).map_err(e)?;
        }
    }
    dlg.SetTitle(&HSTRING::from(title)).map_err(e)?;
    let start_dir = start.map(std::path::PathBuf::from).and_then(|p| {
        if p.is_dir() {
            Some(p)
        } else if matches!(mode, Mode::Glb) {
            p.parent().filter(|d| d.is_dir()).map(|d| d.to_path_buf())
        } else {
            None
        }
    });
    if let Some(dir) = start_dir {
        if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(dir.as_os_str()), None) {
            let _ = dlg.SetFolder(&item);
        }
    }
    if let Err(err) = dlg.Show(Some(HWND(owner as *mut _))) {
        if err.code() == ERROR_CANCELLED.to_hresult() {
            return Ok(None);
        }
        return Err(err.to_string());
    }
    let item = dlg.GetResult().map_err(e)?;
    let name: PWSTR = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(e)?;
    let path = name.to_string().map_err(|e| e.to_string());
    CoTaskMemFree(Some(name.0 as *const _));
    path.map(Some)
}
