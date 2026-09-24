# Tars Privacy Policy

Last updated: 2026-09-24.

This policy covers two things: the Tars desktop app, and the website that offers it for download.

## The short version

- Tars is a desktop app that runs on your Mac. There is no Tars server and no Tars account, and the app collects no analytics or telemetry.
- What Tars stores, it stores in folders in your home directory, on your machine.
- Data leaves your machine only toward services you connect yourself: the AI providers whose command-line tools or API keys you use, and integrations such as Telegram, Slack or Discord that you turn on. Each of them receives data under its own terms, not ours.
- The website uses Vercel Web Analytics, which sets no cookies, and counts downloads from GitHub's own release figures.

## Who runs what

Tars is open-source software published by Cooper Labs (contact@cooperlabs.xyz). When you run Tars, you run it: the app, the agents it starts and the data they handle are on your computer, under your macOS account. Nobody operating this project receives your prompts, your code, your files, your keys or your usage. We have no server that could receive them.

## What stays on your machine

Tars keeps its data in these places:

- **`~/.dorothy/`** (the folder keeps the project's former name). It holds:
  - your settings, including the API keys, bot tokens and passwords you enter (`app-settings.json`);
  - your agents and the last part of each agent's terminal output (`agents.json`, with a backup copy);
  - projects and templates;
  - the kanban tasks of the local board Tars used before 1.8.1, kept as a backup since the board moved to Hermes;
  - the vault: your documents and their attachments (`vault.db`, `vault/`);
  - the chat rooms between agents (`bus.json`), and the files you attach to a room message (`bus-files/`), removed after a week;
  - a usage ledger of tokens and cost per turn (`usage-ledger.jsonl`);
  - a log of what your agents did, per project: commands they ran and file changes, shortened (`observations/`);
  - files received from Telegram (`telegram-downloads/`);
  - the model catalogue cache;
  - Claude rate-limit and token counters;
  - a log of CLI updates;
  - the token that local programs use to talk to Tars.

  At every start, Tars closes this folder to the other accounts on your Mac: the folder and its subfolders can be opened by your user account only, and the files directly in it are readable by your account only.
- **`~/.tars-private/`**: your conversation with the super chat (the fleet overseer), the list of Hermes sessions that conversation was held in, and the Hermes webhook secret. This folder is readable by your user account only, and Tars does not point the agents it starts at it. When an agent searches memory, the super chat's Hermes sessions are left out of what it gets back.
- **`~/.claude/` and your other CLIs' settings.** So that it can follow your agents, Tars adds entries to the configuration of the command-line tools it runs:
  - hooks in `~/.claude/settings.json`, which run in every Claude Code session on your account, including sessions you start outside Tars. They report only to Tars's local address, 127.0.0.1;
  - its own MCP servers, and a "trusted folder" mark for each project folder, in `~/.claude.json`. Tars never marks your home folder, the root of the disk or a folder above your home;
  - hooks in `~/.gemini/settings.json`.

  Claude Code writes its own conversation transcripts in `~/.claude/projects/`. Tars reads them to show usage and past sessions, and does not send them anywhere.
- **Hook logs.** The hooks append agent and session identifiers, tool names and short status lines to `~/.dorothy/logs/hooks.log` and `~/.dorothy/logs/hooks-debug.log`, readable by your account only. Versions before 1.8.0 wrote them to `/tmp/dorothy-hooks.log` and `/tmp/dorothy-hooks-debug.log` instead, and those files stay until you delete them.
- **The app's own browser profile**, in `~/Library/Application Support/Tars/`: window state and interface preferences such as the theme.

Local traffic stays local. Tars listens on 127.0.0.1 only: port 31415 for its hooks and tools, and 31416 for its OpenAI-compatible bridge. It does not accept connections from other machines.

The agents Tars starts run as your user account, so an agent that can run shell commands can read any file your account can read, these folders included.

## What leaves your machine, and to whom

Nothing below happens unless you set it up, except where a sentence says otherwise. Each service receives the data it needs to do what you asked, under its own privacy policy and terms.

- **AI coding CLIs you installed** (Claude Code, Codex, Gemini CLI, Grok, OpenCode, Amp, Pi). Tars starts them in your project folders. Your prompts, your code and their tool output then go to that CLI's vendor, under the account you are signed in with. Tars adds its own instructions to the prompts it sends, such as the agent's name and project. For CLIs other than Claude Code, it also adds a digest of the project's memory.
- **AI providers you add with an API key** (OpenRouter, DeepSeek, Moonshot/Kimi, MiniMax, Xiaomi MiMo, Zhipu, Qwen, Venice, NVIDIA, Nous Portal, Ollama Cloud, or any OpenAI-compatible address you enter). Tars points the Claude Code program at that provider with your key, so prompts, code and tool output go to that provider. For OpenRouter, Tars also sends its name and the address of its source repository as attribution.
- **Delegation over the Agent Client Protocol.** To run a delegated task, Tars downloads and runs the matching adapter package from the npm registry (`npx`).
- **Telegram**, if you turn it on and enter a bot token. Messages you exchange with the bot go through Telegram: the agents' replies, and the files they send. The bot answers only the chats you enrolled with its secret token, and refuses a chat for a while after too many wrong tokens. Messages from other chats are ignored. Before sending the super agent's replies, Tars removes text that looks like an API key or token. Other messages are sent as the agents wrote them. A chat you remove in Settings stops receiving messages at once.
- **Slack**, if you turn it on and enter its tokens. Messages in the workspace the bot is part of, and the agents' replies. The bot answers only the members you list in Settings, and tells anyone else their Slack ID.
- **Discord**, if you turn it on and enter a bot token. Discord delivers to the bot the messages of the channels it can see and the direct messages sent to it. In a server channel, Tars acts only on a message that mentions the bot, unless you turn that requirement off, and only from the members you list in Settings; it does not store the others. It tells anyone else who mentions it or writes to it directly their Discord ID. The agents' replies and the orchestrator's answers go back through Discord as they were written, and every message the bot posts asks Discord to notify nobody. The invite link Tars gives asks Discord to let the bot see channels and send messages, in channels, threads and direct messages, and nothing else.
- **X and SocialData**, if you enter their credentials. Agents can then search through SocialData with your key and, while the Posting switch in Settings is on, post, reply to and delete posts on the X account you connected.
- **Hermes.** Tars talks to the gateway set in Settings > Hermes, and, while none is set, to a gateway at its default address on your own Mac, 127.0.0.1:9119, if one answers there. The gateway receives:
  - your conversation with the super chat, together with a snapshot of the fleet: each agent's name, project, status and recent output, and the files you attach to your messages;
  - the agents' kanban tasks, which live on the Hermes board, and the kanban and scheduling calls you make;
  - memory searches, and the memory notes your agents write there.
- **Memory services** (Honcho, gbrain), if you enable them. Memory notes and searches go to the address you enter.
- **Google Workspace**, if you set up the `gws` tool from Settings. Your agents can then use Gmail, Drive, Calendar, Sheets and Docs through Google, under your authorization.
- **Jira**, if you enter your details. Tars only checks the connection against your Jira site.
- **Claude in Chrome**, if you turn it on. Claude Code can then drive your Chrome browser.
- **models.dev**, and its mirror on GitHub. Tars downloads the public list of models and prices about every six hours. The request carries no personal data beyond your network address.
- **GitHub, for updates.** Tars checks this project's GitHub releases 5 seconds after launch and every 30 minutes. An update is downloaded only when you choose to.
- **Updates of your CLIs.** Every 30 minutes Tars checks for new versions of Claude Code and Amp and installs them when no session is using them: Claude Code through its own updater, Amp through the npm registry. It respects the update opt-outs set in those tools' own configuration. The one Check for updates switch in Settings turns off both this and the check for Tars's own updates.
- **Marketplaces and installs.** Opening the Extensions page reads the public skills.sh catalogue and plugin lists on GitHub. Installing a skill or a plugin downloads it from GitHub or npm.

## The website

The download site is separate from the app.

- **Vercel Web Analytics** measures page views without cookies. Vercel, which hosts the site, processes the request, including your network address, to serve it.
- **The download counter** shows GitHub's own count of release downloads. The site keeps no log of who downloads.
- **Fonts** are served by the site itself.
- **Downloads** come from GitHub Releases, so GitHub serves the file you download.
- The site has no forms, no accounts and no cookies of its own.

## What you control, and how to delete it

- Every integration is off until you set it up. Turn it off, or remove its credentials, in Settings.
- To remove everything Tars stored, quit Tars and delete:
  - `~/.dorothy/` and `~/.tars-private/`;
  - `~/Library/Application Support/Tars/`;
  - from versions before 1.8.0, the hook logs in `/tmp/` (named above).
- To remove Tars's entries from your CLIs:
  - in `~/.claude/settings.json`, delete the hooks whose command points inside the Tars app;
  - in `~/.claude.json`, delete the MCP servers whose names start with `claude-mgr-`, `tars-` or `dorothy-`;
  - in `~/.gemini/settings.json`, delete the hooks Tars added.
- Data that a provider or service received is held by that service. Ask them to delete it, under their terms.

## Changes

If this policy changes, the new version will be published on the website and in the repository, with its date.

## Contact

Cooper Labs, contact@cooperlabs.xyz.
