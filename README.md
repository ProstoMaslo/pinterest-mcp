# pinterest-mcp

<img src="assets/logo.png" width="96" align="right">

MCP server for publishing and scheduling Pinterest Pins from local images through the official Pinterest API v5.

## Tools
`status`, `list_boards`, `list_sections`, `create_board`, `list_images`, `create_pin`, `bulk_create_pins`, `list_scheduled`, `cancel_scheduled`, `reschedule`, `publish_due`

## Setup
```bash
npm install
node auth.js            # enter App ID / secret, approve in browser
```
Redirect URI in your Pinterest app: `http://localhost:8085/callback`

MCP config:
```json
{ "mcpServers": { "pinterest": { "command": "node", "args": ["/path/to/pinterest-mcp/server.js"] } } }
```

Scheduled pins are stored in `~/.config/pinterest-mcp/queue.json` and published by `scheduler.js` (run it every minute via a systemd timer or cron). The server also checks the queue while it is running.

Sandbox mode: set `PINTEREST_SANDBOX=1`, or add `"sandbox": true` (and optionally `"access_token"`) to `~/.config/pinterest-mcp/config.json`.

[Privacy Policy](PRIVACY.md)

## License

[GPL-3.0-or-later](LICENSE)
