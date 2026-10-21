//! A generic Windows Credential Manager entry (docs/projects/notion/plan.md § Shared Rust):
//! `CRED_TYPE_GENERIC`, target `<prefix><install-root key>` (the key Bare homes use, so installs
//! and sandbox roots stay apart), `CRED_PERSIST_LOCAL_MACHINE` (does not roam). No
//! source-specific validators: each source validates before `write`. The blob is read into a
//! `Secret` at once and never formatted; errors and log lines carry codes only. Jira
//! (`jira/vault.rs`), Notion and Slack store through it.
//!
//! The blob is wrapped with `CryptProtectData` (no UI; entropy = a fixed label plus the
//! install-root key) and stored as `dpapi1:` + base64. This only stops generic credential
//! harvesters that dump plain generic credentials: any process running as this user can still
//! call `CryptUnprotectData` with the same entropy and read the token.
//!
//! Reading: a `dpapi1:` value unwraps; one that fails to unwrap (for example after an admin
//! password reset) reads as logged out, with a log line. A legacy plaintext value is returned as
//! it is and rewrapped in place; a failed rewrap keeps the plaintext (logged), never the token
//! lost. An older build cannot read a wrapped value: it hands the `dpapi1:` text on as the token.

use std::path::Path;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use crate::net::Secret;

/// The Credential Manager blob limit (CRED_MAX_CREDENTIAL_BLOB_SIZE), checked on the wrapped
/// blob; the plaintext capacity is smaller (DPAPI overhead plus base64).
pub const BLOB_MAX_BYTES: usize = 2560;
/// ERROR_NOT_FOUND: no credential under the target.
const NOT_FOUND: i32 = 1168;
/// Marks a DPAPI-wrapped blob; anything else is a legacy plaintext value.
const WRAP_PREFIX: &str = "dpapi1:";
/// The fixed half of the DPAPI entropy; the install-root key follows it.
const ENTROPY_LABEL: &[u8] = b"Vidar/credman/dpapi1\0";

/// One saved credential: `UserName`, `Comment` and the (unwrapped) blob as UTF-8.
#[derive(Debug)]
pub struct Cred {
    pub user: String,
    pub comment: String,
    pub blob: Secret,
}

/// `<prefix><root_suffix>`, the same per-install key as `%LOCALAPPDATA%\Vidar\homes\<key>`.
pub fn target_for(prefix: &str, root: &Path) -> String {
    format!("{prefix}{}", crate::falcon::host_names::root_suffix(root))
}

/// The DPAPI entropy for one install-root key.
fn entropy_for(root_key: &str) -> Vec<u8> {
    let mut e = ENTROPY_LABEL.to_vec();
    e.extend_from_slice(root_key.as_bytes());
    e
}

/// The credential store seam: `CredStore` is the live one; tests use an in-memory stand-in.
pub trait Store {
    fn read(&self) -> Result<Option<Cred>, String>;
    fn write(&self, c: &Cred) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// Credential Manager under one target name, DPAPI-wrapped.
pub struct CredStore {
    raw: WinCred,
    entropy: Vec<u8>,
}

impl CredStore {
    /// A store under `target`, wrapped with this install root's entropy.
    pub fn new(target: String) -> Self {
        let key = crate::falcon::host_names::root_suffix(&crate::paths::root());
        CredStore { raw: WinCred { target }, entropy: entropy_for(&key) }
    }

    /// The store for `prefix` under this install root.
    pub fn for_install(prefix: &str) -> Self {
        CredStore::new(target_for(prefix, &crate::paths::root()))
    }
}

impl Store for CredStore {
    fn read(&self) -> Result<Option<Cred>, String> {
        read_sealed(&self.raw, &Dpapi, &self.entropy)
    }

    fn write(&self, c: &Cred) -> Result<(), String> {
        write_sealed(&self.raw, &Dpapi, &self.entropy, c)
    }

