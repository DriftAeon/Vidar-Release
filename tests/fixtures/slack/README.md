# Slack fixtures

Made-up workspace data for the Slack tab. Hosts are
`example.slack.com`; every id (`T0FIXTURE1`, `U0FIXTURE1`…) is invented. No real workspace data.

- `auth-test.json`: an `auth.test` reply; `U0FIXTURE1` is the connected user.
- `search-mentions.json`: a `search.messages` reply for `<@U0FIXTURE1>`. Holds one of the user's own
  messages (dropped by the merge) and a permalink on another host (rebuilt on `example.slack.com`).
- `search-dms.json`: the recent-DM reply (`after:<date>`): one `is_im` / `type: "im"` match, one
  `is_mpim` match, and one public-channel match the DM filter drops.
- `items.json`: the merged list both sides read, `{ items, truncated }`. Rust
  (`slack::parse::tests::search_fixture_parses_to_item_shape`) builds it from the two search fixtures
  with `U0FIXTURE2` resolving to "Ada Example" and every other id unresolved; the TypeScript model
  checks its keys against `ITEM_KEYS`. `place` covers all four values: `D0FIXTURE1` dm (`type: "im"`),
  `G0FIXTURE2` group (`is_mpim`), `G0FIXTURE1` private (`is_private`), `C0FIXTURE1` channel.

Match fields follow Slack's `search.messages` reference (`messages.matches[]` with `channel`, `type`,
`user`, `username`, `ts`, `text`, `permalink`; `messages.paging.pages`) and the P0 probe's verified
DM discriminators (`type: "im"`, `channel.is_im`). `channel.is_mpim` on a group DM is from the docs,
not seen live in P0.
