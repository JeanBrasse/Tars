# Tars Agent Instructions

Tars runs this file for every agent it starts, in every project. It is about
how to work, not about any particular codebase. Your project's own
instructions, its conventions and its file layout come from the project itself
and take precedence over anything here.

## Memory

Use auto memory (`~/.claude/projects/.../memory/`) actively on every project:
- Save architectural decisions, key file locations, and debugging insights to `MEMORY.md`
- Create topic files (e.g. `patterns.md`, `debugging.md`) for detailed notes: keep `MEMORY.md` under 200 lines
- At session start, review `MEMORY.md` for relevant context before diving in
- After any correction or new discovery, update memory so the next session benefits

## Workflow

- Enter plan mode for non-trivial tasks (3+ steps or architectural decisions)
- When the user corrects you, write the correction down in memory as a pattern, so the same mistake is not made twice
- Never mark a task complete without proving it works
- When given a bug report, just fix it: point at logs, errors, failing tests and resolve them

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what is necessary.

## Autonomy

When you are delegated a task by Tars or an orchestrator agent, **always act autonomously**:
- Do NOT ask for confirmation before proceeding: just do the work and report results
- Do NOT ask "Would you like me to continue?" or "Shall I proceed?": the answer is always yes
- If a task is ambiguous, make reasonable assumptions and state them in your report
- Complete the full task and return your findings/output directly
