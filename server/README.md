# VibeGo Server

Local bridge server for the VibeGo uni-app client.

## Start

```bash
cd server
npm install
cp config.example.json config.json
npm start
```

Default URL:

```text
http://127.0.0.1:8790
```

When using a phone or tablet, replace `127.0.0.1` in the app settings with your computer's LAN IP.

## Configure Projects

Edit `config.json` after copying it from `config.example.json`:

```json
{
  "port": 8790,
  "host": "0.0.0.0",
  "token": "",
  "codexBackend": "cdp",
  "codexCdpEndpoint": "http://127.0.0.1:9222",
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "path": "/absolute/path/to/my-project"
    }
  ]
}
```

## Optional ASR

Cloud ASR uses environment variables. Copy `.env.example` to `.env.local` and fill in your own provider credentials.

## Codex Desktop Backend

This server does not call the OpenAI API directly. It talks to Codex Desktop by:

- Controlling Codex Desktop through Chrome DevTools Protocol DOM operations.
- Selecting or creating Codex threads from the visible Codex sidebar.
- Reading local session JSONL files from `~/.codex/sessions`.

Codex Desktop must be running with remote debugging enabled, for example:

```bash
open -a Codex --args --remote-debugging-port=9222
```
