# Jira fixtures

Synthetic bodies for the Jira Issues tab (`docs/projects/jira/issues-tab-plan.md`); the shapes are web-read (plan § Sources, Risk 1), not captured from a live site. Hosts are `example.atlassian.net` only.

- `search-jql.json`: a `POST /rest/api/3/search/jql` 200 reply, `{ issues: [{ key, fields }], nextPageToken, isLast }`, with one issue whose key fails the key pattern. Source: https://community.developer.atlassian.com/t/jira-cloud-rest-api-v3-search-jql-slower-fetching-with-nextpagetoken-no-totalissues-any-workarounds/90176
- `search-jql-empty.json`: the same reply with no issues; `isLast` alone ends the page. Source: https://community.atlassian.com/forums/Jira-questions/REST-The-new-rest-api-3-search-jql-endpoint-is-a-complete/qaa-p/3132194
- `error-400.json`: a 400 reply for unparsable JQL, `{ errorMessages[], errors }`. Source: https://community.developer.atlassian.com/t/jira-cloud-rest-api-v3-search-jql-slower-fetching-with-nextpagetoken-no-totalissues-any-workarounds/90176
- `search-jql.json` also carries an epic (`hierarchyLevel` 1), a bug with a `parent`, and a sub-task with `parent` and `subtask: true` but no `hierarchyLevel` (shapes per the same web-read sources and the v3 OpenAPI spec: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post).
- `approximate-count.json`: a `POST /rest/api/3/search/approximate-count` 200 reply, `{ count }`. Source: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-approximate-count-post
- `issuetype.json`: a `GET /rest/api/3/issuetype` 200 reply, an array of types; carries a repeated "Epic" (a team-managed one with `scope`), a sub-task with `subtask: true` and no `hierarchyLevel`, and a type with neither. Source: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-types/#api-rest-api-3-issuetype-get
- `project-search.json`: a `GET /rest/api/3/project/search` 200 reply, `{ values: [{ key, name }], isLast }`, with one project whose key fails the key pattern. Source: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-search-get
- `issues.json`: not raw; the `jira_issues` output (`{ issues, nextPageToken }`) that `search-jql.json` parses to (`src-tauri/src/jira/api.rs`, `search_fixture_parses_to_issue_shape`).
