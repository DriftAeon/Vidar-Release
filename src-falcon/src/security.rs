use std::{ffi::c_void, mem::size_of, path::Path};

use windows::{
    core::{Error, PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE, HLOCAL,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
            TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

pub struct OwnedHandle(pub HANDLE);

unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

impl OwnedHandle {
    pub fn new(handle: HANDLE) -> Self {
        Self(handle)
    }

    pub fn handle(&self) -> HANDLE {
        self.0
    }
}

pub struct UserSecurity {
    descriptor: PSECURITY_DESCRIPTOR,
    attributes: SECURITY_ATTRIBUTES,
}

unsafe impl Send for UserSecurity {}
unsafe impl Sync for UserSecurity {}

impl UserSecurity {
    pub fn current_user() -> Result<Self, String> {
        let sid = current_user_sid()?;
        let sddl = format!("O:{sid}G:{sid}D:P(A;;GA;;;{sid})");
        let wide = wide(&sddl);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(wide.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
            .map_err(win_error)?;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        Ok(Self {
            descriptor,
            attributes,
        })
    }

    pub fn attributes(&self) -> *const SECURITY_ATTRIBUTES {
        &self.attributes
    }

    pub fn apply_to_path(&self, path: &Path) -> Result<(), String> {
        reject_reparse(path)?;
        let wide = wide_path(path)?;
        let info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
        let ok = unsafe { SetFileSecurityW(PCWSTR(wide.as_ptr()), info, self.descriptor) };
        ok.ok().map_err(win_error)
    }
}

impl Drop for UserSecurity {
    fn drop(&mut self) {
        if !self.descriptor.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
            }
        }
    }
}

pub fn reject_reparse(path: &Path) -> Result<(), String> {
    let wide = wide_path(path)?;
    let attributes = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
    if attributes == INVALID_FILE_ATTRIBUTES {
        return Err(format!(
            "cannot inspect {}: {}",
            path.display(),
            win_error(Error::from_win32())
        ));
    }
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == FILE_ATTRIBUTE_REPARSE_POINT.0 {
        return Err(format!("refusing reparse path {}", path.display()));
    }
    Ok(())
}

pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn wide_path(path: &Path) -> Result<Vec<u16>, String> {
    path.to_str()
        .map(wide)
        .ok_or_else(|| format!("path is not valid Unicode: {}", path.display()))
}

fn current_user_sid() -> Result<String, String> {
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(win_error)?;
    }
    let token = OwnedHandle(token);

    let mut needed = 0u32;
    let first = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut needed) };
    if first.is_ok() || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || needed == 0 {
        return Err(format!(
            "GetTokenInformation size failed: {}",
            win_error(Error::from_win32())
        ));
    }

    let mut buffer = vec![0u8; needed as usize];
    unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buffer.as_mut_ptr().cast::<c_void>()),
            needed,
            &mut needed,
        )
        .map_err(win_error)?;
    }
    let token_user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut sid_text = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(token_user.User.Sid, &mut sid_text).map_err(win_error)?;
    }
    let value = unsafe { sid_text.to_string().map_err(|error| error.to_string())? };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(sid_text.0.cast::<c_void>())));
    }
    Ok(value)
}

pub fn win_error(error: Error) -> String {
    format!("{} (0x{:08x})", error.message(), error.code().0 as u32)
}
