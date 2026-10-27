# Keelvane

Your AI coding agents, one folder per project, with guardrails. Optional phone access through Muse over your own private Tailscale network.

Keelvane runs on your Windows machine and drives the Claude Code or Codex CLI you already have, signed in with your own account. Nothing runs on anyone else's server, nothing is resold, and there is no telemetry.

## What it does

- **One folder per project.** Each project gets its own folder, its own agent (Claude Code or Codex) and its own rules. File tools stay inside the assigned folder.
- **Guardrails by default.** Agents cannot write to `.git`, `.env` or private key files.
- **Private projects.** A project marked private is hidden from Muse.
- **Phone access through Muse (optional).** One side chat per project. Retries are safe: an exact repeat returns the original turn, and a changed request under the same ID is refused instead of running twice.
- **Git tools.** Agents can show status and diffs and commit inside a project's repository.
- **Local dashboard** at `http://127.0.0.1:47310`.
- **Lifecycle commands:** `doctor`, `backup`, `update`, `rollback`, `uninstall`. Uninstall leaves your project folders alone.

## Requirements

- Windows 11 (Windows 10 is untested)
- Node.js 26 or later
- Claude Code CLI or Codex CLI, installed and signed in with your own account
- For phone access: a Muse account and a free Tailscale account
- Git, recommended

## What it costs

Keelvane is free for personal use; commercial use needs a paid license (see [License](#license)). You bring the rest, and the cheapest setup is $0 a month:

- **Codex:** works on ChatGPT Free with tight limits; ChatGPT Plus ($20/month) for daily use.
- **Claude Code:** no free tier; starts with Claude Pro ($20/month).
- **Muse (optional, for phone access):** free tier; Power is $20/month.
- **Tailscale (optional):** free personal plan.

So $0 to try it, and about $20 a month for real work. Plans change; check each provider's current pricing.

## Install from a release (easiest)

1. Download `keelvane-<version>.zip` from [Releases](https://github.com/keelvane/keelvane/releases). It bundles its own Node.js, so you do not need Node installed.
2. Unzip it anywhere and double-click `setup.cmd`.
3. Windows SmartScreen may warn that the file is from an unknown publisher, because builds are not code-signed yet. Choose "More info", then "Run anyway", or install from source instead.

## Install from source

```
git clone <this repository>
cd keelvane
npm install
node keelvane.mjs setup
```

Setup asks for your project folders and which agent each one uses, then starts the service and runs a health check. It needs no admin rights and is safe to rerun. Add `--dry-run` to rehearse without changing anything. The Muse connection token is stored in Windows Credential Manager and never printed.

```
node keelvane.mjs doctor      health check
node keelvane.mjs uninstall   remove Keelvane (add --remove-data to delete its data too)
```

## Status

Version 0.1, early. The install is tested on a clean Windows 11 machine. The Muse path is tested against a simulated Tailscale connection; a real-account test is still to come. Muse is in limited testing and can change without notice, which may break the connector.

## Fine print

- Bring your own accounts. Each provider's terms and usage limits apply to you.
- AI agents can make mistakes in your files. Use Git and keep backups.
- Keelvane is independent. It is not affiliated with or endorsed by Anthropic, OpenAI, Meta or Tailscale. Product names are used only to describe compatibility.

## Contributing

Bug reports and ideas are welcome as GitHub issues. Run `npm test` before opening a pull request.

## License

Free for personal and other noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Fork it, change it and share your version on the same terms. Commercial use, including use at or for a business, needs a paid license: see [COMMERCIAL.md](COMMERCIAL.md). Version 0.1.0 was released under MIT and stays under MIT.
