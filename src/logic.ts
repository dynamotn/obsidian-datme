/**
 * What the plugin decides without Obsidian: whether a note is published, how
 * to toggle it, how to run the datme command and read its answers.
 */

export type PublishMode = "explicit" | "all"

/** The `publish` mode of a vault, from the text of its datme.yaml (explicit when absent). */
export function publishMode(datmeYaml: string | null): PublishMode {
  return datmeYaml && /^publish:\s*["']?all["']?\s*(#.*)?$/m.test(datmeYaml) ? "all" : "explicit"
}

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
 * PATH, so the usual places of bun, node and npm-installed tools are added.
 */
export function augmentedPath(path: string | undefined, home: string): string {
  const extra = [`${home}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.npm-global/bin`]
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

/** The preview address of a page path printed by `datme url`. */
export function previewUrl(port: number, pagePath: string): string {
  return `http://localhost:${port}${pagePath.trim().startsWith("/") ? "" : "/"}${pagePath.trim()}`
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

/** The wikilink replacing a mention: by file name, with the words as written when they differ from it. */
export function mentionLink(m: Pick<Mention, "file" | "text">): string {
  const name = m.file.split("/").pop()!.replace(/\.md$/i, "")
  return m.text === name ? `[[${name}]]` : `[[${name}|${m.text}]]`
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

/** What the plugin needs of datme.yaml, parsed by Obsidian's YAML reader. */
export interface GardenConfig {
  mode: PublishMode
  /** Public URL of the site, without a trailing slash. */
  url?: string
  /** Folders datme never reads, its own ones included. */
  ignore: string[]
}

const DEFAULT_IGNORE = [".obsidian", ".trash", "node_modules", "private", "templates"]

export function gardenConfig(parsed: unknown): GardenConfig {
  const c = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>
  const site = (c.site && typeof c.site === "object" ? c.site : {}) as Record<string, unknown>
  const ignore = Array.isArray(c.ignore) ? c.ignore.map((p) => String(p).replace(/^\/+|\/+$/g, "")) : []
  return {
    mode: c.publish === "all" ? "all" : "explicit",
    url: typeof site.url === "string" && site.url ? site.url.replace(/\/+$/, "") : undefined,
    ignore: [...DEFAULT_IGNORE, ...ignore],
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

/** How many notes datme publishes, keeps private, holds as drafts or schedules, as it decides it. */
export function gardenCounts(notes: { path: string; fm?: Record<string, unknown> }[], config: GardenConfig, now: Date): GardenCounts {
  const counts: GardenCounts = { published: 0, unlisted: 0, private: 0, drafts: 0, scheduled: [] }
  for (const { path, fm } of notes) {
    if (path.split("/").some((part) => part.startsWith(".")) || config.ignore.some((ig) => path === ig || path.startsWith(ig + "/"))) continue
    if (!isPublished(fm, config.mode)) counts.private++
    else if (flag(fm?.draft) === true) counts.drafts++
    else {
      const at = fm?.publish_date ?? fm?.publishDate
      const date = at == null || at === "" ? undefined : new Date(String(at))
      if (date && !Number.isNaN(date.getTime()) && date > now) counts.scheduled.push({ path, date: date.toISOString().slice(0, 10) })
      else {
        counts.published++
        if (flag(fm?.unlisted) === true) counts.unlisted++
      }
    }
  }
  counts.scheduled.sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path))
  return counts
}
