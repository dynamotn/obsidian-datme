# datme for Obsidian

A companion plugin for [datme](https://gitlab.com/dynamo-tools/datme): tend
your digital garden without leaving Obsidian.

- **🌱 Published / 🔒 Private** in the status bar shows whether datme publishes
  the current note. Click it, or run *Publish or unpublish the current note*,
  to flip it. The plugin follows the `publish` mode of your `datme.yaml`.
- **Check the garden for problems** runs `datme check` and lists broken links,
  missing files and invalid frontmatter by note; click a note to open it.
- **Preview the current note** (also the 🌱 ribbon button) starts `datme dev`
  if it isn't running, then opens the note as the site will show it. *Stop the
  preview server* ends it, as does closing Obsidian.

The plugin runs the datme command, so it's for desktop only and needs
[Bun](https://bun.sh) or Node 23.6+.

## Install

Until it's in the community directory:

1. Build it: `bun install && bun run build` in this folder (or download
   `main.js` and `manifest.json` from a release).
2. Copy `main.js` and `manifest.json` into
   `<your vault>/.obsidian/plugins/datme/`.
3. Enable **datme** under Settings → Community plugins.

With [BRAT](https://github.com/TfTHacker/obsidian42-brat), add this repository
instead.

## Settings

- **Command**: how to run datme. The default, `bunx @dynamotn/datme`, needs
  nothing installed but Bun; use `npx @dynamotn/datme` with Node, or the path
  of a global install. Obsidian started from the dock doesn't see your shell's
  `PATH`, so the plugin also looks in `~/.bun/bin`, `/opt/homebrew/bin` and
  `/usr/local/bin`.
- **Preview port**: 4321 by default.
- **Show notices**: also list links to unpublished notes in the check report.

## Development

```bash
bun install
bun run test    # the logic, without Obsidian
bun run check   # type-check against Obsidian's API
bun run build   # main.js
```
