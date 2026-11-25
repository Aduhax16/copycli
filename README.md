# CopyCLI

One chat for all your coding agents. Claude Code, Codex, Antigravity and other agents share a conversation, a folder and a browser.

> Early version, macOS only for now.

## What it does

- **Continue when one runs out.** If an agent hits its usage limit mid-task, the next one gets the conversation, the unfinished work and the task, and carries on. Automatic, or by hand with "Continue with…".
- **Work together.** `@claude write the HTML @codex write the CSS @antigravity test it` gives each its own task, at the same time, in one chat. `@all` asks everyone.
- **Know about each other.** Each agent is told what the others said and did since it last spoke. While working they can check on teammates, leave notes and claim files. CopyCLI warns when two edit the same file.
- **Share a browser.** A built-in browser that you see and every connected agent can drive: open, read, click, type, scroll, screenshot, console. It asks you per site, and refuses to type into password, code and card fields.
- **Choose models.** Pick each agent's model and effort under the message box or in Settings.
- **Watch usage.** See how much of your limit is used and what each task cost. You are told when a task uses a lot; agents keep working. Pausing them instead is an option in Settings.
- **Keep your approvals.** Plan only, Ask first, Edit files freely, or Full access, per chat.

## Agents

| Agent | How | Status |
| --- | --- | --- |
| Codex | `codex app-server` | Tested with a real account |
| Claude Code | `claude` stream-json | Used with a real account |
| Antigravity | `agy acp` | Used with a real account |
| GitHub Copilot, Cursor, OpenCode, Goose, Qwen Code, Kimi, Grok Build, Cline, Auggie, Kilo, Qoder, Kiro, Devin, Mistral Vibe, Junie, Amp | [Agent Client Protocol](https://agentclientprotocol.com) | Protocol tested with a test agent; launch commands from the ACP registry |
| Your own | Any ACP command, added in Settings | |

CopyCLI runs each vendor's own command-line app with your own sign-in. It never sees or stores your credentials, and has no server or telemetry. Your plan's limits and each vendor's terms apply.

## Install from source

You need [Node.js](https://nodejs.org) 22 or later.

```bash
git clone https://github.com/Aduhax16/copycli.git
cd copycli
npm install
npm run install:mac
```

`npm start` runs it without installing. To update: quit the app, `git pull`, `npm install`, `npm run install:mac`. Chats and settings are kept.

Then open **Settings → Agents** (⌘,) to install agents or sign in.

## Good to know

- Agents run on your computer with your permissions. In Full access they can run anything without asking.
- All agents work in the same folder. File claims are cooperative: they reduce conflicts but do not lock files. Changes made by shell commands are not tracked.
- Web pages can carry text meant to trick agents. The browser asks per site, but read what you approve.
- Codex runs without its own plugins unless you turn them on, and at low effort by default, to use less of your limit.
- If a third-party script or style never answers, the browser loads the page without it.
- The app is not notarized by Apple.

## How it is built

Electron, no runtime dependencies. [src/main/orchestrator.js](src/main/orchestrator.js) runs chats, [src/main/context.js](src/main/context.js) decides what each agent is told, [src/main/agents](src/main/agents) holds one driver per protocol, [src/main/mcp.js](src/main/mcp.js) serves the team and browser tools on localhost with a token per agent, and [src/main/browser.js](src/main/browser.js) is the browser.

```bash
npm test        # unit tests
npm run smoke   # drives the real app
```

Contributions are welcome. Please add a test with a change in behavior. Report security problems privately through GitHub's Security tab.

Not affiliated with Anthropic, OpenAI, Google or any other agent vendor. MIT license.
