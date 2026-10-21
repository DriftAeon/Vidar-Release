//! The send seam: `Live` is `net::https::send`; tests use `Fake`, which answers from a queue and
//! records what was sent. No test ever reaches Notion.

use crate::net::{self, Limits, Reply, Request, Secret, SendError};

pub trait Transport {
    fn send(&self, req: &Request, headers: &Secret, limits: Limits) -> Result<Reply, SendError>;
}

pub struct Live;

impl Transport for Live {
    fn send(&self, req: &Request, headers: &Secret, limits: Limits) -> Result<Reply, SendError> {
        net::send(req, headers, limits)
    }
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// One recorded send: the request, the header block text and the cap.
    pub struct Sent {
        pub req: Request,
        pub headers: String,
        pub cap: usize,
    }

    #[derive(Default)]
    pub struct Fake {
        replies: RefCell<VecDeque<Result<Reply, SendError>>>,
        pub sent: RefCell<Vec<Sent>>,
    }

    impl Fake {
        pub fn new() -> Self {
            Fake::default()
        }

        pub fn reply(self, status: u16, body: &str) -> Self {
            self.reply_after(status, None, body)
        }

        pub fn reply_after(self, status: u16, retry_after: Option<u64>, body: &str) -> Self {
            self.replies
                .borrow_mut()
                .push_back(Ok(Reply { status, retry_after, body: body.as_bytes().to_vec() }));
            self
        }

        pub fn fail(self, e: SendError) -> Self {
            self.replies.borrow_mut().push_back(Err(e));
            self
        }

        pub fn count(&self) -> usize {
            self.sent.borrow().len()
        }
    }

    impl Transport for Fake {
        fn send(&self, req: &Request, headers: &Secret, limits: Limits) -> Result<Reply, SendError> {
            self.sent.borrow_mut().push(Sent {
                req: req.clone(),
                headers: headers.expose().to_string(),
                cap: limits.cap,
            });
            self.replies
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| Err(SendError::Io("fake: no reply queued".to_string())))
        }
    }
}
