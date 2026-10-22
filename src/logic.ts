/**
 * What the plugin decides without Obsidian: whether a note is published, how
 * to toggle it, how to run the datme command and read its answers.
 */

export type PublishMode = "explicit" | "all"

const flag = (v: unknown) => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined)

/** Whether datme publishes a note with this frontmatter, as it decides it (drafts and schedules aside). */
export function isPublished(fm: Record<string, unknown> | undefined, mode: PublishMode): boolean {
  const publish = flag(fm?.publish)
  return mode === "explicit" ? publish === true : publish !== false
}

/** The `publish` value that flips a note's state; undefined means removing the key. */
export function toggledPublish(fm: Record<string, unknown> | undefined, mode: PublishMode): boolean | undefined {
  const now = isPublished(fm, mode)
  if (mode === "explicit") return now ? undefined : true
  return now ? false : undefined
}

/**
 * The program and leading arguments of the configured command, such as
 * `bunx @dynamotn/datme` or `/opt/homebrew/bin/datme`. Quotes group words.
 */
export function splitCommand(command: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * PATH for the command: apps started from the dock don't inherit the shell's
 * PATH, so the usual places of bun, node and npm-installed tools are added,
 * version managers' shims included.
 */
export function augmentedPath(path: string | undefined, home: string): string {
  // mise and asdf install bun and node behind shims, which a shell adds to PATH when it starts.
  const extra = [`${home}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.local/share/mise/shims`, `${home}/.asdf/shims`]
  const parts = (path ?? "").split(":").filter(Boolean)
  return [...parts, ...extra.filter((p) => !parts.includes(p))].join(":")
}

export interface Problem {
  level: "error" | "warning" | "info"
  file: string
  message: string
  url?: string
}

export interface CheckResult {
  counts: { error: number; warning: number; info: number }
  problems: Problem[]
}

/** The JSON of `datme check --json`, which may follow lines the command printed first. */
export function parseCheck(stdout: string): CheckResult {
  const start = stdout.indexOf('{"counts"')
  if (start < 0) throw new Error("datme did not answer with a check report")
  const data = JSON.parse(stdout.slice(start)) as CheckResult
  if (!data.counts || !Array.isArray(data.problems)) throw new Error("datme did not answer with a check report")
  return data
}

/** Problems by file, files with errors first, notices last. */
export function groupProblems(problems: Problem[], withInfo = false): [string, Problem[]][] {
  const rank = { error: 0, warning: 1, info: 2 }
  const byFile = new Map<string, Problem[]>()
  for (const p of problems) {
    if (p.level === "info" && !withInfo) continue
    byFile.set(p.file, [...(byFile.get(p.file) ?? []), p])
  }
  const worst = (ps: Problem[]) => Math.min(...ps.map((p) => rank[p.level]))
  return [...byFile.entries()]
    .map(([file, ps]) => [file, ps.sort((a, b) => rank[a.level] - rank[b.level])] as [string, Problem[]])
    .sort((a, b) => worst(a[1]) - worst(b[1]) || a[0].localeCompare(b[0]))
}

/** One line for the notice after a check. */
export function summary(counts: CheckResult["counts"]): string {
  const parts = [
    counts.error && `${counts.error} error${counts.error === 1 ? "" : "s"}`,
    counts.warning && `${counts.warning} warning${counts.warning === 1 ? "" : "s"}`,
  ].filter(Boolean)
  return parts.length ? parts.join(", ") : "no problems"
}

/** The preview address of a page path printed by `datme url`: its last line, after anything printed before. */
export function previewUrl(port: number, pagePath: string): string {
  const page = pagePath.trim().split("\n").pop()!.trim()
  return `http://localhost:${port}${page.startsWith("/") ? "" : "/"}${page}`
}

export interface Related {
  file: string
  title: string
  url: string
  score: number
  tags: string[]
  links: number
  similarity?: number
}

export interface Mention {
  file: string
  title: string
  /** The words as written in the note. */
  text: string
  /** Where they start in the file, in characters. */
  offset: number
  line: number
}

export interface Suggestions {
  file: string
  published: boolean
  related: Related[]
  mentions: Mention[]
}

/** The JSON of `datme related --json`, which may follow lines the command printed first. */
export function parseSuggestions(stdout: string): Suggestions {
  const start = stdout.indexOf('{"file"')
  if (start < 0) throw new Error("datme did not answer with suggestions")
  const data = JSON.parse(stdout.slice(start)) as Suggestions
  if (!Array.isArray(data.related) || !Array.isArray(data.mentions)) throw new Error("datme did not answer with suggestions")
  return data
}

/**
 * The wikilink replacing a mention, with the words as written when they differ
 * from its target: by file name, or by the link text Obsidian gives the file,
 * which carries enough of its path when another note shares its name.
 */
export function mentionLink(m: Pick<Mention, "file" | "text">, linktext = m.file.split("/").pop()!.replace(/\.md$/i, "")): string {
  return m.text === linktext ? `[[${linktext}]]` : `[[${linktext}|${m.text}]]`
}

/**
 * Where a mention starts in `text`, if its words are still there. datme counts
 * the \r of a CRLF file, which the editor drops: one character per line before.
 */
export function locate(text: string, m: Pick<Mention, "text" | "offset" | "line">): number | undefined {
  for (const at of [m.offset, m.offset - (m.line - 1)]) if (at >= 0 && text.slice(at, at + m.text.length) === m.text) return at
  return undefined
}

/** Why a note is related, in a few words. */
export function relatedWhy(r: Related): string {
  return [
    r.tags.map((t) => "#" + t).join(" "),
    r.links ? `${r.links} shared link${r.links === 1 ? "" : "s"}` : "",
    r.similarity ? `≈ ${Math.round(r.similarity * 100)}%` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** How long ago a time was, in the largest whole unit: "just now", "5 minutes ago", "2 days ago". */
export function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  const units: [string, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ]
  for (const [name, size] of units) {
    const n = Math.floor(s / size)
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`
  }
  return "just now"
}

export type PrivateLinks = "text" | "placeholder" | "hide"

/** What the plugin needs of datme.yaml, parsed by Obsidian's YAML reader. */
export interface GardenConfig {
  mode: PublishMode
  /** Public URL of the site, without a trailing slash. */
  url?: string
  /** Folders datme never reads, its own ones included. */
  ignore: string[]
  /** The garden's languages, the default first. */
  languages: string[]
  /** The stages of `stages:`, by key, with their label. */
  stages: { name: string; label: string }[]
  /** What the site shows for a link to a note it does not publish. */
  privateLinks: PrivateLinks
  /** A theme pack (`theme.preset`), which may add styles of its own. */
  preset?: string
  /** Which style notes get when they name none: `appearance:`. */
  appearance: Appearance
  /** The note that is the home page, `index.md` unless set. */
  home: string
}

export interface Appearance {
  /** The site's style, `notebook` unless set. */
  style: string
  /** Style by folder, path without slashes at the ends. */
  folders: Record<string, string>
  /** Folders in the other of classic and notebook (the older form of `folders`). */
  classic: string[]
  /** Style by tag, without # and in lower case, spaces as dashes. */
  tags: Record<string, string>
  stages: Record<string, string>
  /** Style by language tag or its base (`vi`). */
  languages: Record<string, string>
  /** Styles for days of the year, MM-DD to MM-DD, both included. */
  schedule: { style: string; from: string; to: string }[]
}

/** `home:` names a note, or is `{ note }`; `bento` draws the home page, so index.md is no page then. */
function homeOf(raw: unknown): string {
  const note = typeof raw === "string" ? (raw === "bento" ? "index.md" : raw) : typeof record(raw).note === "string" ? String(record(raw).note) : "index.md"
  return note.replace(/^\/+/, "") || "index.md"
}

function appearanceOf(raw: unknown): Appearance {
  const a = record(raw)
  const styles = (v: unknown) =>
    Object.fromEntries(Object.entries(record(v)).filter((e): e is [string, string] => typeof e[1] === "string").map(([k, v]) => [k, v.trim().toLowerCase()]))
  const trimSlashes = (k: string) => k.replace(/^\/+|\/+$/g, "")
  return {
    style: typeof a.style === "string" && a.style ? a.style.trim().toLowerCase() : "notebook",
    folders: Object.fromEntries(Object.entries(styles(a.folders)).map(([k, v]) => [trimSlashes(k), v])),
    classic: Array.isArray(a.classic) ? a.classic.map((k) => trimSlashes(String(k))) : [],
    tags: Object.fromEntries(Object.entries(styles(a.tags)).map(([k, v]) => [slugTag(k), v])),
    stages: styles(a.stages),
    languages: styles(a.languages),
    schedule: Array.isArray(a.schedule)
      ? a.schedule
          .map(record)
          .filter((e) => typeof e.style === "string" && typeof e.from === "string" && typeof e.to === "string")
          .map((e) => ({ style: String(e.style).trim().toLowerCase(), from: String(e.from), to: String(e.to) }))
      : [],
  }
}

/** A tag as datme compares them: without #, in lower case, spaces as dashes. */
export function slugTag(tag: string): string {
  return tag.replace(/^#/, "").trim().replace(/\s+/g, "-").toLowerCase()
}

const DEFAULT_IGNORE = [".git", ".obsidian", ".trash", "node_modules", "private", "templates"]

const STAGE_PRESETS: Record<string, string> = { fleeting: "🌱 Fleeting", literature: "📖 Literature", permanent: "🌳 Permanent" }

const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>

export function gardenConfig(parsed: unknown): GardenConfig {
  const c = record(parsed)
  const site = record(c.site)
  const theme = record(c.theme)
  const ignore = Array.isArray(c.ignore) ? c.ignore.map((p) => String(p).replace(/^\/+|\/+$/g, "")) : []
  const languages = Array.isArray(c.languages) ? c.languages.filter((l): l is string => typeof l === "string" && l.length >= 2) : []
  const stages = Object.entries(record(c.stages)).map(([name, v]) => {
    const preset = typeof v === "string" ? STAGE_PRESETS[v.toLowerCase()] : undefined
    const label = preset ?? (typeof v === "string" ? v : typeof record(v).label === "string" ? String(record(v).label) : name.replace(/^[\d._-]+/, ""))
    return { name, label }
  })
  return {
    mode: c.publish === "all" ? "all" : "explicit",
    url: typeof site.url === "string" && site.url ? site.url.replace(/\/+$/, "") : undefined,
    ignore: [...DEFAULT_IGNORE, ...ignore],
    languages: languages.length ? languages : ["en-US"],
    stages,
    privateLinks: c.privateLinks === "placeholder" || c.privateLinks === "hide" ? c.privateLinks : "text",
    preset: typeof theme.preset === "string" && theme.preset ? theme.preset : undefined,
    appearance: appearanceOf(c.appearance),
    home: homeOf(c.home),
  }
}

export interface GardenCounts {
  /** Published now, unlisted ones included. */
  published: number
  unlisted: number
  private: number
  /** Marked `draft: true`, published once that goes. */
  drafts: number
  /** Waiting for their `publish_date`, soonest first. */
  scheduled: { path: string; date: string }[]
}

/** What datme does with a note today: publishes it, keeps it private, or holds it as a draft or until its publish_date. */
export function noteState(fm: Record<string, unknown> | undefined, mode: PublishMode, now: Date): { state: "published" | "private" | "draft" | "scheduled"; date?: string } {
  if (!isPublished(fm, mode)) return { state: "private" }
  if (flag(fm?.draft) === true) return { state: "draft" }
  const at = fm?.publish_date ?? fm?.publishDate
  const date = at == null || at === "" ? undefined : new Date(String(at))
  if (date && !Number.isNaN(date.getTime()) && date > now) return { state: "scheduled", date: date.toISOString().slice(0, 10) }
  return { state: "published" }
}

/** Whether datme never reads a file: in a hidden folder, or one the config ignores. */
export function isIgnored(path: string, config: Pick<GardenConfig, "ignore">): boolean {
  const lower = path.toLowerCase()
  return (
    path.split("/").some((part) => part.startsWith(".")) ||
    config.ignore.some((ig) => {
      const i = ig.toLowerCase()
      return lower === i || lower.startsWith(i + "/")
    })
  )
}

/** How many notes datme publishes, keeps private, holds as drafts or schedules, as it decides it. */
export function gardenCounts(notes: { path: string; fm?: Record<string, unknown> }[], config: GardenConfig, now: Date): GardenCounts {
  const counts: GardenCounts = { published: 0, unlisted: 0, private: 0, drafts: 0, scheduled: [] }
  for (const { path, fm } of notes) {
    if (isIgnored(path, config)) continue
    const { state, date } = noteState(fm, config.mode, now)
    if (state === "private") counts.private++
    else if (state === "draft") counts.drafts++
    else if (state === "scheduled") counts.scheduled.push({ path, date: date! })
    else {
      counts.published++
      if (flag(fm?.unlisted) === true) counts.unlisted++
    }
  }
  counts.scheduled.sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path))
  return counts
}

/** The heading a reader is under at a line of the note: the last one starting at or before it. */
export function headingAt(headings: { heading: string; level: number; line: number }[], line: number): { heading: string; level: number } | undefined {
  let found: { heading: string; level: number } | undefined
  for (const h of headings) if (h.line <= line) found = { heading: h.heading, level: h.level }
  return found
}

/** The words of a heading as the page shows them: links by their text, without emphasis marks. */
export function headingText(heading: string): string {
  return heading
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]*)\]\]/g, (_, target: string) => target.split("#").pop()!.split("/").pop()!)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~=`]/g, "")
    .trim()
}

export type Badge = "published" | "private" | "draft" | "scheduled" | "unlisted"

/** The badge of a note in the file explorer: its state, and unlisted for a published note kept off the lists. */
export function badgeOf(fm: Record<string, unknown> | undefined, mode: PublishMode, now: Date): Badge {
  const { state } = noteState(fm, mode, now)
  return state === "published" && flag(fm?.unlisted) === true ? "unlisted" : state
}

export const BADGE_ICONS: Record<Badge, string> = { published: "🌱", private: "🔒", draft: "📝", scheduled: "⏳", unlisted: "👁" }

/** For each folder of the vault, how many of the notes datme reads under it it publishes now. */
export function folderCounts(notes: { path: string; fm?: Record<string, unknown> }[], config: GardenConfig, now: Date): Map<string, { published: number; total: number }> {
  const out = new Map<string, { published: number; total: number }>()
  for (const { path, fm } of notes) {
    if (isIgnored(path, config)) continue
    const state = noteState(fm, config.mode, now).state
    const parts = path.split("/").slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/")
      const c = out.get(folder) ?? { published: 0, total: 0 }
      c.total++
      if (state === "published") c.published++
      out.set(folder, c)
    }
  }
  return out
}

