# datme for Obsidian

A companion plugin for [datme](https://gitlab.com/dynamo-brain/datme): tend
your digital garden without leaving Obsidian.

- **🌱 Published / 🔒 Private** in the status bar shows whether datme publishes
  the current note; **📝 Draft** and **⏳ date** mark one that waits for its
  `draft` to go or for its `publish_date`. Click it, or run *Publish or
  unpublish the current note*, to flip it. The plugin follows the `publish`
  mode of your `datme.yaml` (or `datme.yml`, `.datme.yaml`).
- **Properties as you write them**: after `style:`, `layout:`, `chrome:`,
  `stage:`, `lang:` or `password:` in a note's frontmatter, the plugin offers
  the values datme takes: its styles, layouts and frames with a line on each,
  the stages and languages of your `datme.yaml`, and the `@group` passwords
  your notes use already. A value datme would not take is underlined with the
  words `datme check` would use, and the status bar counts them (`⚠️ 1`), so
  you see them in the Properties view too.
- **Set style…** and **Set layout…** list every style or layout with a line
  on each, and say which one the note has now and what gives it, as the 🎨
  bar does (`style: in Note.md`, `appearance.folders → Writing`, `the default
  of layout: cv`…). Choosing one writes it in the frontmatter; *Default*
  removes it. On the desktop, ⌘/Ctrl+Enter tries it in the preview pane
  first, without writing anything.
- **Coming up**, on the dashboard, puts the notes scheduled in the next 30
  days on a small calendar: click a day to open its note, or to list its
  notes when it has several. Below it, a word on the deploy pipeline when it
  may not build on their day: a GitHub or Cloudflare workflow of datme's
  without a daily `schedule`, Netlify (builds on push only), or GitLab, whose
  pipeline schedules live in its settings, out of the vault's sight.
- **Schedule this note…** (also in the note's menu) picks a day, and a time
  if you want one, and writes it as `publish_date`; a private note is marked
  published too. A time keeps your computer's time zone (`2026-11-01T09:30:00+07:00`),
  so a build in UTC publishes it at the moment you meant. *Unschedule this
  note* removes the date, so the next build publishes it. datme publishes a
  scheduled note on the first build from its date on: the site needs a daily
  build for it to appear on its day.
- **Copy the public link** of the current note (command palette, the note's
  menu or the editor's) copies its address on the live site, from `site.url`.
  With text selected, the link opens the page on that passage (`#:~:text=`),
  as the site's own share button does. A private, draft or scheduled note has
  no link yet, and the plugin says so.
- **Links to private notes** get a dotted underline and a 🔒 in live preview
  and reading view, since readers won't see them as links. Hover one for what
  the site shows instead under your `privateLinks` (its words as plain text,
  a placeholder, or nothing). A draft or scheduled note's links say so too.
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
- **Tend**, on the dashboard, is the garden's to-do list, oldest first: 🪴
  orphans (no published note links to them) and 🚧 dead ends (they link to
  none) from the last check, ⏳ notes readers see as out of date
  (`outdated.after` in `datme.yaml`), and 🌾 notes still in a fleeting or
  literature stage after 90 days untouched. Click one to open it; *Snooze*
  hides it for a month, *Done* counts as tending it: it comes back once it is
  old again, or once a newer check still finds it. The status bar can count
  them too (*3 notes to tend*), off by default.
- **Show readers' responses to the current note** opens a pane with what
  readers answered: its webmentions (likes and reposts counted, replies and
  mentions in full, the fediverse's and Bluesky's through Bridgy) when
  `datme.yaml` has `webmentions:`, and its giscus comments when it has
  `comments: { provider: giscus }`, newest first, each with a link to answer
  it where it lives. It follows the active note. With the token of your
  webmention.io account, the dashboard also lists the notes readers answer
  most, and the plugin can show a notice for each new webmention.
- **Preview the current note** (also the 🌱 ribbon button) starts `datme dev`
  if it isn't running, then shows the note's page on `localhost` in a pane
  beside the editor. The pane follows the note you open, reloads when the vault
  changes, and scrolls to the heading at the top of the editor. Its toolbar
  switches between light and dark, narrows the page to a phone's width, and
  tries another style, layout or frame on the note (the 🎨 bar's `?style=`,
  `?layout=` and `?chrome=`) without writing anything. *Preview the current
  note in the browser* opens the page there instead. *Stop the preview server*
  ends `datme dev`, as does closing Obsidian.
- **Badges in the file explorer** say what datme does with each note: 🌱
  published, 🔒 private, 📝 draft, ⏳ scheduled, 👁 unlisted; each folder shows
  how many of its notes are published (`3/5`). Right-click a folder, or several
  selected files, for *datme: publish all* or *datme: keep all private*; the
  notes that would change are listed before anything is written.

Checking, previewing and suggesting run the datme command, so they need the
desktop app and [Bun](https://bun.sh) or Node 23.6+.

## On a phone or tablet

The plugin also runs in Obsidian on mobile, with what needs no command:

- whether the current note is published, and flipping it, from the note's menu
  (*datme: publish* or *datme: keep private*) or the command palette;
- the badges in the file explorer, and publishing a folder at once;
- the 🔒 on links to private notes;
- scheduling a note with *Schedule this note…*;
- copying the public link of a note or a passage, its path worked out by the
  plugin as datme does;
- suggesting and checking datme's properties in the frontmatter, and *Set
  style…* / *Set layout…*;
- readers' responses to a note;
- the garden dashboard, its Tend list included, without the link to the
  current note;
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

1. Build it: `bun install && bun run build` in a clone of this repository (or download
   `main.js`, `manifest.json` and `styles.css` from a release).
2. Copy `main.js`, `manifest.json` and `styles.css` into
   `<your vault>/.obsidian/plugins/datme/`.
3. Enable **datme** under Settings → Community plugins.

With [BRAT](https://github.com/TfTHacker/obsidian42-brat), add `dynamotn/obsidian-datme`
instead.

## Settings

- **Command**: how to run datme. The default, `bunx @dynamotn/datme`, needs
  nothing installed but Bun; use `npx @dynamotn/datme` with Node, or the path
  of a global install. Obsidian started from the dock doesn't see your shell's
  `PATH`, so the plugin also looks in `~/.bun/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin` and the shims of mise and asdf.
- **Preview port**: 4321 by default.
- **Badges in the file explorer**: on by default.
- **Mark links to private notes**: on by default.
- **Notes to tend in the status bar**: off by default.
- **Days before a fleeting note asks to be tended**: 90 by default.
- **webmention.io token** (Obsidian 1.11.4 or later): the name of a secret in
  Obsidian's secret storage holding your webmention.io token. The token stays
  out of the vault and its settings.
- **Tell me of new responses**: off by default; every 30 minutes with the token.
- **Show notices**: also list links to unpublished notes in the check report.

## Network

The plugin goes online only for readers' responses, and only when you open
their pane, the dashboard with a token, or turn on the notices:

- `webmention.io` gets the note's address (`api/mentions.jf2?target[]=…`), or
  your token for the whole account;
- `giscus.app` gets your discussions repository, category and the page's
  term (`api/discussions`), as the comment widget on your site does;
- your own site, when giscus finds discussions by `title` or `og:title`: the
  plugin reads the page's title there.

Everything else runs in the vault or through the datme command.

## Development

```bash
bun install
bun run test    # the logic, without Obsidian
bun run check   # type-check against Obsidian's API
bun run build   # main.js
```
