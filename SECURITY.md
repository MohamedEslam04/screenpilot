# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private report instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and which version and operating system you used.

I read every report and will reply as soon as I can. This is a one-person project, so I can't promise a fixed response time.

## Supported versions

Only the latest release gets fixes.

## What matters here

ScreenPilot lets an AI app use your real mouse and keyboard and record your screen, so the things that matter most are:

- input going somewhere it should not (clicks or typing in the wrong window, secrets typed or logged);
- the MCP server doing more than a client asked for;
- the installer or `setup` changing files other than the AI apps' config files it says it changes;
- anything in a release package that does not match this repository.

Limits you can set today: `SCREENPILOT_ALLOW_APPS`, `SCREENPILOT_ALLOW_ENV` and `SCREENPILOT_PERFORM_TIMEOUT` (see [CONTRIBUTING.md](CONTRIBUTING.md), "Let the agent drive"). Every driving action is logged to `audit.jsonl` in the config folder; typed text is never logged.
