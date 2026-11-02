//! The send seam: `Live` is `net::send`; tests answer from a fake of their own.

use super::{send, Limits, Reply, Request, Secret, SendError};

pub trait Transport {
    fn send(&self, req: &Request, headers: &Secret, limits: Limits) -> Result<Reply, SendError>;
}

pub struct Live;

impl Transport for Live {
    fn send(&self, req: &Request, headers: &Secret, limits: Limits) -> Result<Reply, SendError> {
        send(req, headers, limits)
    }
}
