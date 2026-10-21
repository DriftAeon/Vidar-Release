// The Slack app manifest (v1 user scopes), JSON form: Slack's manifest box opens on its JSON tab.
export const SLACK_MANIFEST = JSON.stringify(
  {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: "Vidar Inbox",
      description: "Lists your recent Slack mentions and DMs in Vidar. Read-only.",
    },
    oauth_config: { scopes: { user: ["search:read", "users:read"] } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  },
  null,
  2,
);
