# Getting help

Keelvane is free under the MIT license, including for commercial use. You never need to pay to use it.

## Free help

Open a GitHub issue for bugs and questions. Issues are public: never post passwords, tokens, keys, logs or private file paths.

## Assisted setup (pilot, not yet bookable)

An assisted desktop setup is planned as a pilot for $249. Booking and payment are not open yet.

- **Scope:** one Windows PC, one Claude Code or Codex account, one project.
- **Time:** one appointment of up to 90 minutes, plus up to 30 minutes in total for preparation and follow-up. Questions about the original installation are covered for 14 calendar days, within that 30 minutes.
- **Included:** install, project setup, the supported-account check below, and a walkthrough of backup, update, rollback and uninstall.
- **Acceptance:** you pay only after you accept the result: the desktop health check passes, and a read-only task runs and its result can be recovered. If acceptance fails, there is no charge.
- **Not included:** phone access (experimental), more PCs, accounts or projects, custom integrations, and ongoing support. Anything beyond the scope is quoted before work starts.
- You keep your own accounts and passwords. We never ask for them and never sign in for you.

If you would want this, you can open a GitHub issue titled "Assisted setup interest" saying which agent you use and your Windows version. That registers interest only; it is not a booking.

## Supported-account check

Keelvane drives the Claude Code or Codex CLI you already have. Before setup, confirm the CLI answers a non-interactive prompt with your account:

```
claude -p "say ok"
codex exec "say ok"
```

If one of them fails with an access or plan error (for example, Claude Code reporting that your organization has disabled subscription access), use the other agent for that project or fix the account with that provider first. Keelvane cannot work around an account the provider refuses.
