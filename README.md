# opencloud-mcp

A small [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an AI assistant search and read
the files of an [OpenCloud](https://opencloud.eu/) user. It is read-only: it can find and read files, nothing else.
It was written for [Ambrogio](https://github.com/ambrogio-app), and works with any MCP client that speaks Streamable HTTP.

| Tool | What it does |
|---|---|
| `search_files` | Finds files by the words in their name and in their text. The text search uses OpenCloud's full-text index, so it also finds words inside PDFs and office documents when OpenCloud extracts their text with Apache Tika. Content matches come first, with an excerpt around the words. Each result has a `link` that opens the file in the OpenCloud web interface, for anyone who has access to it. |
| `read_file` | Returns the text of a file found by `search_files`. Text files are read as they are; PDFs and office documents go through Apache Tika. Long texts come in parts: the result gives `nextOffset` to read the next one. |

The server sees exactly what the OpenCloud user sees. Create a dedicated user, give it the **Viewer** role in a
space with the documents the assistant may read, and nothing else: OpenCloud enforces the permissions, not this
server. Remember that whatever the assistant reads goes to the provider of its language model.

## Requirements

- OpenCloud with full-text search, `FRONTEND_FULL_TEXT_SEARCH_ENABLED=true` and an Apache Tika extractor, for content search.
- An app token of the dedicated user: `opencloud auth-app create --user-name=<user> --expiration=<duration>`.
  App tokens expire: choose the duration and renew it before it ends.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `OPENCLOUD_URL` | yes | Base URL of OpenCloud, for example `http://opencloud:9200` inside Docker. |
| `OPENCLOUD_HOST` | no | Host header to send when `OPENCLOUD_URL` is not the public host of OpenCloud; requests then also carry `X-Forwarded-Proto: https`. |
| `OPENCLOUD_USER` | yes | The dedicated user. |
| `OPENCLOUD_APP_TOKEN` | yes | Its app token. |
| `TIKA_URL` | no | Apache Tika, for example `http://opencloud-tika:9998`. Without it only text files can be read. |
| `MCP_TOKEN` | yes | Long random secret; MCP clients send it as `Authorization: Bearer <token>`. |
| `HTTP_HOST`, `HTTP_PORT` | no | Listen address, `0.0.0.0:3000` by default. |
| `READ_MAX_CHARS` | no | Characters returned by one `read_file` call, 8000 by default. |
| `DOWNLOAD_MAX_BYTES` | no | Largest file that is read, 20 MiB by default. |

The MCP endpoint is `POST /mcp`, stateless. Requests with an `Origin` header are refused, so that no web page can use
the server through a visitor's browser. `GET /health` answers `ok` for container health checks.

## Run

```yaml
services:
  opencloud-mcp:
    image: ghcr.io/adrianofoschi/opencloud-mcp:v0.1.0
    restart: unless-stopped
    env_file: opencloud-mcp.env
```

Put the server on a Docker network that both OpenCloud and the MCP client reach, and do not publish its port outside
the home network. An Ambrogio agent connects to it with:

```json
"mcp": {
  "url": "http://opencloud-mcp:3000/mcp",
  "auth": { "type": "bearer", "tokenEnv": "OPENCLOUD_MCP_TOKEN" },
  "tools": ["search_files", "read_file"]
}
```

## Development

```bash
corepack enable
pnpm install
pnpm verify
```

`pnpm verify` runs the checks of CI: frozen install, audit, type check, tests and build. The tests use local fakes of
OpenCloud and Tika that answer as OpenCloud 7.2 does. Enable the secret scan before committing:
`git config core.hooksPath .githooks` with `gitleaks` on `PATH`.

Releases are tags `vMAJOR.MINOR.PATCH` equal to the version in `package.json`; CI then publishes the image to GHCR.

## License

MIT