/**
 * The `publish` value that makes datme publish a note (or keep it private), or
 * "keep" when it already does. undefined means removing the key, when the
 * publish mode does that by default.
 */
export function publishFor(fm: Record<string, unknown> | undefined, mode: PublishMode, publish: boolean): boolean | undefined | "keep" {
  return isPublished(fm, mode) === publish ? "keep" : toggledPublish(fm, mode)
}

export interface Choice {
  value: string
  description: string
}

/** The styles datme has, as src/site.config.ts lists them, each in a line of docs/themes.md. */
export const STYLES: Choice[] = [
  { value: "notebook", description: "Index cards on dotted paper; the default" },
  { value: "classic", description: "A quiet serif blog" },
  { value: "garden", description: "Notes as plants in a bed, sized by how grown they are" },
  { value: "resume", description: "A single page, a CV" },
  { value: "darkroom", description: "A gallery of pictures; opens dark" },
  { value: "terminal", description: "A monospace TTY in green phosphor; opens dark" },
  { value: "blueprint", description: "Grid paper, mono lettering and drawing sheets; opens dark" },
  { value: "wiki", description: "A dense reference page with an infobox of the note's properties" },
  { value: "broadsheet", description: "A newspaper: the home a front page, each top folder a section" },
  { value: "herbarium", description: "Each note a pressed specimen sheet with its label card" },
  { value: "manuscript", description: "A book page for long reading, notes in its margin" },
  { value: "lacquer", description: "Black lacquer, vermilion and gold leaf; opens dark" },
  { value: "zine", description: "A self-printed zine on grainy photocopy paper" },
  { value: "atlas", description: "An old atlas on parchment; each top folder a region" },
  { value: "catalog", description: "A library card catalogue: each note a typed card" },
  { value: "eink", description: "An e-reader's page: greys only, nothing moving, large type" },
  { value: "paddy", description: "The garden as terraced rice fields" },
]

