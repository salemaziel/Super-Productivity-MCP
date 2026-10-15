---
name: security-hardening-and-validation
description: Workflow command scaffold for security-hardening-and-validation in Super-Productivity-MCP.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /security-hardening-and-validation

Use this workflow when working on **security-hardening-and-validation** in `Super-Productivity-MCP`.

## Goal

Implements security improvements for IPC directory handling, including permission hardening, symlink rejection, and input validation, along with corresponding tests.

## Common Files

- `src/ipc/directories.ts`
- `tests/unit/directories.test.ts`
- `plugin/plugin.js`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Modify src/ipc/directories.ts to add or improve security checks (e.g., permissions, symlink rejection, path validation).
- Update or create validation tests in tests/unit/directories.test.ts to cover new security logic.
- Optionally update plugin/plugin.js if plugin-level changes are needed.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.