//! One HTTPS request through WinHTTP: no new crate, the system certificate store and the system
//! proxy, port 443 only, redirects never followed. Jira, Notion and Slack send through it. The header block is the caller's, passed as a `Secret` so no
//! `{:?}`, test failure or error string can carry a token.

use std::ffi::c_void;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::GetLastError;
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
    WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
    WinHttpSetTimeouts, INTERNET_DEFAULT_HTTPS_PORT, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
    WINHTTP_FLAG_SECURE, WINHTTP_OPTION_RECEIVE_RESPONSE_TIMEOUT, WINHTTP_OPTION_REDIRECT_POLICY,
    WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_RETRY_AFTER,
    WINHTTP_QUERY_STATUS_CODE,
};

use super::Secret;

const RESOLVE_MS: i32 = 5_000;
const CONNECT_MS: i32 = 5_000;
const SEND_MS: i32 = 10_000;
const RECEIVE_MS: i32 = 10_000;
const RECEIVE_RESPONSE_MS: u32 = 10_000;
const READ_CHUNK: usize = 64 * 1024;
/// A redirect to another host would resend the caller's auth header; a 3xx comes back as-is.
const REDIRECT_POLICY: u32 = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
/// ERROR_WINHTTP_TIMEOUT.
const CODE_TIMEOUT: i32 = 12002;
/// ERROR_WINHTTP_NAME_NOT_RESOLVED and ERROR_WINHTTP_CANNOT_CONNECT.
const CODES_CONNECT: [i32; 2] = [12007, 12029];
/// Wide chars read for `Retry-After`; a seconds value is far shorter.
const RETRY_AFTER_CHARS: usize = 64;

/// One HTTPS request to `host:443`. Holds no header text: that is the caller's `Secret`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: &'static str,
    pub host: String,
    pub path: String,
    pub body: Option<Vec<u8>>,
}

/// Per-call bounds: bodies past `cap` bytes are refused, not truncated, and the body read stops
/// once `body_deadline` has passed since send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub cap: usize,
    pub body_deadline: Duration,
}

/// Status, `Retry-After` in seconds when the header holds a number, and the raw body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub retry_after: Option<u64>,
    pub body: Vec<u8>,
}

/// A transport failure. Texts carry the WinHTTP call and its code only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    Connect(String),
    OverCap,
    Timeout,
    Io(String),
}

