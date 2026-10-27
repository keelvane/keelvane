# Keelvane

Your AI coding agents on your Windows desktop, one folder per project, with guardrails. Phone access through Muse is experimental.

Keelvane runs on your Windows machine and drives the Claude Code or Codex CLI you already have, signed in with your own account. Free and open source under the MIT license, including for commercial use.

## Where your data goes

- **Stays on your PC:** the Keelvane service, its dashboard, its settings and records, and your project files. Keelvane has no server of its own and no telemetry, and resells nothing.
- **Goes to the AI provider you chose:** whatever the agent sends while it works, which can include your prompts and the contents of project files it reads. That provider's terms and data policies apply.
- **Phone access (experimental, optional):** messages you send from the phone pass through Muse and your own Tailscale network.

## What it does

- **One folder per project.** Each project gets its own folder, its own agent (Claude Code or Codex) and its own rules. File tools stay inside the assigned folder.
- **Guardrails by default.** Agents cannot write to `.git`, `.env` or private key files.
- **Private projects.** A project marked private is hidden from Muse.
- **Phone access through Muse (experimental).** One side chat per project. Retries are safe: an exact repeat returns the original turn, and a changed request under the same ID is refused instead of running twice.
- **Git tools.** Agents can show status and diffs and commit inside a project's repository.
- **Local dashboard** at `http://127.0.0.1:47310`.
- **Lifecycle commands:** `doctor`, `backup`, `update`, `rollback`, `uninstall`. Uninstall leaves your project folders alone.

## Requirements

- Windows 11 (Windows 10 is untested)
- Node.js 26 or later
- Claude Code CLI or Codex CLI, installed and signed in with your own account that allows non-interactive use (see the [supported-account check](SUPPORT.md#supported-account-check))
- For phone access: a Muse account and a free Tailscale account
- Git, recommended

## What it costs

Keelvane itself is free. You need an account with Claude Code or Codex that allows CLI use; some plans have tight limits or exclude it, so check each provider's current plans and terms. Muse and Tailscale are optional and only needed for phone access.

## Install from a release (easiest)

1. Download `keelvane-<version>.zip` from [Releases](https://github.com/keelvane/keelvane/releases). It bundles its own Node.js, so you do not need Node installed.
2. Unzip it anywhere and double-click `setup.cmd`.
3. Builds are not code-signed yet. Before running anything, compare the zip's SHA-256 (`Get-FileHash keelvane-<version>.zip`) with the checksum on the release page. If they differ, or Windows blocks the file, stop: don't change security settings. Install from source instead.

## Install from source

```
git clone https://github.com/keelvane/keelvane.git
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

Version 0.1, early, desktop first. The desktop install is tested on a clean Windows 11 machine. Phone access is experimental: it is tested only against a simulated Tailscale connection, a real-account test is still to come, and Muse is in limited testing and can change without notice.

## Fine print

- Bring your own accounts. Each provider's terms and usage limits apply to you.
- AI agents can make mistakes in your files. Use Git and keep backups.
- Keelvane is independent. It is not affiliated with or endorsed by Anthropic, OpenAI, Meta or Tailscale. Product names are used only to describe compatibility.

## Contributing

Bug reports and ideas are welcome as GitHub issues. Run `npm test` before opening a pull request.

## Help and assisted setup

Free help through GitHub issues. A paid assisted desktop setup is planned as a pilot; booking is not open yet. See [SUPPORT.md](SUPPORT.md).

## License

[MIT](LICENSE). Use it, change it and ship it, commercially or not.
