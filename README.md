# datme for Obsidian

A companion plugin for [datme](https://gitlab.com/dynamo-tools/datme): tend
your digital garden without leaving Obsidian.

- **🌱 Published / 🔒 Private** in the status bar shows whether datme publishes
  the current note. Click it, or run *Publish or unpublish the current note*,
  to flip it. The plugin follows the `publish` mode of your `datme.yaml`.
- **Check the garden for problems** runs `datme check` and lists broken links,
  missing files and invalid frontmatter by note; click a note to open it.
- **Show link suggestions** opens a pane beside the note you're writing. It
  lists the published notes related to it (shared tags and links, and
  closeness in meaning with `related.semantic`), and the places where the note
  names a published note without linking to it. *Link* turns such a mention
  into `[[Note|words]]` in place. The pane follows the active note and
  refreshes each time it's saved.
- **Open the garden dashboard** shows the garden at a glance in the sidebar:
  how many notes are published (and unlisted), private, drafts or scheduled,
  with the dates of the scheduled ones; the errors, warnings and notices of the
  last check, and how old it is; and links to the site (`site.url`) and to the
  current note on it.
- **Preview the current note** (also the 🌱 ribbon button) starts `datme dev`
  if it isn't running, then opens the note as the site will show it. *Stop the
  preview server* ends it, as does closing Obsidian.

Checking, previewing and suggesting run the datme command, so they need the
desktop app and [Bun](https://bun.sh) or Node 23.6+.

## On a phone or tablet

The plugin also runs in Obsidian on mobile, with what needs no command:

- whether the current note is published, and flipping it, from the note's menu
  (*datme: publish* or *datme: keep private*) or the command palette;
- the garden dashboard, without the link to the current note;
- the last check report. Each check on a computer saves it in
  `.datme/check.json` (the *Save the check report* setting), so it reaches
  the phone with the rest of the vault. CI can write it too:

  ```bash
  datme check --json > .datme/check.json || true
  ```

  *Check the garden for problems* shows that report on a phone, with how old
  it is; *Show the last saved check report* does on a computer.

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