/// Closes a WinHTTP handle on drop, so every early return releases it. Locals drop in reverse
/// declaration order: request, then connection, then session.
struct Handle(*mut c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: self.0 is a non-null handle returned by WinHttpOpen/Connect/OpenRequest and
        // closed exactly once, here.
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

fn classify(what: &str, code: i32) -> SendError {
    if code == CODE_TIMEOUT {
        SendError::Timeout
    } else if CODES_CONNECT.contains(&code) {
        SendError::Connect(format!("{what} failed ({code})"))
    } else {
        SendError::Io(format!("{what} failed ({code})"))
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error(what: &str) -> SendError {
    // SAFETY: GetLastError reads the calling thread's last-error value; no pointers involved.
    let code = unsafe { GetLastError() }.0 as i32;
    classify(what, code)
}

fn handle(raw: *mut c_void, what: &str) -> Result<Handle, SendError> {
    if raw.is_null() {
        Err(last_error(what))
    } else {
        Ok(Handle(raw))
    }
}

fn win(r: windows::core::Result<()>, what: &str) -> Result<(), SendError> {
    // The low word of the HRESULT is the Win32 code.
    r.map_err(|e| classify(what, e.code().0 & 0xFFFF))
}

fn set_u32(h: &Handle, option: u32, value: u32) -> Result<(), SendError> {
    let bytes = value.to_ne_bytes();
    // SAFETY: h is a live request handle; the option takes a DWORD and `bytes` is that DWORD,
    // borrowed for the call only.
    win(unsafe { WinHttpSetOption(Some(h.0 as *const c_void), option, Some(&bytes)) }, "WinHttpSetOption")
}

/// Appends one read chunk under the call's limits: past the deadline is `Timeout`, past the cap
/// is `OverCap`.
fn take_chunk(body: &mut Vec<u8>, chunk: &[u8], limits: &Limits, sent_at: Instant, now: Instant) -> Result<(), SendError> {
    if now.saturating_duration_since(sent_at) > limits.body_deadline {
        return Err(SendError::Timeout);
    }
    if body.len() + chunk.len() > limits.cap {
        return Err(SendError::OverCap);
    }
    body.extend_from_slice(chunk);
    Ok(())
}

/// Delta-seconds only; an HTTP-date or anything else is `None`.
fn parse_retry_after(text: &str) -> Option<u64> {
    let t = text.trim();
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    t.parse().ok()
}

/// A missing header or a failed read is `None`, never an error.
fn retry_after(request: &Handle) -> Option<u64> {
    let mut buf = [0u16; RETRY_AFTER_CHARS];
    let mut len = std::mem::size_of_val(&buf) as u32;
    // SAFETY: request has a response; buf is writable for `len` bytes and WinHTTP writes at
    // most that many, reporting the bytes written (without the NUL) in len.
    let read = unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_RETRY_AFTER,
            PCWSTR::null(),
            Some(buf.as_mut_ptr() as *mut c_void),
            &mut len,
            std::ptr::null_mut(),
        )
    };
    read.ok()?;
    let chars = (len as usize / 2).min(RETRY_AFTER_CHARS);
    parse_retry_after(&String::from_utf16(&buf[..chars]).ok()?)
}

/// Sends `req` with the caller's header block (CRLF-separated lines) and reads the whole reply.
pub fn send(req: &Request, headers: &Secret, limits: Limits) -> Result<Reply, SendError> {
    let agent = wide("Vidar");
    // SAFETY: agent is a NUL-terminated UTF-16 buffer alive for the call; the proxy name and
    // bypass are null, as AUTOMATIC_PROXY requires.
    let session = handle(
        unsafe { WinHttpOpen(PCWSTR(agent.as_ptr()), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, PCWSTR::null(), PCWSTR::null(), 0) },
        "WinHttpOpen",
    )?;
    // SAFETY: session is a live session handle.
    win(unsafe { WinHttpSetTimeouts(session.0, RESOLVE_MS, CONNECT_MS, SEND_MS, RECEIVE_MS) }, "WinHttpSetTimeouts")?;

    let host = wide(&req.host);
    // SAFETY: session is live; host is a NUL-terminated UTF-16 buffer alive for the call.
    let connect = handle(
        unsafe { WinHttpConnect(session.0, PCWSTR(host.as_ptr()), INTERNET_DEFAULT_HTTPS_PORT, 0) },
        "WinHttpConnect",
    )?;

    let verb = wide(req.method);
    let path = wide(&req.path);
    // SAFETY: connect is live; verb and path are NUL-terminated UTF-16 buffers alive for the
    // call; null version, referrer and accept types select WinHTTP's defaults.
    let request = handle(
        unsafe {
            WinHttpOpenRequest(
                connect.0,
                PCWSTR(verb.as_ptr()),
                PCWSTR(path.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                std::ptr::null(),
                WINHTTP_FLAG_SECURE,
            )
        },
        "WinHttpOpenRequest",
    )?;
    set_u32(&request, WINHTTP_OPTION_REDIRECT_POLICY, REDIRECT_POLICY)?;
    set_u32(&request, WINHTTP_OPTION_RECEIVE_RESPONSE_TIMEOUT, RECEIVE_RESPONSE_MS)?;

    let header_block: Vec<u16> = headers.expose().encode_utf16().collect();
    let body: &[u8] = req.body.as_deref().unwrap_or(&[]);
    let body_len = u32::try_from(body.len()).map_err(|_| SendError::Io("request body too large".to_string()))?;
    let body_ptr = (!body.is_empty()).then(|| body.as_ptr() as *const c_void);
    let header_arg = (!header_block.is_empty()).then_some(header_block.as_slice());
    let sent_at = Instant::now();
    // SAFETY: request is live; the header block (explicit length, no NUL needed) and the body
    // buffer outlive this synchronous call, and body_len is the body's exact length.
    win(unsafe { WinHttpSendRequest(request.0, header_arg, body_ptr, body_len, body_len, 0) }, "WinHttpSendRequest")?;
    // SAFETY: request is live and has been sent; the reserved argument must be null.
    win(unsafe { WinHttpReceiveResponse(request.0, std::ptr::null_mut()) }, "WinHttpReceiveResponse")?;

    let mut status: u32 = 0;
    let mut status_len = std::mem::size_of::<u32>() as u32;
    // SAFETY: request has a response; FLAG_NUMBER writes one DWORD into `status`, whose size is
    // passed in status_len; a null name and null index are the by-index defaults.
    win(
        unsafe {
            WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                PCWSTR::null(),
                Some(&mut status as *mut u32 as *mut c_void),
                &mut status_len,
                std::ptr::null_mut(),
            )
        },
        "WinHttpQueryHeaders",
    )?;
    let status = u16::try_from(status).map_err(|_| SendError::Io(format!("status {status} out of range")))?;
    let retry_after = retry_after(&request);

    let mut body = Vec::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    loop {
        let mut read: u32 = 0;
        // SAFETY: request is live; chunk is a writable buffer of exactly READ_CHUNK bytes, and
        // WinHTTP writes at most that many, reporting the count in `read`.
        win(
            unsafe { WinHttpReadData(request.0, chunk.as_mut_ptr() as *mut c_void, READ_CHUNK as u32, &mut read) },
            "WinHttpReadData",
        )?;
        if read == 0 {
            break;
        }
        let read = (read as usize).min(READ_CHUNK);
        take_chunk(&mut body, &chunk[..read], &limits, sent_at, Instant::now())?;
    }
    Ok(Reply { status, retry_after, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_policy_is_never_and_cap_is_per_call() {
        assert_eq!(REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER);
        assert_eq!(REDIRECT_POLICY, 0);
        let t0 = Instant::now();
        let small = Limits { cap: 4, body_deadline: Duration::from_secs(20) };
        let large = Limits { cap: 8, body_deadline: Duration::from_secs(20) };
        let mut body = Vec::new();
        assert_eq!(take_chunk(&mut body, b"abc", &small, t0, t0), Ok(()));
        assert_eq!(take_chunk(&mut body, b"de", &small, t0, t0), Err(SendError::OverCap));
        assert_eq!(body, b"abc");
        assert_eq!(take_chunk(&mut body, b"de", &large, t0, t0), Ok(()));
        assert_eq!(body, b"abcde");
        let short = Limits { cap: 1024, body_deadline: Duration::from_secs(1) };
        assert_eq!(take_chunk(&mut body, b"f", &short, t0, t0 + Duration::from_secs(1)), Ok(()));
        assert_eq!(take_chunk(&mut body, b"g", &short, t0, t0 + Duration::from_millis(1_001)), Err(SendError::Timeout));
    }

    #[test]
    fn winhttp_codes_classify() {
        assert_eq!(classify("WinHttpSendRequest", 12002), SendError::Timeout);
        assert_eq!(classify("WinHttpSendRequest", 12007), SendError::Connect("WinHttpSendRequest failed (12007)".into()));
        assert_eq!(classify("WinHttpSendRequest", 12029), SendError::Connect("WinHttpSendRequest failed (12029)".into()));
        assert_eq!(classify("WinHttpReadData", 12030), SendError::Io("WinHttpReadData failed (12030)".into()));
        let e = windows::core::Error::from_hresult(windows::core::HRESULT(0x8007_2EE2_u32 as i32));
        assert_eq!(win(Err(e), "WinHttpSendRequest"), Err(SendError::Timeout));
    }

    #[test]
    fn retry_after_is_seconds_or_none() {
        assert_eq!(parse_retry_after("3"), Some(3));
        assert_eq!(parse_retry_after(" 120 "), Some(120));
        for bad in ["", "-1", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "99999999999999999999999"] {
            assert_eq!(parse_retry_after(bad), None, "{bad:?}");
        }
    }
}
