# Notion API fixtures

Hand-written reply bodies for the Notion tab's Rust tests (`src-tauri/src/notion/tests.rs`) and the
TS block renderer tests. No Notion API was called to make them. Ids are zero-filled UUIDs, the
workspace is "Example Workspace", and every url outside a Notion host points at `example.com` or
`example.invalid`.

Shapes follow the N1 research report (`docs/runs/2026-10-17-notion/reports/N1-notion.md`,
gitignored), which cites these developers.notion.com pages:

| Fixture | Endpoint | N1 source |
|---|---|---|
| `users-me.json` | `GET /v1/users/me` | Q2, /reference/get-self (`bot.owner.type`, `bot.workspace_name`) |
| `search-sources.json` | `POST /v1/search`, `filter.value: "data_source"` | Q1, /reference/post-search; upgrade guide 2025-09-03 |
| `search-pages.json` | `POST /v1/search`, `filter.value: "page"` | Q1, /reference/post-search; Q5, /reference/retrieve-a-page (`parent` types) |
| `source.json` | `GET /v1/data_sources/{id}` | Q1, /reference/retrieve-a-data-source; Q4, /reference/property-object (status `groups`) |
| `query-page-1.json`, `query-last.json` | `POST /v1/data_sources/{id}/query` | Q1, /reference/query-a-data-source; Q3, /reference/intro (paging) |
| `page-all-props.json` | `GET /v1/pages/{id}` | Q4, /reference/property-object; Q5, /reference/retrieve-a-page |
| `blocks-nested.json`, `blocks-hostile.json` | `GET /v1/blocks/{id}/children` | Q5, /reference/get-block-children, /reference/block, /reference/rich-text |
| `error-429.json`, `error-403.json` | any | Q3, /reference/request-limits (`additional_data.retry_after`); Q2, /reference/capabilities |

Deliberate oddities, each tested:

- `search-pages.json` carries both database-row parents (`data_source_id`, `database_id`), which the
  backend drops (plan § D1, marked I), a dashless id and a `javascript:` url, which is rebuilt.
- `search-sources.json` carries an off-host url and an invalid id.
- `query-page-1.json` carries null and empty facet values and a wiki `data_source` result.
- `blocks-hostile.json` carries markup in text, `javascript:` and `data:` links, an external icon,
  an unknown block type, a non-block object, a bad id, a missing id and a bare string.