/** The layouts of src/lib/vault.ts: for a note's own text, then collections that list other notes. */
export const LAYOUTS: (Choice & { collection?: true })[] = [
  { value: "cv", description: "A résumé: the title is your name" },
  { value: "gallery", description: "Embedded pictures become a gallery" },
  { value: "timeline", description: "Each ## heading a moment on a line down the page" },
  { value: "links", description: "A page of links, as in a link-in-bio" },
  { value: "uses", description: "What you work with" },
  { value: "now", description: "What you are doing now" },
  { value: "faq", description: "Each ## heading a question that opens on its answer" },
  { value: "quotes", description: "Quotes become a wall of cards" },
  { value: "paper", description: "An academic paper, with authors and abstract" },
  { value: "decision", description: "An architecture decision record" },
  { value: "changelog", description: "Each ## heading a version" },
  { value: "dialogue", description: "An interview, podcast notes or a play" },
  { value: "highlights", description: "Reading notes as Readwise or Kindle export them" },
  { value: "glossary", description: "Definitions A–Z" },
  { value: "trip", description: "A travel journal: each ## heading a day or a stop" },
  { value: "syllabus", description: "A course: each ## heading a lesson" },
  { value: "poem", description: "Verse, centred, its lines kept" },
  { value: "letter", description: "A letter on a sheet of paper" },
  { value: "compare", description: "Options side by side: each ## heading an option" },
  { value: "checklist", description: "Every task of the note a box readers can tick" },
  { value: "recipe-card", description: "One recipe as an A6 index card" },
  { value: "hub", description: "A map of content drawn round the note" },
  { value: "lore", description: "A character, place or faction of a world you build" },
  { value: "projects", description: "Collection: a card for each project", collection: true },
  { value: "books", description: "Collection: a shelf of covers", collection: true },
  { value: "movies", description: "Collection: a shelf of posters", collection: true },
  { value: "talks", description: "Collection: a row for each talk", collection: true },
  { value: "recipes", description: "Collection: a card for each recipe", collection: true },
  { value: "places", description: "Collection: a map of places over their cards", collection: true },
  { value: "shelf", description: "Collection: a shelf of anything else", collection: true },
  { value: "daily", description: "Collection: a journal with a calendar of the year", collection: true },
  { value: "bookmarks", description: "Collection: a reading list of clipped pages", collection: true },
  { value: "people", description: "Collection: a grid of faces", collection: true },
  { value: "snippets", description: "Collection: code snippets or things learned", collection: true },
  { value: "episodes", description: "Collection: a podcast or a newsletter", collection: true },
  { value: "courses", description: "Collection: courses taken, taking or to take", collection: true },
  { value: "wishlist", description: "Collection: things you would like to get", collection: true },
  { value: "quotebook", description: "Collection: every quote of the listed notes", collection: true },
  { value: "questions", description: "Collection: open questions", collection: true },
  { value: "digest", description: "Collection: a weekly digest of the garden", collection: true },
]

