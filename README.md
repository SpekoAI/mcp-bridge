# @spekoai/mcp

Local stdio bridge for MCP clients that cannot connect to remote HTTP MCP
servers directly. It proxies SpekoAI's hosted MCP server and does not contain
Speko tool logic of its own.

Use the hosted endpoint directly when your client supports remote MCP:

```json
{
  "mcpServers": {
    "spekoai": {
      "url": "https://mcp.speko.ai/mcp-auth"
    }
  }
}
```

Use this package for stdio-only clients.

## Install

```bash
npx @spekoai/mcp@latest --help
```

The package exposes the `spekoai-mcp` binary.

## Claude Code

OAuth-capable remote MCP clients should prefer the hosted endpoint:

```bash
claude mcp add --transport http spekoai https://mcp.speko.ai/mcp-auth
```

For a stdio bridge install:

```bash
claude mcp add spekoai -- npx -y @spekoai/mcp@latest
```

For API-key auth in a headless setup, provide `SPEKO_API_KEY` in the MCP
client environment. The bridge forwards it as `Authorization: Bearer ...`.

## Cursor

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "spekoai": {
      "command": "npx",
      "args": ["-y", "@spekoai/mcp@latest"]
    }
  }
}
```

With API-key auth:

```json
{
  "mcpServers": {
    "spekoai": {
      "command": "npx",
      "args": ["-y", "@spekoai/mcp@latest"],
      "env": {
        "SPEKO_API_KEY": "sk_live_xxx"
      }
    }
  }
}
```

## OpenCode

Add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "spekoai": {
      "type": "local",
      "command": ["pnpm", "dlx", "@spekoai/mcp@latest"],
      "enabled": true
    }
  }
}
```

With API-key auth:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "spekoai": {
      "type": "local",
      "command": ["pnpm", "dlx", "@spekoai/mcp@latest"],
      "enabled": true,
      "environment": {
        "SPEKO_API_KEY": "{env:SPEKO_API_KEY}"
      }
    }
  }
}
```

## Generic MCP Config

```json
{
  "mcpServers": {
    "spekoai": {
      "command": "npx",
      "args": ["-y", "@spekoai/mcp@latest"]
    }
  }
}
```

## Configuration

Defaults:

- Authenticated endpoint: `https://mcp.speko.ai/mcp-auth`
- Public-only endpoint: `https://mcp.speko.ai/mcp`

Environment variables:

- `SPEKOAI_MCP_AUTH_URL`: override the authenticated endpoint.
- `SPEKOAI_MCP_URL`: override the public endpoint.
- `SPEKO_API_KEY`: forward an API key as a bearer token.

CLI examples:

```bash
npx @spekoai/mcp@latest
npx @spekoai/mcp@latest --public
SPEKO_API_KEY=sk_live_xxx npx @spekoai/mcp@latest
SPEKOAI_MCP_AUTH_URL=https://mcp-staging.speko.dev/mcp-auth npx @spekoai/mcp@latest
npx @spekoai/mcp@latest https://mcp-staging.speko.dev/mcp-auth --debug
```

All remaining arguments are passed through to `mcp-remote`.

## Troubleshooting

Run:

```bash
npx @spekoai/mcp@latest --help
```

For `mcp-remote` auth cache issues, restart the MCP client after clearing:

```bash
rm -rf ~/.mcp-auth
```

For connection or OAuth issues, pass `--debug` and inspect the log path printed
by `mcp-remote`.
