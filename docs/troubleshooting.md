# Troubleshooting

## Plugin Not Responding After Install

If the connection check fails after a fresh install or reboot, toggle the plugin off and back on in **Settings → Plugins**. This is a [known SP issue](https://github.com/super-productivity/super-productivity/issues/7326) where the `nodeExecution` permission isn't ready when the plugin first loads.

## Connection Issues (General)

1. Ensure Super Productivity is running
2. Verify the MCP Bridge plugin is enabled (Settings → Plugins)
3. Ask your AI assistant: *"Show debug info for Super Productivity"* — this shows the directory paths both sides are using
4. If paths differ between server and plugin, set `SP_MCP_DATA_DIR` (see below)
5. Restart both SP and your MCP client

## macOS — Sandbox Path Mismatch

Super Productivity can use two different shared-data locations on macOS. Native `.app` installs use the normal Application Support path; Mac App Store installs use the container path. The plugin prefers the native path and falls back to the container path, but the MCP server and plugin must ultimately use the same directory:

- Native `.app`: `~/Library/Application Support/super-productivity-mcp`
- Mac App Store sandbox: `~/Library/Containers/com.super-productivity.app/Data/Library/Application Support/super-productivity-mcp`

**Diagnose** — check which directory the plugin is actually writing to:

```bash
ls -lt ~/Library/Application\ Support/super-productivity-mcp/plugin_responses/ | head -5
ls -lt ~/Library/Containers/com.super-productivity.app/Data/Library/Application\ Support/super-productivity-mcp/plugin_responses/ | head -5
```

Whichever has recent files is where the plugin writes. Set `SP_MCP_DATA_DIR` to that path.

## Windows Store — Sandboxed Installs Block IPC

If either Super Productivity or your MCP client (e.g. Claude Desktop) is installed from the **Microsoft Store**, it runs in an app sandbox. The sandbox isolates the filesystem even when directory paths reported by both sides look identical — the plugin and server end up writing to different physical locations, so commands never reach the plugin.

**Symptom:** debug info shows matching paths, everything looks configured correctly, but responses never arrive.

**Fix:** install both Super Productivity and your MCP client as native (non-Store) apps — download installers directly from the vendor instead of the Microsoft Store. Uninstall the Store versions first to avoid leftover sandboxed data directories.

## Setting a Custom Data Directory

Override the auto-detected path via `SP_MCP_DATA_DIR` in your MCP client config:

```json
{
  "mcpServers": {
    "super-productivity": {
      "command": "npx",
      "args": ["-y", "@pir-ahmed-shah/super-productivity-mcp"],
      "env": {
        "SP_MCP_DATA_DIR": "/path/to/super-productivity-mcp"
      }
    }
  }
}
```

Common values:

| Scenario | Path |
|----------|------|
| macOS native `.app` | `~/Library/Application Support/super-productivity-mcp` |
| macOS App Store sandbox | `~/Library/Containers/com.super-productivity.app/Data/Library/Application Support/super-productivity-mcp` |
| Linux (standard) | `~/.local/share/super-productivity-mcp` |
| Linux (Snap) | `~/snap/superproductivity/current/.local/share/super-productivity-mcp` |
| Linux (sandboxed/Flatpak) | `/tmp/super-productivity-mcp` |
| Windows | `%APPDATA%\super-productivity-mcp` |

> **Note:** On Linux, if `~/.local/share` is not writable (e.g. Fedora with restrictive permissions or Flatpak sandboxing), the plugin and server will automatically fall back to `/tmp/super-productivity-mcp`. This directory may be cleared on reboot but works without any configuration.

## Version Mismatch

The MCP server and SP plugin must be on the same version. After updating one, always update the other. To check which versions are running, ask your AI assistant: *"Check the Super Productivity connection"*

## Stale Plugin Symptoms

If tasks behave oddly after plugin writes (mangled titles, silently dropped subtasks, ignored reorders), the deployed `plugin.zip` is older than the latest release. Check the deployed version with *"Check the Super Productivity connection"* (`pluginVersion` in the response), then re-download `plugin.zip` from the [latest release](https://github.com/PirAhmedShah/Super-Productivity-MCP/releases/latest) and upload it in **Settings → Plugins**.

The plugin also hard-requires Super Productivity 18.16.0+ — on older builds every command except `check_connection` fails with a clear version error.
