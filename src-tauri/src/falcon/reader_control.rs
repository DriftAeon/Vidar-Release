//! Cancellable reader threads: the duplicated thread handle and the flags that
//! `Connection::request` and the event reader share with their canceller.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use windows::Win32::{
    Foundation::{CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE},
    System::{
        Threading::{GetCurrentProcess, GetCurrentThread},
        IO::CancelSynchronousIo,
    },
};

/// Owned value of a duplicated Windows thread handle.
///
/// Kernel handles are process-wide and may be used by another thread. Store the
/// opaque value rather than windows-rs's pointer wrapper, which is intentionally
/// not `Send`; reconstruct the wrapper only for Win32 calls.
pub(super) struct ThreadHandle(usize);

impl ThreadHandle {
    fn raw(&self) -> HANDLE {
        HANDLE(self.0 as *mut _)
    }
}

impl Drop for ThreadHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.raw());
        }
    }
}

pub(super) struct ReaderControl {
    cancelled: AtomicBool,
    finished: AtomicBool,
    thread: Mutex<Option<ThreadHandle>>,
}

impl ReaderControl {
    pub(super) fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            // Remains true if spawning the reader fails before it starts.
            finished: AtomicBool::new(true),
            thread: Mutex::new(None),
        }
    }

    /// Set a standing cancellation flag, then repeatedly cancel any synchronous
    /// read until the reader observes it. Repetition closes the race where one
    /// cancellation lands between the flag check and the next ReadFile.
    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        for _ in 0..50 {
            if self.finished.load(Ordering::SeqCst) {
                return;
            }
            if let Ok(thread) = self.thread.lock() {
                if let Some(thread) = thread.as_ref() {
                    let _ = unsafe { CancelSynchronousIo(thread.raw()) };
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Register the calling thread as this control's reader and return the
    /// guard that unregisters it on drop.
    ///
    /// `finished` goes false BEFORE the handle is stored: `cancel()` returns
    /// early on `finished`, so the reverse order would let it skip a reader
    /// that is about to block. A `cancel()` that landed before `finished` went
    /// false has already returned, so `cancelled` is re-checked after the
    /// handle is stored and the reader is refused (guard dropped) if it is set.
    pub(super) fn enter(self: &Arc<Self>) -> Result<ReaderFinished, String> {
        let thread = current_thread_handle()?;
        self.finished.store(false, Ordering::SeqCst);
        *self.thread.lock().unwrap_or_else(|error| error.into_inner()) = Some(thread);
        let guard = ReaderFinished(Arc::clone(self));
        if self.is_cancelled() {
            drop(guard);
            return Err("falcon reader cancelled before it started".to_string());
        }
        Ok(guard)
    }
}

fn current_thread_handle() -> Result<ThreadHandle, String> {
    let mut duplicate = HANDLE::default();
    unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            GetCurrentThread(),
            GetCurrentProcess(),
            &mut duplicate,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    }
    .map_err(|error| format!("duplicate falcon reader thread handle: {error}"))?;
    Ok(ThreadHandle(duplicate.0 as usize))
}

/// Guard held by a running reader; `ReaderControl::enter` is its only constructor.
pub(super) struct ReaderFinished(Arc<ReaderControl>);

impl Drop for ReaderFinished {
    fn drop(&mut self) {
        self.0.finished.store(true, Ordering::SeqCst);
        self.0
            .thread
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }
}