export const CHROMES: Choice[] = [
  { value: "full", description: "The whole frame: header, sidebar and footer" },
  { value: "minimal", description: "Only the page" },
]

/** datme matches style, chrome and layout trimmed and in lower case. */
const pick = (v: unknown) => String(v).trim().toLowerCase()

/** The frontmatter keys whose values the plugin knows. */
export const KNOWN_PROPERTIES = ["style", "layout", "chrome", "stage", "lang", "password"] as const
export type KnownProperty = (typeof KNOWN_PROPERTIES)[number]

/** The values a property can take in this garden; groups are the `@group` passwords already used in the vault. */
export function propertyChoices(key: KnownProperty, config: GardenConfig, groups: string[] = []): Choice[] {
  switch (key) {
    case "style":
      return STYLES
    case "layout":
      return LAYOUTS
    case "chrome":
      return CHROMES
    case "stage":
      return config.stages.map((s) => ({ value: s.name, description: s.label }))
    case "lang":
      return config.languages.map((l, i) => ({ value: l, description: i === 0 ? "The default language" : "" }))
    case "password":
      return [...new Set(groups)].sort().map((g) => ({ value: g, description: `Password from DATME_LOCK_${lockVariable(g)}` }))
  }
}

/** The variable part of the environment variable holding a group's password: `@close-friends` → CLOSE_FRIENDS. */
export function lockVariable(group: string): string {
  return group
    .replace(/^@/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
}

/**
 * What is wrong with a property's value, in datme check's words where it has
 * some, or undefined when datme takes it. A value that is not text is left to
 * datme, as are styles when a theme pack may add its own.
 */
export function propertyProblem(key: string, value: unknown, config: GardenConfig): string | undefined {
  if (value === null || value === undefined || value === "") return undefined
  if (key === "style") {
    if (config.preset || STYLES.some((s) => s.value === pick(value))) return undefined
    return `style "${value}" is not one of ${STYLES.map((s) => s.value).join(", ")}, so the note keeps its usual style`
  }
  if (key === "layout") {
    if (LAYOUTS.some((l) => l.value === pick(value))) return undefined
    return `layout "${value}" is not one of ${LAYOUTS.map((l) => l.value).join(", ")}, so the note is laid out as usual`
  }
  if (key === "chrome") {
    if (CHROMES.some((c) => c.value === pick(value))) return undefined
    return `chrome "${value}" is not one of ${CHROMES.map((c) => c.value).join(", ")}, so the note keeps its usual frame`
  }
  if (key === "stage" && typeof value === "string") {
    if (config.stages.some((s) => s.name === value)) return undefined
    return config.stages.length
      ? `stage "${value}" is not one of ${config.stages.map((s) => s.name).join(", ")} in datme.yaml, so datme ignores it`
      : `stage "${value}" is ignored: datme.yaml has no stages`
  }
  if (key === "lang" && typeof value === "string") {
    if (config.languages.includes(value)) return undefined
    return `lang "${value}" is not one of ${config.languages.join(", ")}, so the note is in ${config.languages[0]}`
  }
  if (key === "password" && typeof value === "string" && value.startsWith("@") && !/^@[\w-]+$/.test(value)) {
    return `password "${value}" is not a group name (@ then letters, digits, _ or -), so it is used as the password itself`
  }
  return undefined
}

/** Where a frontmatter line names a property: the key and where its value starts and ends. */
export function propertyLine(line: string): { key: string; from: number; to: number; value: string } | undefined {
  const m = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*/.exec(line)
  if (!m) return undefined
  let value = line.slice(m[0].length)
  const comment = value.search(/\s#/)
  if (comment >= 0) value = value.slice(0, comment)
  value = value.trimEnd()
  let from = m[0].length
  let to = from + value.length
  const quoted = /^(["'])(.*)\1$/.exec(value)
  if (quoted) {
    from++
    to--
    value = quoted[2]
  }
  return { key: m[1], from, to, value }
}

/**
 * A script for the page: scroll to the heading with these words, or to the top.
 * Headings are matched by their text, which datme keeps, rather than by an id
 * whose rules could drift.
 */
export function scrollScript(heading: string | undefined): string {
  return `(() => {
  const want = ${JSON.stringify(heading ?? null)}
  if (want === null) return window.scrollTo({ top: 0, behavior: "smooth" })
  const norm = (s) => s.replace(/\\s+/g, " ").replace(/[#¶§🔗]+$/u, "").trim().toLowerCase()
  const target = norm(want)
  const h = [...document.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6, h1, h2, h3, h4, h5, h6")]
    .find((el) => norm(el.textContent || "") === target)
  h?.scrollIntoView({ behavior: "smooth", block: "start" })
})()`
}

/** The line that closes a note's frontmatter, or undefined when it has none. Line 0 opens it. */
export function frontmatterEnd(lineAt: (n: number) => string, lines: number): number | undefined {
  if (lines < 2 || lineAt(0).trimEnd() !== "---") return undefined
  for (let n = 1; n < lines; n++) if (/^(---|\.\.\.)\s*$/.test(lineAt(n))) return n
  return undefined
}

/** The problems of a note's known properties, as the status bar and the editor show them. */
export function propertyProblems(fm: Record<string, unknown> | undefined, config: GardenConfig): { key: string; message: string }[] {
  const out: { key: string; message: string }[] = []
  for (const key of KNOWN_PROPERTIES) {
    const message = propertyProblem(key, fm?.[key], config)
    if (message) out.push({ key, message })
  }
  return out
}

/** The style and frame a layout brings, as datme's LAYOUT_LOOKS has them. */
const LAYOUT_LOOKS: Record<string, { style?: string; frame: string }> = {
  cv: { style: "resume", frame: "minimal" },
  links: { style: "classic", frame: "minimal" },
  gallery: { style: "darkroom", frame: "minimal" },
  faq: { frame: "full" },
  decision: { frame: "full" },
  lore: { frame: "full" },
}

export interface NoteLook {
  path: string
  fm?: Record<string, unknown>
  /** The note's tags in its order, with or without #. */
  tags?: string[]
}

export interface Look {
  /** The value, or undefined for no layout. */
  value?: string
  /** What decided it, in the words of the 🎨 bar. */
  rule: string
}

/** The layout of a note: only its own `layout:` sets one. */
export function explainLayout(note: NoteLook): Look {
  const layout = note.fm?.layout
  if (layout != null && LAYOUTS.some((l) => l.value === pick(layout))) return { value: pick(layout), rule: `layout: in ${note.path}` }
  return { rule: "no layout:" }
}

/** The frame of a note: its own `chrome:`, the one its layout brings, or the whole frame. */
export function explainChrome(note: NoteLook): Look {
  const chrome = note.fm?.chrome
  if (chrome != null && CHROMES.some((c) => c.value === pick(chrome))) return { value: pick(chrome), rule: `chrome: in ${note.path}` }
  const layout = explainLayout(note).value
  if (layout) return { value: LAYOUT_LOOKS[layout]?.frame ?? "full-norail", rule: `the default of layout: ${layout}` }
  return { value: "full", rule: "the default" }
}

/**
 * The style of a note and the rule that gives it, in datme's order: its own
 * `style:`, its layout's, then `appearance` by tag, stage, folder, day of the
 * year and language, and last the site's style.
 */
export function explainStyle(note: NoteLook, config: GardenConfig, now: Date): Look {
  const { fm, path } = note
  const a = config.appearance
  if (fm?.style != null && (config.preset || STYLES.some((s) => s.value === pick(fm.style)))) return { value: pick(fm.style), rule: `style: in ${path}` }
  const layout = explainLayout(note).value
  const fromLayout = layout && LAYOUT_LOOKS[layout]?.style
  if (fromLayout) return { value: fromLayout, rule: `the default of layout: ${layout}` }
  for (const tag of note.tags ?? []) {
    const t = slugTag(tag)
    const key = Object.keys(a.tags)
      .filter((k) => t === k || t.startsWith(k + "/"))
      .sort((x, y) => y.length - x.length)[0]
    if (key) return { value: a.tags[key], rule: `appearance.tags → ${key}` }
  }
  const stage = noteStage(note, config)
  if (stage && a.stages[stage]) return { value: a.stages[stage], rule: `appearance.stages → ${stage}` }
  const dir = path.split("/").slice(0, -1).join("/")
  const under = (f: string) => dir === f || dir.startsWith(f + "/")
  const folder = Object.keys(a.folders).filter(under).sort((x, y) => y.length - x.length)[0]
  const classic = a.classic.filter(under).sort((x, y) => y.length - x.length)[0]
  if (classic !== undefined && (folder === undefined || classic.length > folder.length)) {
    return { value: a.style === "classic" ? "notebook" : "classic", rule: `appearance.classic → ${classic}` }
  }
  if (folder !== undefined) return { value: a.folders[folder], rule: `appearance.folders → ${folder}` }
  const day = now.toISOString().slice(5, 10)
  const season = a.schedule.find((s) => (s.from <= s.to ? s.from <= day && day <= s.to : day >= s.from || day <= s.to))
  if (season) return { value: season.style, rule: `appearance.schedule → ${season.from} to ${season.to}` }
  const lang = typeof fm?.lang === "string" && config.languages.includes(fm.lang) ? fm.lang : config.languages[0]
  const langKey = lang in a.languages ? lang : lang.split("-")[0] in a.languages ? lang.split("-")[0] : undefined
  if (langKey) return { value: a.languages[langKey], rule: `appearance.languages → ${langKey}` }
  return { value: a.style, rule: "appearance.style" }
}

/** A note's stage: its `stage:` when datme.yaml has it, else its top folder when that is a stage. */
export function noteStage(note: NoteLook, config: GardenConfig): string | undefined {
  const names = config.stages.map((s) => s.name)
  const own = note.fm?.stage
  if (typeof own === "string" && names.includes(own)) return own
  const top = note.path.includes("/") ? note.path.split("/")[0] : undefined
  return top && names.includes(top) ? top : undefined
}

/** A part of a page path as datme writes it: spaces as dashes, & and % in words, ? and # gone; case and accents kept. */
export function slugSegment(s: string): string {
  const slug = s.normalize("NFC").replace(/\s/g, "-").replace(/&/g, "-and-").replace(/%/g, "-percent").replace(/\?/g, "").replace(/#/g, "")
  return slug === "." || slug === ".." ? "" : slug
}

const slugPath = (p: string) => p.split("/").map(slugSegment).filter(Boolean).join("/")

/**
 * The URL path datme gives a note, from the root of the site (without its
 * base path), as `datme url` would print it: the home note is `/`, a
 * `permalink:` replaces the path, a title in the page's language replaces the
 * file name, and a language other than the first is a prefix.
 */
export function notePath(path: string, fm: Record<string, unknown> | undefined, config: GardenConfig): string {
  const lang = typeof fm?.lang === "string" && config.languages.includes(fm.lang) ? fm.lang : config.languages[0]
  const prefix = lang === config.languages[0] ? "" : `${lang}/`
  const inLang = (v: unknown) => (typeof v === "string" ? v : typeof record(v)[lang] === "string" ? String(record(v)[lang]) : undefined)
  let slug: string
  if (path === config.home) slug = "index"
  else {
    const parts = path.replace(/\.md$/i, "").split("/")
    const stem = parts.pop()!
    const title = typeof fm?.title === "object" ? inLang(fm.title) : undefined
    const permalink = inLang(fm?.permalink)
    slug = permalink ? slugPath(permalink.replace(/^\/+|\/+$/g, "")) : ""
    if (!slug) slug = slugPath([...parts, title ?? stem].join("/"))
  }
  slug = prefix + slug
  if (slug === "" || slug === "index") return "/"
  const clean = slug.replace(/(^|\/)index$/, "")
  return "/" + clean.split("/").map(encodeURIComponent).join("/")
}

/** The address of a page path on the live site; the path may or may not carry the site's base path. */
export function publicUrl(siteUrl: string, pagePath: string): string {
  const site = new URL(siteUrl)
  const base = site.pathname.replace(/\/+$/, "")
  const path = base && (pagePath === base || pagePath.startsWith(base + "/")) ? pagePath : base + pagePath
  return site.origin + (path || "/")
}

/** A link to a passage, as the site's share button writes it: the passage, or its first and last five words. */
export function textFragment(text: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26")
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
  if (!words.length) return ""
  if (words.length <= 12) return `#:~:text=${enc(words.join(" "))}`
  return `#:~:text=${enc(words.slice(0, 5).join(" "))},${enc(words.slice(-5).join(" "))}`
}

/**
 * What the site shows for a link to a note it does not publish, under
 * `privateLinks`, as words for a tooltip: its text, a placeholder, or nothing.
 */
export function privateLinkLabel(
  link: { target: string; alias?: string },
  privateLinks: PrivateLinks,
  why: { state: "private" | "draft" | "scheduled"; date?: string },
): string {
  const name = link.target.split("#")[0].split("/").pop()!.replace(/\.md$/i, "")
  const shown = link.alias?.trim() || name
  const site =
    privateLinks === "placeholder"
      ? "a placeholder (“a private note”)"
      : privateLinks === "hide" && shown.toLowerCase() === name.toLowerCase()
        ? "nothing"
        : `“${shown}” as plain text`
  const note = why.state === "draft" ? "A draft" : why.state === "scheduled" ? `Published on ${why.date}` : "A private note"
  return `🔒 ${note}: the site shows ${site}${why.state === "scheduled" ? " until then" : ""}`
}

/** The links of a line of Markdown: wikilinks and links to .md files, with where they are, embeds left out. */
export function linksIn(line: string): { from: number; to: number; target: string; alias?: string }[] {
  const out: { from: number; to: number; target: string; alias?: string }[] = []
  for (const m of line.matchAll(/(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
    if (m[1]) continue
    out.push({ from: m.index!, to: m.index! + m[0].length, target: m[2].trim(), alias: m[3] })
  }
  for (const m of line.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+\.md(?:#[^)\s]*)?)\)/gi)) {
    if (m[1] || /^[a-z]+:/i.test(m[3])) continue
    let target = m[3]
    try {
      target = decodeURIComponent(target)
    } catch {
      // a stray % keeps the link as written
    }
    out.push({ from: m.index!, to: m.index! + m[0].length, target, alias: m[2] })
  }
  return out.sort((a, b) => a.from - b.from)
}

/**
 * The `publish_date` for a day, and a time of that day when one is given. A
 * time carries the offset of the computer it was chosen on, since the build
 * that reads it may run elsewhere (in UTC, for CI). offset is in minutes east
 * of UTC, as `-new Date().getTimezoneOffset()` gives it.
 */
export function publishDateValue(day: string, time: string | undefined, offset: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`"${day}" is not a day as YYYY-MM-DD`)
  if (!time) return day
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`"${time}" is not a time as HH:MM`)
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${day}T${time}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}
