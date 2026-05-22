# @spekoai/mcp

Interactive installer and local stdio-to-remote bridge for Speko MCP. The
installer configures Speko's hosted remote MCP endpoint in coding tools that
support it. The `bridge` command is only for MCP clients that require a local
stdio command: it speaks stdio to the client, connects to Speko's hosted MCP
server over HTTP, and does not contain Speko tool logic of its own.

## Install

```bash
npx @spekoai/mcp@latest init
```

The package exposes the `spekoai-mcp` binary. Run `init` for a guided setup
wizard that can configure Claude Code, Codex, OpenCode, Cursor, and generic MCP
clients.

For scripted setup, pass the choices explicitly:

```bash
npx @spekoai/mcp@latest init --access full --auth oauth --tools claude,codex --scope user --yes
```

## Bridge

Most users should run `init`. Use `bridge` only when a client cannot connect to
remote MCP directly and asks for a local command-based MCP server.

```bash
npx @spekoai/mcp@latest bridge
```

For API-key auth in a headless bridge setup, provide `SPEKO_API_KEY` in the MCP
client environment. The bridge forwards it to the hosted MCP server as
`Authorization: Bearer ...`.

The `bridge` command adapts local stdio MCP to Speko's remote HTTP MCP endpoint.
Use direct remote MCP configuration instead when your client supports it.

Defaults:

- Authenticated endpoint: `https://mcp.speko.ai/mcp-auth`
- Public-only endpoint: `https://mcp.speko.ai/mcp`

Environment variables:

- `SPEKO_API_KEY`: forward an API key as a bearer token.

CLI examples:

```bash
npx @spekoai/mcp@latest bridge
npx @spekoai/mcp@latest bridge --public
SPEKO_API_KEY=sk_live_xxx npx @spekoai/mcp@latest bridge
```

All remaining arguments are passed through to
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote).

## Troubleshooting

Run:

```bash
npx @spekoai/mcp@latest bridge --help
```

When using `bridge`, OAuth state is handled by
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote). It may create
`~/.mcp-auth` or use `MCP_REMOTE_CONFIG_DIR` to store local OAuth credentials
and debug logs. The `init` wizard does not write that directory.

For connection or OAuth issues, pass `--debug` and inspect the log path printed
by [`mcp-remote`](https://www.npmjs.com/package/mcp-remote).
