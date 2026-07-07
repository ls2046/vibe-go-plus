# VibeGo Plus

VibeGo Plus is a uni-app x client and local Node.js bridge server for driving Codex Desktop from a mobile or tablet interface.

## Repository Layout

```text
VibeGo/      uni-app x client project
server/      local bridge server
```

This public tree intentionally excludes local runtime data, generated builds, uploads, private credentials, and design/reference experiments from the development workspace.

## Quick Start

Start the local bridge server:

```bash
cd server
npm install
cp config.example.json config.json
npm start
```

Open the `VibeGo/` directory in HBuilderX, then run or build the app for Android.

In the app settings, set the server address:

```text
http://127.0.0.1:8790
```

If the app runs on a phone or tablet, replace `127.0.0.1` with your computer's LAN IP, for example:

```text
http://192.168.1.10:8790
```

## Configuration

Create server config from the example:

```bash
cp server/config.example.json server/config.json
```

Then edit `server/config.json`:

```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "path": "/absolute/path/to/my-project"
    }
  ]
}
```

Optional cloud speech settings live in `server/.env.local`. Start from:

```bash
cp server/.env.example server/.env.local
```

Do not commit `server/config.json` or `server/.env.local`.

## Codex Desktop

The server controls a local Codex Desktop instance through CDP and local session files. Start Codex Desktop with remote debugging enabled:

```bash
open -a Codex --args --remote-debugging-port=9222
```

## Public Hygiene

The public repository should not contain:

- `server/config.json`
- `server/.env.local`
- `server/uploads/`
- `VibeGo/unpackage/`
- `reference/`
- `prototypes/`
- APK, keystore, logs, or local machine paths

## License

MIT
