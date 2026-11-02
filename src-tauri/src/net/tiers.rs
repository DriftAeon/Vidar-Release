//! Deadline tiers shared by the integrations. Rate policy (`SPACING`, `SLOT`) stays with its service.

use std::time::Duration;

/// The whole budget of one integration command.
pub const COMMAND: Duration = Duration::from_secs(20);

/// One short fetch (a release index): send to the last body byte.
pub const FETCH: Duration = Duration::from_secs(15);
