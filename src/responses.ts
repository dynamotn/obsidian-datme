/**
 * What readers answered, without leaving Obsidian: a pane with the
 * webmentions of the active note (likes, reposts, replies and mentions, the
 * fediverse's and Bluesky's through Bridgy) and its giscus comments, newest
 * first, each linking to where it can be answered. With a webmention.io token
 * the dashboard counts them by note, and a notice can say when new ones come.
 *
 * It reads public APIs: webmention.io and giscus.app, and the live page itself
 * when giscus finds discussions by title. Nothing is sent but the page's address.
 */
import { debounce, ItemView, Notice, requestUrl, setIcon, type TFile, type WorkspaceLeaf } from "obsidian"
import { ago, safeUrl, giscusTerms, mentionCounts, mentionTargets, pageTitles, parseGiscus, parseMentions, responseLine, type Response } from "./logic"
import type DatmePlugin from "./main"

export const RESPONSES_VIEW = "datme-responses"

/** How long answers are kept before they are asked again, unless asked by hand. */
const FRESH = 10 * 60_000
/** How often the account is asked for new webmentions, when notices are on. */
const POLL = 30 * 60_000

async function getJson(url: string): Promise<{ status: number; json: unknown }> {
  const res = await requestUrl({ url, throw: false })
  let json: unknown
  try {
    json = res.json
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

export interface NoteResponses {
  url: string
  mentions?: Response[]
  comments?: Response[]
  /** The giscus discussion, to answer there; reactions on it. */
  discussion?: { url?: string; reactions: number }
  /** What could not be read, in a few words each. */
  errors: string[]
  at: number
}

/** The responses to a page: its webmentions and its giscus discussion, whichever the garden has. */
export async function fetchResponses(plugin: DatmePlugin, url: string): Promise<NoteResponses> {
  const { webmentions, giscus } = plugin.config.responses
  const out: NoteResponses = { url, errors: [], at: Date.now() }
  const jobs: Promise<void>[] = []
  if (webmentions) {
    jobs.push(
      (async () => {
        const q = mentionTargets(url)
          .map((t) => `target[]=${encodeURIComponent(t)}`)
          .join("&")
        const { status, json } = await getJson(`https://webmention.io/api/mentions.jf2?${q}&per-page=200`)
        if (status !== 200) throw new Error(`webmention.io answered ${status}`)
        out.mentions = parseMentions(json)
      })().catch((e: Error) => void out.errors.push(`Webmentions: ${e.message}`)),
    )
  }
  if (giscus) {
    jobs.push(
      (async () => {
        let titles: { title?: string; ogTitle?: string } | undefined
        if (giscus.mapping === "title" || giscus.mapping === "og:title") {
          // Only the page knows its title as giscus reads it.
          const page = await requestUrl({ url, throw: false })
          if (page.status !== 200) throw new Error(`the page answered ${page.status}, so its title is unknown`)
          titles = pageTitles(page.text)
        }
        const terms = giscusTerms(giscus.mapping, url, titles)
        if (!terms.length) throw new Error("the page has no title to look its discussion up by")
        let json: unknown
        for (const term of terms) {
          const params = new URLSearchParams({ repo: giscus.repo, term, category: giscus.category, number: "0", strict: "true", last: "50" })
          const res = await getJson(`https://giscus.app/api/discussions?${params}`)
          if (res.status === 404) continue
          if (res.status !== 200) throw new Error(`giscus answered ${res.status}`)
          json = res.json
          break
        }
        // No discussion under any term: nobody commented yet.
        if (json === undefined) return void (out.comments = [])
        const found = parseGiscus(json)
        out.comments = found.responses
        out.discussion = { url: found.url, reactions: found.reactions }
      })().catch((e: Error) => void out.errors.push(`Comments: ${e.message}`)),
    )
  }
  await Promise.all(jobs)
  return out
}

export class ResponsesView extends ItemView {
  private file: TFile | null = null
  private runs = 0
  private cache = new Map<string, NoteResponses>()
  private follow = debounce((file: TFile) => void this.update(file), 500, true)

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: DatmePlugin,
  ) {
    super(leaf)
  }

  getViewType() {
    return RESPONSES_VIEW
  }

  getDisplayText() {
    return "Readers' responses"
  }

  override getIcon() {
    return "message-circle"
  }

  override async onOpen() {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "md" && file !== this.file) this.follow(file)
      }),
    )
    const file = this.app.workspace.getActiveFile()
    if (file?.extension === "md") await this.update(file)
    else this.contentEl.createEl("p", { text: "Open a note to see what readers answered.", cls: "u-muted" })
  }

  private async update(file: TFile, force = false) {
    const run = ++this.runs
    this.file = file
    const el = this.contentEl
    el.empty()
    const head = el.createDiv({ cls: "datme-responses-head" })
    head.createEl("h4", { text: file.basename })
    const reload = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Ask again" } })
    setIcon(reload, "rotate-cw")
    reload.addEventListener("click", () => void this.update(file, true))

    const { webmentions, giscus } = this.plugin.config.responses
    if (!webmentions && !giscus) {
      return void el.createEl("p", {
        cls: "u-muted",
        text: "datme.yaml asks for no responses: add webmentions: (webmention.io) or comments: with provider giscus, and readers' answers show here.",
      })
    }
    const url = await this.plugin.liveUrl(file)
    if (run !== this.runs) return
    if (!url) return void el.createEl("p", { cls: "u-muted", text: `${file.basename} is not on the site, so readers cannot answer it yet.` })
    const status = el.createEl("p", { cls: "u-muted", text: "🌱 Asking for responses…" })
    let found = this.cache.get(url)
    if (force || !found || Date.now() - found.at > FRESH) {
      found = await fetchResponses(this.plugin, url)
      if (!found.errors.length) this.cache.set(url, found)
    }
    if (run !== this.runs) return
    status.remove()
    this.render(found)
  }

  private render(found: NoteResponses) {
    const el = this.contentEl
    for (const e of found.errors) el.createEl("p", { cls: "datme-responses-error", text: `⚠️ ${e}` })
    const mentions = found.mentions ?? []
    const likes = mentions.filter((m) => m.kind === "like")
    const reposts = mentions.filter((m) => m.kind === "repost")
    const counts = [
      likes.length && `❤️ ${likes.length} like${likes.length === 1 ? "" : "s"}`,
      reposts.length && `🔁 ${reposts.length} repost${reposts.length === 1 ? "" : "s"}`,
      found.discussion?.reactions && `👍 ${found.discussion.reactions} reaction${found.discussion.reactions === 1 ? "" : "s"} on giscus`,
    ].filter(Boolean)
    if (counts.length) {
      const p = el.createEl("p", { text: counts.join(" · ") })
      const who = [...likes, ...reposts].map((m) => m.author.name)
      if (who.length) p.setAttribute("aria-label", who.slice(0, 20).join(", ") + (who.length > 20 ? "…" : ""))
    }
    const words = [...mentions.filter((m) => m.kind === "reply" || m.kind === "mention"), ...(found.comments ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    if (!words.length && !counts.length && !found.errors.length) el.createEl("p", { cls: "u-muted", text: "No responses yet." })
    const list = el.createEl("ul", { cls: "datme-responses" })
    const now = Date.now()
    for (const r of words) {
      const li = list.createEl("li")
      const who = li.createDiv({ cls: "datme-response-who" })
      // Parsing keeps only http(s) addresses; checked again where they become links.
      const home = safeUrl(r.author.url)
      if (home) who.createEl("a", { text: r.author.name, href: home })
      else who.createSpan({ text: r.author.name })
      const what = r.source === "giscus" ? "commented" : r.kind === "reply" ? "replied" : "mentioned this"
      who.createSpan({ cls: "u-muted", text: ` ${what}${r.via ? ` via ${r.via}` : ""}${r.at ? ` · ${ago(r.at, now)}` : ""}` })
      if (r.text) li.createDiv({ cls: "datme-response-text", text: r.text.length > 500 ? r.text.slice(0, 500) + "…" : r.text })
      const reply = safeUrl(r.source === "giscus" ? (r.url ?? found.discussion?.url) : r.url)
      if (reply) li.createEl("a", { cls: "datme-response-reply", text: "Reply where it lives ↗", href: reply })
    }
    const discussion = safeUrl(found.discussion?.url)
    if (discussion) el.createEl("a", { text: "Open the discussion on GitHub ↗", href: discussion })
  }
}

/**
 * The webmentions of the whole account, with a webmention.io token: counts by
 * page for the dashboard, and a notice for new ones when the setting asks.
 */
export class ResponseWatcher {
  counts: Map<string, number> | undefined
  private at = 0
  private timer: number | undefined

  constructor(private plugin: DatmePlugin) {}

  /** The token, from Obsidian's secret storage; the settings only keep its name. */
  private token(): string | undefined {
    const id = this.plugin.settings.webmentionToken
    if (!id || !this.plugin.app.secretStorage) return undefined
    return this.plugin.app.secretStorage.getSecret(id) ?? undefined
  }

  get enabled(): boolean {
    return !!this.plugin.config.responses.webmentions && !!this.token()
  }

  /** Poll while notices are on. */
  start() {
    this.stop()
    if (!this.plugin.settings.notifyResponses || !this.enabled) return
    void this.poll()
    this.timer = window.setInterval(() => void this.poll(), POLL)
    this.plugin.registerInterval(this.timer)
  }

  stop() {
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
  }

  /** Ask the account again when the counts are old, for the dashboard. */
  async refresh(force = false): Promise<Map<string, number> | undefined> {
    if (!this.enabled) return undefined
    if (!force && this.counts && Date.now() - this.at < FRESH) return this.counts
    await this.poll()
    return this.counts
  }

  private async poll() {
    const token = this.token()
    if (!token) return
    let all: Response[]
    try {
      const { status, json } = await getJson(`https://webmention.io/api/mentions.jf2?token=${encodeURIComponent(token)}&per-page=500`)
      if (status !== 200) return
      all = parseMentions(json)
    } catch {
      // offline: the next poll tries again
      return
    }
    this.counts = mentionCounts(all)
    this.at = Date.now()
    const settings = this.plugin.settings
    const newest = Math.max(0, ...all.map((r) => r.id ?? 0))
    // The first time, only remember where the account is: no flood of old mentions.
    const seen = settings.lastMentionId
    const fresh = seen && settings.notifyResponses ? all.filter((r) => (r.id ?? 0) > seen) : []
    // Remembered before telling, so a response that cannot be told is not told again at every poll.
    if (newest > seen) {
      settings.lastMentionId = newest
      await this.plugin.saveSettings()
    }
    for (const r of fresh.slice(0, 5)) {
      try {
        new Notice(`💬 ${responseLine(r, this.plugin.titleOfUrl(r.target))}`, 8000)
      } catch {
        new Notice("💬 A new response", 8000)
      }
    }
    if (fresh.length > 5) new Notice(`💬 …and ${fresh.length - 5} more responses`, 8000)
  }
}
