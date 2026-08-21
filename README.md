<h1 align="center">∿ PyCode <img src="https://shieldcn.dev/badge/version-v0.9.8.82%20beta.svg?variant=secondary" alt="Version"></h1>

<p align="center">
  <a href="https://github.com/j5onrf/pycode"><img src="https://shieldcn.dev/github/last-commit/j5onrf/pycode.svg?color=emerald&variant=secondary" alt="Last Commit"></a>
  <a href="https://github.com/j5onrf/pycode"><img src="https://shieldcn.dev/badge/TypeScript.svg?variant=branded&brand=typescript" alt="TypeScript"></a>
  <a href="https://github.com/j5onrf/pycode"><img src="https://shieldcn.dev/badge/Electron.svg?variant=branded&brand=electron" alt="Electron"></a>
  <a href="https://github.com/j5onrf/pycode"><img src="https://shieldcn.dev/badge/React.svg?variant=branded&brand=react" alt="React"></a>
  <a href="https://github.com/j5onrf/pycode/blob/main/LICENSE"><img src="https://shieldcn.dev/badge/license-MIT-green.svg" alt="License"></a>
</p>

<p align="center">
  <b>Fast Native Desktop & Web Development GUI for <a href="https://github.com/j5onrf/py-agent">Py-Agent</a></b><br>
  Powered by the Agent Client Protocol (ACP) over stdio JSON-RPC.
</p>

---

<h2 align="center">Overview</h2>

**PyCode** is a native Electron and Web IDE for **Py-Agent**, forked from [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code).

- **Native ACP Protocol:** Speaks stdio JSON-RPC 2.0 directly to `py-agent` with zero daemon overhead.
- **Thought Formatting:** Renders reasoning and thought processes into clean markdown quote blocks (`> *Thinking...*`).
- **CLI Suspension:** Launch `/pyc` from terminal to pause CLI and resume automatically on window close.
- **Dual Execution:** Runs as an Electron Desktop app or local browser WebUI (`http://localhost:3773`).
- **Active Development:** New features and agent capabilities actively being added.

---

<h2 align="center">Desktop APP</h2>

<div align="center">
  <kbd>
    <img width="800" alt="PyCode GUI Desktop GUI" src="https://github.com/user-attachments/assets/ed6c6aee-cf05-4270-a276-3e35270bed00" />
  </kbd>
</div>

---

<h2 align="center">Architecture & ACP Flow</h2>

```
  ┌────────────────────────────────────────────────────────┐
  │                   PyCode GUI (Electron)                │
  │     [React UI] ◄──► [PyAgentAdapter] ◄──► [ACP Client] │
  └───────────────────────────┬────────────────────────────┘
                              │ stdio JSON-RPC 2.0 (ACP)
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │                 Py-Agent Headless Bridge               │
  │     [plugins/pycode/bridge.py] ◄──► [agent_core.py]    │
  └───────────────────────────┬────────────────────────────┘
                              │ HTTP SSE / Tools
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │           llama-server / Cloud API Cascade             │
  │    (LFM2.5-8B, Qwen3.6-35B, DeepSeek, Claude, GPT)     │
  └────────────────────────────────────────────────────────┘
```

---

<h2 align="center">Key Features</h2>

| Feature                 | Description                                                                                     |
| :---------------------- | :---------------------------------------------------------------------------------------------- |
| **Minimal Interface**   | Stripped top-bar branding for a clean, distraction-free workspace.                              |
| **Custom Vector Icon**  | Integrated 18px line-art interlocking Python loop matching native OpenAI/Claude visual density. |
| **ACP Provider Driver** | First-party `pyagent` driver registered across server, contracts, and frontend layers.          |
| **Thought Traces**      | Formats model reasoning and thinking into clean markdown quote blocks (`> *Thinking...*`).      |
| **Dynamic Workspaces**  | Automatically syncs project roots, AST codebase maps (`index-map`), and `.agent/tpm.md` facts.  |
| **Fast CLI Shortcuts**  | Launch directly from `py-agent` with `/pyc` or `/pycode` (desktop) and `/pyc web` (browser).    |

---

<h2 align="center">Upstream Fork Manifest</h2>

All modifications are isolated to ensure updates from [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) merge cleanly:

| Layer                | File Path                                           | Modification Summary                                                   |
| :------------------- | :-------------------------------------------------- | :--------------------------------------------------------------------- |
| **Driver**           | `apps/server/src/provider/Drivers/PyAgentDriver.ts` | Registered `PyAgentDriver`, snapshot metadata, & reasoning options     |
| **Adapter**          | `apps/server/src/provider/Layers/PyAgentAdapter.ts` | Effect ACP session lifecycle, scope isolation, & `item.started` events |
| **Runtime**          | `apps/server/src/provider/acp/PyAgentAcpSupport.ts` | Process spawner for `plugins/pycode/bridge.py`                         |
| **Drivers Registry** | `apps/server/src/provider/builtInDrivers.ts`        | Added `PyAgentDriver` to `BUILT_IN_DRIVERS`                            |
| **Brand Chrome**     | `apps/web/src/components/sidebar/SidebarChrome.tsx` | Clean zero-branding top sidebar                                        |
| **Vector Icons**     | `apps/web/src/components/Icons.tsx`                 | Flat monochrome `PyAgentIcon` vector component                         |
| **Icon Mapping**     | `apps/web/src/components/chat/providerIconUtils.ts` | Mapped `pyagent` driver keys to `PyAgentIcon`                          |
| **Global Brand**     | `apps/web/src/branding.ts`                          | Updated default fallback display name                                  |
| **Contracts**        | `packages/contracts/src/model.ts`                   | Declared `PYAGENT_DRIVER_KIND` & `local-model` defaults                |
| **Contracts**        | `packages/contracts/src/settings.ts`                | Added `PyAgentSettings` schema & settings registry                     |

---

<h2 align="center">Setup & Installation</h2>

### Prerequisites

- **Node.js**: `v20+` or `v22+`
- **pnpm**: `v9+` (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Python 3.10+** (with [`py-agent`](https://github.com/j5onrf/py-agent) configured)

```bash
# Automatic setup (if using py-agent)
install-pycode
# (or run: ~/.config/py-agent/plugins/pycode/setup.sh)

# Or clone & build manually
git clone https://github.com/j5onrf/pycode.git ~/.config/pycode
cd ~/.config/pycode
pnpm install
pnpm build
```

---

<h2 align="center">Launching PyCode</h2>

| Launch Method               | Command                                           | Description                                        |
| :-------------------------- | :------------------------------------------------ | :------------------------------------------------- |
| **From Py-Agent CLI**       | `/pyc` (or `/pycode`)                             | Suspends CLI and opens native Electron Desktop GUI |
| **From Py-Agent CLI (Web)** | `/pyc web`                                        | Suspends CLI and opens WebUI in default browser    |
| **Direct Shell (Desktop)**  | `~/.config/py-agent/plugins/pycode/launch.sh`     | Launches Electron GUI for current directory        |
| **Direct Shell (Web)**      | `~/.config/py-agent/plugins/pycode/launch.sh web` | Starts WebUI server on `http://localhost:3773`     |

---

<h2 align="center">License</h2>

Distributed under the [MIT License](LICENSE). Built for the [`py-agent`](https://github.com/j5onrf/py-agent) ecosystem.