    fn delete(&self) -> Result<(), String> {
        self.raw.delete_raw()
    }
}

/// The size check on the blob as stored; the message never echoes the blob.
fn check_blob(stored_len: usize) -> Result<(), String> {
    if stored_len <= BLOB_MAX_BYTES {
        Ok(())
    } else {
        Err(format!("credential is too long to store: over {BLOB_MAX_BYTES} bytes once encrypted"))
    }
}

/// One credential as Credential Manager holds it.
struct RawCred {
    user: String,
    comment: String,
    blob: Vec<u8>,
}

/// The unwrapped Credential Manager seam, so the wrap logic is testable without the real store.
trait RawStore {
    fn read_raw(&self) -> Result<Option<RawCred>, String>;
    fn write_raw(&self, c: &RawCred) -> Result<(), String>;
    fn delete_raw(&self) -> Result<(), String>;
    /// For log lines only; the target name carries no secret.
    fn label(&self) -> &str;
}

/// The DPAPI seam: `Dpapi` is the live one.
trait Cipher {
    fn protect(&self, plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String>;
}

/// `dpapi1:` + base64 of the sealed blob, verified to unwrap and to fit the blob limit.
fn wrap(cipher: &dyn Cipher, entropy: &[u8], plain: &str) -> Result<Vec<u8>, String> {
    let sealed = cipher.protect(plain.as_bytes(), entropy)?;
    let mut out = WRAP_PREFIX.as_bytes().to_vec();
    out.extend_from_slice(B64.encode(&sealed).as_bytes());
    check_blob(out.len())?;
    // A blob that does not unwrap now would read as logged out later: refuse it here.
    if cipher.unprotect(&sealed, entropy)? != plain.as_bytes() {
        return Err("credential encryption did not round-trip".into());
    }
    Ok(out)
}

/// What a stored blob turned out to be.
enum Opened {
    Wrapped(String),
    Legacy(String),
    /// A `dpapi1:` value that does not unwrap; the reason carries no blob text.
    Unreadable(String),
}

fn open(cipher: &dyn Cipher, entropy: &[u8], blob: &[u8]) -> Result<Opened, String> {
    let Some(body) = blob.strip_prefix(WRAP_PREFIX.as_bytes()) else {
        let text = String::from_utf8(blob.to_vec()).map_err(|_| "saved credential is not UTF-8".to_string())?;
        return Ok(Opened::Legacy(text));
    };
    let sealed = match B64.decode(body) {
        Ok(s) => s,
        Err(_) => return Ok(Opened::Unreadable("not base64".into())),
    };
    let plain = match cipher.unprotect(&sealed, entropy) {
        Ok(p) => p,
        Err(e) => return Ok(Opened::Unreadable(e)),
    };
    match String::from_utf8(plain) {
        Ok(text) => Ok(Opened::Wrapped(text)),
        Err(_) => Ok(Opened::Unreadable("unwrapped value is not UTF-8".into())),
    }
}

fn read_sealed(raw: &dyn RawStore, cipher: &dyn Cipher, entropy: &[u8]) -> Result<Option<Cred>, String> {
    let Some(rc) = raw.read_raw()? else { return Ok(None) };
    let text = match open(cipher, entropy, &rc.blob)? {
        Opened::Wrapped(text) => text,
        Opened::Unreadable(why) => {
            eprintln!("[credman] {}: saved token cannot be decrypted ({why}); reads as logged out", raw.label());
            return Ok(None);
        }
        Opened::Legacy(text) => {
            match wrap(cipher, entropy, &text) {
                Ok(blob) => {
                    let next = RawCred { user: rc.user.clone(), comment: rc.comment.clone(), blob };
                    match raw.write_raw(&next) {
                        Ok(()) => eprintln!("[credman] {}: plaintext token rewrapped with DPAPI", raw.label()),
                        Err(e) => eprintln!("[credman] {}: rewrap write failed ({e}); plaintext kept", raw.label()),
                    }
                }
                Err(e) => eprintln!("[credman] {}: rewrap failed ({e}); plaintext kept", raw.label()),
            }
            text
        }
    };
    Ok(Some(Cred { user: rc.user, comment: rc.comment, blob: Secret::new(text) }))
}

fn write_sealed(raw: &dyn RawStore, cipher: &dyn Cipher, entropy: &[u8], c: &Cred) -> Result<(), String> {
    let blob = wrap(cipher, entropy, c.blob.expose())?;
    raw.write_raw(&RawCred { user: c.user.clone(), comment: c.comment.clone(), blob })
}

/// DPAPI under the current user, never prompting.
struct Dpapi;

/// Copies and frees a DPAPI output blob (LocalFree) on every path.
fn take_blob(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if out.pbData.is_null() {
        return Vec::new();
    }
    // SAFETY: pbData points to cbData bytes DPAPI allocated with LocalAlloc; copied before free.
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    // SAFETY: pbData is the LocalAlloc buffer DPAPI returned, freed exactly once, here.
    unsafe { LocalFree(Some(HLOCAL(out.pbData as *mut std::ffi::c_void))) };
    bytes
}

fn blob_in(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
}

impl Cipher for Dpapi {
    fn protect(&self, plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        let data = blob_in(plain);
        let ent = blob_in(entropy);
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: data and ent point at live slices for the call (DPAPI only reads them); out
        // receives a LocalAlloc buffer that take_blob frees.
        let r = unsafe {
            CryptProtectData(&data, PCWSTR::null(), Some(&ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        r.map_err(|e| format!("CryptProtectData failed ({})", win32_code(&e)))?;
        Ok(take_blob(out))
    }

    fn unprotect(&self, sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        let data = blob_in(sealed);
        let ent = blob_in(entropy);
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in protect; no description out-pointer is requested.
        let r = unsafe {
            CryptUnprotectData(&data, None, Some(&ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        r.map_err(|e| format!("CryptUnprotectData failed ({})", win32_code(&e)))?;
        Ok(take_blob(out))
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn win32_code(e: &windows::core::Error) -> i32 {
    e.code().0 & 0xFFFF
}

/// Frees a `CredReadW` buffer on drop.
struct CredBuf(*mut CREDENTIALW);

impl Drop for CredBuf {
    fn drop(&mut self) {
        // SAFETY: self.0 is the non-null buffer CredReadW allocated, freed exactly once, here.
        unsafe { CredFree(self.0 as *const std::ffi::c_void) }
    }
}

/// A NUL-terminated wide string from the credential buffer; null reads as "".
fn read_pwstr(p: PWSTR) -> Result<String, String> {
    if p.is_null() {
        return Ok(String::new());
    }
    // SAFETY: p points into the live CredReadW buffer and is NUL-terminated by the API.
    unsafe { p.to_string() }.map_err(|_| "saved credential text is not valid UTF-16".to_string())
}

/// The raw Credential Manager entry under one target name.
struct WinCred {
    target: String,
}

impl RawStore for WinCred {
    fn label(&self) -> &str {
        &self.target
    }

    fn read_raw(&self) -> Result<Option<RawCred>, String> {
        let target = wide(&self.target);
        let mut raw: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: target is a NUL-terminated UTF-16 buffer alive for the call; raw receives a
        // buffer CredReadW allocates, which CredBuf frees.
        match unsafe { CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut raw) } {
            Ok(()) => {}
            Err(e) if win32_code(&e) == NOT_FOUND => return Ok(None),
            Err(e) => return Err(format!("CredReadW failed ({})", win32_code(&e))),
        }
        if raw.is_null() {
            return Ok(None);
        }
        let buf = CredBuf(raw);
        // SAFETY: buf.0 is the non-null CREDENTIALW CredReadW returned, alive until buf drops.
        let cred = unsafe { &*buf.0 };
        let user = read_pwstr(cred.UserName)?;
        let comment = read_pwstr(cred.Comment)?;
        let blob: &[u8] = if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0 {
            &[]
        } else {
            // SAFETY: CredentialBlob points to CredentialBlobSize bytes inside the live buffer.
            unsafe { std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize) }
        };
        Ok(Some(RawCred { user, comment, blob: blob.to_vec() }))
    }

    fn write_raw(&self, c: &RawCred) -> Result<(), String> {
        check_blob(c.blob.len())?;
        let mut target = wide(&self.target);
        let mut user = wide(&c.user);
        let mut comment = wide(&c.comment);
        let mut blob = c.blob.clone();
        let cred = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            Comment: PWSTR(comment.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        // SAFETY: every pointer in cred refers to a NUL-terminated wide buffer or the blob
        // buffer (exact length in CredentialBlobSize), all alive until after this call; no
        // attributes (count 0, null pointer).
        let result = unsafe { CredWriteW(&cred, 0) };
        result.map_err(|e| format!("CredWriteW failed ({})", win32_code(&e)))
    }

    fn delete_raw(&self) -> Result<(), String> {
        let target = wide(&self.target);
        // SAFETY: target is a NUL-terminated UTF-16 buffer alive for the call.
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(e) if win32_code(&e) == NOT_FOUND => Ok(()),
            Err(e) => Err(format!("CredDeleteW failed ({})", win32_code(&e))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const PREFIX: &str = "Vidar/Test/";

    /// In-memory Credential Manager entry; `fail_writes` makes every write fail.
    #[derive(Default)]
    struct FakeStore {
        saved: RefCell<Option<RawCred>>,
        fail_writes: bool,
        writes: Cell<usize>,
    }

    impl FakeStore {
        fn holding(blob: &[u8]) -> Self {
            let s = FakeStore::default();
            *s.saved.borrow_mut() = Some(RawCred { user: "u".into(), comment: "c".into(), blob: blob.to_vec() });
            s
        }
        fn blob(&self) -> Vec<u8> {
            self.saved.borrow().as_ref().expect("saved").blob.clone()
        }
    }

    impl RawStore for FakeStore {
        fn label(&self) -> &str {
            "Vidar/Fake/"
        }
        fn read_raw(&self) -> Result<Option<RawCred>, String> {
            Ok(self.saved.borrow().as_ref().map(|c| RawCred {
                user: c.user.clone(),
                comment: c.comment.clone(),
                blob: c.blob.clone(),
            }))
        }
        fn write_raw(&self, c: &RawCred) -> Result<(), String> {
            if self.fail_writes {
                return Err("fake write failure".into());
            }
            check_blob(c.blob.len())?;
            self.writes.set(self.writes.get() + 1);
            *self.saved.borrow_mut() = Some(RawCred { user: c.user.clone(), comment: c.comment.clone(), blob: c.blob.clone() });
            Ok(())
        }
        fn delete_raw(&self) -> Result<(), String> {
            *self.saved.borrow_mut() = None;
            Ok(())
        }
    }

    /// A cipher that cannot protect (stands in for a DPAPI failure on rewrap).
    struct BrokenCipher;
    impl Cipher for BrokenCipher {
        fn protect(&self, _: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
            Err("fake protect failure".into())
        }
        fn unprotect(&self, _: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
            Err("fake unprotect failure".into())
        }
    }

    fn cred(token: &str) -> Cred {
        Cred { user: "u".into(), comment: "c".into(), blob: Secret::new(token.into()) }
    }

    #[test]
    fn target_is_keyed_by_install_root() {
        let a = target_for(PREFIX, Path::new(r"D:\Tools\Vidar"));
        let suffix = a.strip_prefix(PREFIX).expect("prefix");
        assert_eq!(suffix, crate::falcon::host_names::root_suffix(Path::new(r"D:\Tools\Vidar")));
        assert_eq!(suffix.len(), 16);
        assert_eq!(a, target_for(PREFIX, Path::new(r"d:/tools/vidar/")));
        assert_ne!(a, target_for(PREFIX, Path::new(r"D:\Tools\Vidar2")));
        assert_ne!(a, target_for("Vidar/Other/", Path::new(r"D:\Tools\Vidar")));
    }

    #[test]
    fn wrapped_round_trip_stores_no_plaintext() {
        let store = FakeStore::default();
        let ent = entropy_for("0123456789abcdef");
        write_sealed(&store, &Dpapi, &ent, &cred("xoxp-1-2-roundtrip")).unwrap();
        let blob = store.blob();
        assert!(blob.starts_with(WRAP_PREFIX.as_bytes()));
        assert!(!String::from_utf8_lossy(&blob).contains("roundtrip"));
        let back = read_sealed(&store, &Dpapi, &ent).unwrap().unwrap();
        assert_eq!(back.blob.expose(), "xoxp-1-2-roundtrip");
        assert_eq!((back.user.as_str(), back.comment.as_str()), ("u", "c"));
        assert_eq!(store.writes.get(), 1, "a wrapped read never rewrites");
    }

    #[test]
    fn legacy_plaintext_is_returned_and_rewrapped() {
        let store = FakeStore::holding(b"legacy-token");
        let ent = entropy_for("0123456789abcdef");
        let back = read_sealed(&store, &Dpapi, &ent).unwrap().unwrap();
        assert_eq!(back.blob.expose(), "legacy-token");
        let blob = store.blob();
        assert!(blob.starts_with(WRAP_PREFIX.as_bytes()), "rewrapped in place");
        assert!(!String::from_utf8_lossy(&blob).contains("legacy-token"));
        assert_eq!(read_sealed(&store, &Dpapi, &ent).unwrap().unwrap().blob.expose(), "legacy-token");
    }

    #[test]
    fn failed_rewrap_keeps_the_plaintext() {
        let ent = entropy_for("0123456789abcdef");
        // The cipher fails: plaintext returned and left in place.
        let store = FakeStore::holding(b"legacy-token");
        assert_eq!(read_sealed(&store, &BrokenCipher, &ent).unwrap().unwrap().blob.expose(), "legacy-token");
        assert_eq!(store.blob(), b"legacy-token");
        // The write fails: same.
        let store = FakeStore { fail_writes: true, ..FakeStore::holding(b"legacy-token") };
        assert_eq!(read_sealed(&store, &Dpapi, &ent).unwrap().unwrap().blob.expose(), "legacy-token");
        assert_eq!(store.blob(), b"legacy-token");
        // The wrapped form would not fit: same.
        let long = "t".repeat(BLOB_MAX_BYTES);
        let store = FakeStore::holding(long.as_bytes());
        assert_eq!(read_sealed(&store, &Dpapi, &ent).unwrap().unwrap().blob.expose(), long);
        assert_eq!(store.blob(), long.as_bytes());
    }

    #[test]
    fn bad_blob_reads_as_logged_out() {
        let ent = entropy_for("0123456789abcdef");
        let not_base64 = FakeStore::holding(b"dpapi1:!!not base64!!");
        assert!(read_sealed(&not_base64, &Dpapi, &ent).unwrap().is_none());
        let garbage = format!("dpapi1:{}", B64.encode(b"not a dpapi blob"));
        let store = FakeStore::holding(garbage.as_bytes());
        assert!(read_sealed(&store, &Dpapi, &ent).unwrap().is_none());
        assert_eq!(store.blob(), garbage.as_bytes(), "an unreadable blob is left, not deleted");
        // Wrapped under another root key (stands in for a reset DPAPI master key).
        let other = FakeStore::default();
        write_sealed(&other, &Dpapi, &entropy_for("fedcba9876543210"), &cred("tok")).unwrap();
        assert!(read_sealed(&other, &Dpapi, &ent).unwrap().is_none());
    }

    #[test]
    fn size_is_checked_after_wrapping() {
        let ent = entropy_for("0123456789abcdef");
        let cap = plaintext_capacity(&ent);
        assert!(cap > 1500 && cap < BLOB_MAX_BYTES, "capacity {cap}");
        let store = FakeStore::default();
        write_sealed(&store, &Dpapi, &ent, &cred(&"a".repeat(cap))).unwrap();
        assert!(store.blob().len() <= BLOB_MAX_BYTES);
        // Fits the raw limit but not once wrapped: a clear error, nothing written.
        let store = FakeStore::default();
        let err = write_sealed(&store, &Dpapi, &ent, &cred(&"z".repeat(cap + 16))).unwrap_err();
        assert!(err.contains("too long"), "{err}");
        assert!(!err.contains("zz"), "{err}");
        assert!(store.saved.borrow().is_none());
        println!("credman plaintext capacity: {cap} bytes");
    }

    /// The longest ASCII plaintext whose wrapped form fits BLOB_MAX_BYTES (DPAPI pads to the
    /// cipher block, so the boundary is found by search, not arithmetic).
    fn plaintext_capacity(ent: &[u8]) -> usize {
        let fits = |n: usize| wrap(&Dpapi, ent, &"a".repeat(n)).is_ok();
        let (mut lo, mut hi) = (0usize, BLOB_MAX_BYTES);
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if fits(mid) { lo = mid } else { hi = mid - 1 }
        }
        lo
    }

    #[test]
    fn entropy_differs_per_root_key() {
        let a = entropy_for("0123456789abcdef");
        let b = entropy_for("fedcba9876543210");
        assert_ne!(a, b);
        assert!(a.starts_with(ENTROPY_LABEL) && b.starts_with(ENTROPY_LABEL));
        let sealed = Dpapi.protect(b"tok", &a).unwrap();
        assert_eq!(Dpapi.unprotect(&sealed, &a).unwrap(), b"tok");
        assert!(Dpapi.unprotect(&sealed, &b).is_err());
    }

    #[test]
    fn blob_is_capped_without_echo() {
        assert!(check_blob(BLOB_MAX_BYTES).is_ok());
        assert!(check_blob(BLOB_MAX_BYTES + 1).unwrap_err().contains("too long"));
    }
}
