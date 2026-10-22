/**
 * datme for Obsidian: toggle whether a note is published, check the garden for
 * broken links, preview the current note as the site will show it, and suggest
 * links while writing. Whatever runs the datme command needs the desktop app;
 * on a phone the plugin still shows and flips whether a note is published, and
 * the last check report saved in the vault.
 */
import type { ChildProcess } from "node:child_process"
import {
  debounce,
  FileSystemAdapter,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  parseYaml,
  Platform,
  Plugin,
  PluginSettingTab,
  requestUrl,
  SecretComponent,
  Setting,
  TFile,
  TFolder,
  type App,
  type WorkspaceLeaf,
} from "obsidian"
import {
  augmentedPath,
  gardenConfig,
  gardenCounts,
  groupProblems,
  ago,
  badgeOf,
  isIgnored,
  isPublished,
  locate,
  mentionLink,
  noteState,
  parseCheck,
  parseSuggestions,
  notePath,
  previewUrl,
  propertyProblems,
  publicUrl,
  textFragment,
  relatedWhy,
  splitCommand,
  summary,
  toggledPublish,
  type CheckResult,
  type GardenConfig,
  type Mention,
  type Suggestions,
  type TendState,
} from "./logic"
import { hasWebview, PREVIEW_VIEW, PreviewView } from "./preview"
import { PreviewLook } from "./look"
import { ExplorerBadges } from "./explorer"
import { propertyLinter, PropertySuggest } from "./properties"
import { LookModal, type LookKey } from "./pick"
import { markRenderedLinks, privateLinkMarker } from "./private-links"
import { ScheduleModal, unschedule } from "./schedule"
import { renderTending, tendingStatus } from "./tending"
import { renderCalendar } from "./calendar"
import { RESPONSES_VIEW, ResponsesView, ResponseWatcher } from "./responses"

const SUGGESTIONS_VIEW = "datme-suggestions"
const DASHBOARD_VIEW = "datme-dashboard"

/** The config files datme looks for at the root of the vault, in its order. */
const CONFIG_FILES = ["datme.yaml", "datme.yml", ".datme.yaml"]

/** Where a check report is saved for the other devices of the vault, and where CI can write one. */
export const REPORT = ".datme/check.json"

/** Node's process modules, which only the desktop app has: loaded when a command needs them. */
function node() {
  return {
    spawn: (require("node:child_process") as typeof import("node:child_process")).spawn,
    os: require("node:os") as typeof import("node:os"),
  }
}

interface Settings {
  /** How to run datme: a path, or a command with its first arguments. */
  command: string
  port: number
  /** Show links to unpublished notes and other notices in the check report. */
  showNotices: boolean
  /** Save each check report in the vault, for the plugin on a phone. */
  saveReport: boolean
  /** Badges beside notes and folders in the file explorer. */
  explorerBadges: boolean
  /** A dotted underline and 🔒 on links to notes datme does not publish. */
  markPrivateLinks: boolean
  /** "3 notes to tend" in the status bar. */
  tendCount: boolean
  /** After how many days untouched a fleeting or literature note asks to be tended. */
  staleDays: number
  /** What was snoozed or done in the tending queue. */
  tend: TendState
  /** The name of the webmention.io token in Obsidian's secret storage; never the token. */
  webmentionToken: string
  /** A notice when a new webmention comes, with the token. */
  notifyResponses: boolean
  /** The newest webmention seen, to tell new ones. */
  lastMentionId: number
}

const DEFAULTS: Settings = { command: "bunx @dynamotn/datme", port: 4321, showNotices: false, saveReport: true, explorerBadges: true,
  markPrivateLinks: true,
  tendCount: false,
  staleDays: 90,
  tend: { snoozed: {}, done: {} },
  webmentionToken: "",
  notifyResponses: false,
  lastMentionId: 0,
}

export default class DatmePlugin extends Plugin {
  settings: Settings = { ...DEFAULTS }
  private preview: ChildProcess | undefined
  private statusEl: HTMLElement | undefined
  private tendEl: HTMLElement | undefined
  config: GardenConfig = gardenConfig(null)
  /** The last check report, run here or saved by another device or CI; when it was made. */
  report: { result: CheckResult; at?: number } | undefined
  /** How the preview pane shows pages: light or dark, phone width, style and layout. */
  previewLook = new PreviewLook()
  explorer = new ExplorerBadges(this)
  responses = new ResponseWatcher(this)
  /** The state each note had when last seen, to tell when it changes. */
  private states = new Map<string, string>()

  private get mode() {
    return this.config.mode
  }

  override async onload() {
    const saved = (await this.loadData()) as Partial<Settings> | null
    this.settings = { ...DEFAULTS, ...saved, tend: { snoozed: {}, done: {}, ...saved?.tend } }
    await this.readMode()

    const desktop = Platform.isDesktopApp
    if (desktop) this.addRibbonIcon("sprout", "datme: preview this note", () => void this.openPreviewPane())
    this.tendEl = this.addStatusBarItem()
    this.tendEl.addClass("mod-clickable")
    this.tendEl.addEventListener("click", () => void this.openView(DASHBOARD_VIEW))
    this.tendEl.hide()
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.tendingChanged()))
    // The count needs the last report, which a phone or a fresh start only has saved.
    this.app.workspace.onLayoutReady(async () => {
      this.report ??= await this.savedReport()
      this.tendingChanged()
    })
    this.statusEl = this.addStatusBarItem()
    this.statusEl.addClass("mod-clickable")
    this.statusEl.addEventListener("click", () => void this.togglePublish())
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateStatus()))
    this.registerEvent(this.app.metadataCache.on("changed", () => this.updateStatus()))
    // The explorer's badges follow the notes, and the explorer when it draws new rows.
    this.registerEvent(this.app.metadataCache.on("changed", () => this.explorer.refresh()))
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.explorer.refresh()))
    this.registerEvent(this.app.vault.on("rename", () => this.explorer.refresh()))
    this.registerEvent(this.app.vault.on("delete", () => this.explorer.refresh()))
    this.registerEvent(this.app.workspace.on("layout-change", () => this.explorer.refresh()))
    // The explorer loads only when first shown, so its rows exist from then on.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => leaf?.view.getViewType() === "file-explorer" && this.explorer.refresh()))
    this.app.workspace.onLayoutReady(() => this.explorer.refresh())
    // The config is read again when it is written, created, deleted or renamed.
    const reread = (path: string, oldPath?: string) => {
      if (CONFIG_FILES.includes(path) || (oldPath && CONFIG_FILES.includes(oldPath))) void this.readMode().then(() => this.configChanged())
    }
    this.registerEvent(this.app.vault.on("modify", (f) => reread(f.path)))
    this.registerEvent(this.app.vault.on("create", (f) => reread(f.path)))
    this.registerEvent(this.app.vault.on("delete", (f) => reread(f.path)))
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => reread(f.path, oldPath)))
    // Phones have no status bar: the note's menu says and flips its state there too.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) return this.explorer.addMenuItems(menu, [file])
        if (!(file instanceof TFile) || file.extension !== "md") return
        const published = isPublished(this.app.metadataCache.getFileCache(file)?.frontmatter, this.mode)
        menu.addItem((item) =>
          item
            .setTitle(published ? "datme: keep private" : "datme: publish")
            .setIcon(published ? "lock" : "sprout")
            .onClick(() => void this.togglePublish(file)),
        )
        menu.addItem((item) =>
          item
            .setTitle("datme: schedule…")
            .setIcon("calendar-clock")
            .onClick(() => new ScheduleModal(this.app, file, this.mode).open()),
        )
        if (published && this.config.url) {
          menu.addItem((item) =>
            item
              .setTitle("datme: copy public link")
              .setIcon("link")
              .onClick(() => void this.copyPublicLink(file)),
          )
        }
      }),
    )
    // With text selected, the link opens the page on that passage.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file
        if (!file || file.extension !== "md" || !this.config.url) return
        const selection = editor.getSelection()
        menu.addItem((item) =>
          item
            .setTitle(selection.trim() ? "datme: copy public link to this passage" : "datme: copy public link")
            .setIcon("link")
            .onClick(() => void this.copyPublicLink(file, selection)),
        )
      }),
    )
    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => this.explorer.addMenuItems(menu, files)))

    this.addCommand({
      id: "toggle-publish",
      name: "Publish or unpublish the current note",
      checkCallback: (checking) => {
        const file = this.markdownFile()
        if (file && !checking) void this.togglePublish()
        return !!file
      },
    })
    this.addCommand({
      id: "schedule",
      name: "Schedule this note…",
      checkCallback: (checking) => {
        const file = this.markdownFile()
        if (file && !checking) new ScheduleModal(this.app, file, this.mode).open()
        return !!file
      },
    })
    this.addCommand({
      id: "unschedule",
      name: "Unschedule this note: publish it on the next build",
      checkCallback: (checking) => {
        const file = this.markdownFile()
        const fm = file && this.app.metadataCache.getFileCache(file)?.frontmatter
        const scheduled = fm != null && (fm.publish_date != null || fm.publishDate != null)
        if (file && scheduled && !checking) void unschedule(this.app, file)
        return scheduled
      },
    })
    this.addCommand({
      id: "copy-public-link",
      name: "Copy the public link of the current note (or of the selected passage)",
      checkCallback: (checking) => {
        const file = this.markdownFile()
        if (file && !checking) void this.copyPublicLink(file, this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getSelection())
        return !!file
      },
    })
    // On a phone, checking means reading the last report a computer or CI saved.
    this.addCommand({ id: "check", name: "Check the garden for problems", callback: () => void (desktop ? this.check() : this.showSavedReport()) })
    this.addCommand({ id: "last-report", name: "Show the last saved check report", callback: () => void this.showSavedReport() })
    this.registerView(DASHBOARD_VIEW, (leaf) => new DashboardView(leaf, this))
    this.registerView(RESPONSES_VIEW, (leaf) => new ResponsesView(leaf, this))
    this.addCommand({ id: "responses", name: "Show readers' responses to the current note", callback: () => void this.openView(RESPONSES_VIEW) })
    this.app.workspace.onLayoutReady(() => this.responses.start())
    this.addCommand({ id: "dashboard", name: "Open the garden dashboard", callback: () => void this.openView(DASHBOARD_VIEW) })
    if (desktop) {
      this.registerView(PREVIEW_VIEW, (leaf) => new PreviewView(leaf, this))
      this.addCommand({ id: "preview", name: "Preview the current note", callback: () => void this.openPreviewPane() })
      this.addCommand({ id: "preview-browser", name: "Preview the current note in the browser", callback: () => void this.openPreview() })
      this.addCommand({ id: "stop-preview", name: "Stop the preview server", callback: () => this.stopPreview() })
      this.registerView(SUGGESTIONS_VIEW, (leaf) => new SuggestionsView(leaf, this))
      this.addCommand({ id: "suggestions", name: "Show link suggestions", callback: () => void this.openView(SUGGESTIONS_VIEW) })
    }
    for (const key of ["style", "layout"] as LookKey[]) {
      this.addCommand({
        id: `set-${key}`,
        name: `Set ${key}…`,
        checkCallback: (checking) => {
          const file = this.markdownFile()
          if (file && !checking) new LookModal(this.app, this, file, key).open()
          return !!file
        },
      })
    }
    this.registerEditorSuggest(new PropertySuggest(this))
    this.registerEditorExtension(propertyLinter(this))
    this.registerEditorExtension(privateLinkMarker(this))
    this.registerMarkdownPostProcessor((el, ctx) => markRenderedLinks(this, el, ctx))
    // Links to a note look private or not by its state: when one changes, they are drawn again.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => {
        const state = badgeOf(cache.frontmatter, this.mode, new Date())
        const before = this.states.get(file.path)
        this.states.set(file.path, state)
        if (before !== undefined && before !== state) this.redrawLinks()
      }),
    )
    this.addSettingTab(new DatmeSettings(this.app, this))
    this.updateStatus()
  }

  override onunload() {
    this.stopPreview()
    this.responses.stop()
    for (const el of Array.from(document.querySelectorAll(".datme-badge"))) el.remove()
  }

  /** The tending queue changed: a check, a note, a snooze. Its count and the dashboards follow. */
  tendingChanged = debounce(
    () => {
      if (this.tendEl) tendingStatus(this, this.tendEl)
      // A pane not shown since Obsidian started is a stand-in until it loads, and draws itself then.
      for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW)) if (leaf.view instanceof DashboardView) leaf.view.refresh()
    },
    1000,
    true,
  )

  /** What follows datme.yaml once it was read again. */
  private configChanged() {
    this.responses.start()
    this.updateStatus()
    this.explorer.refresh()
    // Editors underline frontmatter values and mark links against the new config.
    this.redrawLinks()
  }

  /** Draw the editors and reading views again, for what the plugin marks in them. */
  redrawLinks = debounce(
    () => {
      this.app.workspace.updateOptions()
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") leaf.view.previewMode.rerender(true)
      }
    },
    500,
    true,
  )

  /** The `@group` passwords notes of the vault use already. */
  passwordGroups(): string[] {
    const groups = new Set<string>()
    for (const file of this.app.vault.getMarkdownFiles()) {
      const password = this.app.metadataCache.getFileCache(file)?.frontmatter?.password
      if (typeof password === "string" && /^@[\w-]+$/.test(password)) groups.add(password)
    }
    return [...groups]
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("datme needs a vault on disk")
    return adapter.getBasePath()
  }

  private markdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile()
    return file && file.extension === "md" ? file : null
  }

  private async readMode() {
    const adapter = this.app.vault.adapter
    let parsed: unknown = null
    try {
      for (const name of CONFIG_FILES) {
        if (!(await adapter.exists(name))) continue
        parsed = parseYaml(await adapter.read(name))
        break
      }
    } catch {
      // datme check reports a broken datme.yaml; here it counts as the defaults
    }
    this.config = gardenConfig(parsed)
  }

  private updateStatus() {
    if (!this.statusEl) return
    const file = this.markdownFile()
    if (!file) return void this.statusEl.setText("")
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter
    const { state, date } = noteState(fm, this.mode, new Date())
    const text = { published: "🌱 Published", private: "🔒 Private", draft: "📝 Draft", scheduled: `⏳ ${date}` }
    // Properties datme would not take: counted here, since the Properties view hides the underlines.
    const problems = propertyProblems(fm, this.config)
    this.statusEl.setText(text[state] + (problems.length ? ` · ⚠️ ${problems.length}` : ""))
    const label =
      state === "private"
        ? "Click to publish this note with datme"
        : state === "published"
          ? "datme publishes this note; click to unpublish"
          : `datme publishes this note ${state === "draft" ? "once draft is removed" : `on ${date}`}; click to unpublish`
    this.statusEl.setAttribute("aria-label", [label, ...problems.map((p) => `⚠️ ${p.message}`)].join("\n"))
  }

  async togglePublish(file = this.markdownFile()) {
    if (!file) return
    let now = false
    try {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const next = toggledPublish(fm, this.mode)
        if (next === undefined) delete fm.publish
        else fm.publish = next
        now = isPublished(fm, this.mode)
      })
    } catch (e) {
      return void new Notice(`datme could not change ${file.basename}: its frontmatter cannot be read (${(e as Error).message}).`, 8000)
    }
    new Notice(now ? `🌱 ${file.basename} will be published` : `🔒 ${file.basename} stays private`)
  }

  /** A pane of the plugin in the right sidebar, opened once. */
  async openView(type: string) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0]
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!
      await leaf.setViewState({ type, active: true })
    }
    void this.app.workspace.revealLeaf(leaf)
  }

  /** The URL path of a published note, from `datme url`; undefined when it is private or on a phone. */
  async noteUrl(file: TFile): Promise<string | undefined> {
    if (!Platform.isDesktopApp) return undefined
    const out = await this.run(["url", file.path, this.vaultPath()]).catch(() => undefined)
    return out && out.code === 0 ? out.stdout.trim().split("\n").pop() : undefined
  }

  /**
   * Copy a note's address on the live site, with a passage when one is given.
   * The path comes from `datme url` on the desktop, and from the plugin's own
   * rules on a phone, or when the command cannot run.
   */
  async copyPublicLink(file: TFile, passage?: string) {
    if (!this.config.url) return void new Notice("datme.yaml has no site.url, so the plugin does not know the site's address.", 6000)
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter
    const { state, date } = noteState(fm, this.mode, new Date())
    if (state !== "published" || isIgnored(file.path, this.config)) {
      const why = state === "draft" ? "is a draft" : state === "scheduled" ? `is published on ${date}` : "is not published"
      return void new Notice(`${file.basename} ${why}, so it has no public link yet.`, 5000)
    }
    const url = (await this.liveUrl(file))! + (passage ? textFragment(passage) : "")
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      return void new Notice(`datme could not copy the link: ${url}`, 10000)
    }
    new Notice(`🔗 Copied ${url}`)
  }

  /**
   * A note's address on the live site, or undefined when it has none: no
   * site.url, or a note datme does not publish today. The path comes from
   * `datme url` on the desktop, and from the plugin's own rules otherwise.
   */
  async liveUrl(file: TFile): Promise<string | undefined> {
    if (!this.config.url) return undefined
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter
    if (noteState(fm, this.mode, new Date()).state !== "published" || isIgnored(file.path, this.config)) return undefined
    const path = (await this.noteUrl(file)) ?? notePath(file.path, fm, this.config)
    return publicUrl(this.config.url, path)
  }

  /** The published notes by their address on the site, without a trailing slash, as the plugin works it out. */
  notesByUrl(): Map<string, TFile> {
    const out = new Map<string, TFile>()
    if (!this.config.url) return out
    const now = new Date()
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter
      if (noteState(fm, this.mode, now).state !== "published" || isIgnored(file.path, this.config)) continue
      out.set(publicUrl(this.config.url, notePath(file.path, fm, this.config)).replace(/\/+$/, ""), file)
    }
    return out
  }

  /** What to call the page at an address in a notice: its note's name, or the address. */
  titleOfUrl(url: string | undefined): string {
    if (!url) return "a page"
    const key = url.split("#")[0].replace(/\/+$/, "")
    const note = this.notesByUrl().get(key)
    if (note) return note.basename
    const path = key.replace(/^https?:\/\/[^/]+/, "") || "/"
    try {
      return decodeURI(path)
    } catch {
      // a stray % in an address a reader sent: shown as it came
      return path
    }
  }

  /** Related notes and unlinked mentions of a note, from `datme related`. */
  async suggestions(file: TFile): Promise<Suggestions> {
    const out = await this.run(["related", file.path, this.vaultPath(), "--json"])
    if (out.code !== 0) throw new Error(out.stderr.trim().split("\n").pop() || "datme related failed")
    return parseSuggestions(out.stdout)
  }

  /** Run datme with these arguments; resolves with its output once it exits. */
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const [program, ...lead] = splitCommand(this.settings.command)
    return new Promise((resolve, reject) => {
      const child = node().spawn(program, [...lead, ...args], { env: this.env(), cwd: this.vaultPath() })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.on("error", reject)
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    })
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, PATH: augmentedPath(process.env.PATH, node().os.homedir()), FORCE_COLOR: "0", NO_COLOR: "1" }
  }

  async check() {
    const notice = new Notice("🌱 datme is checking the garden…", 0)
    let result: CheckResult
    try {
      const out = await this.run(["check", this.vaultPath(), "--json"])
      result = parseCheck(out.stdout)
    } catch (e) {
      notice.hide()
      return void new Notice(`datme could not check the garden: ${(e as Error).message}. Is the command right in the settings?`, 8000)
    }
    notice.hide()
    new Notice(`datme: ${summary(result.counts)}`)
    new ProblemsModal(this.app, result, this.settings.showNotices).open()
    this.report = { result, at: Date.now() }
    this.tendingChanged()
    if (this.settings.saveReport) await this.saveReport(result)
  }

  /** Keep the report in the vault, where the plugin on another device finds it once the vault syncs. */
  private async saveReport(result: CheckResult) {
    const adapter = this.app.vault.adapter
    try {
      if (!(await adapter.exists(".datme"))) await adapter.mkdir(".datme")
      await adapter.write(REPORT, JSON.stringify(result))
    } catch {
      // a read-only vault only means no report for the other devices
    }
  }

  /** The report saved in the vault, and when; undefined when there is none or it cannot be read. */
  async savedReport(): Promise<{ result: CheckResult; at?: number } | undefined> {
    const adapter = this.app.vault.adapter
    try {
      if (!(await adapter.exists(REPORT))) return undefined
      return { result: parseCheck(await adapter.read(REPORT)), at: (await adapter.stat(REPORT))?.mtime }
    } catch {
      return undefined
    }
  }

  /** The report a computer or CI saved last, with how old it is. */
  async showSavedReport() {
    const saved = await this.savedReport()
    if (!saved) {
      return void new Notice(`No saved check report yet: run "Check the garden" on a computer, or have CI write ${REPORT}.`, 8000)
    }
    new ProblemsModal(this.app, saved.result, this.settings.showNotices, saved.at ? ago(saved.at, Date.now()) : undefined).open()
  }

  /**
   * The page path of a note on the preview server, from `datme url`; undefined
   * when datme does not publish it. Throws when the command cannot run.
   */
  async pagePath(file: TFile): Promise<string | undefined> {
    const out = await this.run(["url", file.path, this.vaultPath()])
    return out.code === 0 ? out.stdout.trim().split("\n").pop()?.trim() || "/" : undefined
  }

  /** The preview pane, beside the note; the browser where Obsidian cannot embed pages. */
  async openPreviewPane() {
    if (!hasWebview()) return this.openPreview()
    const open = this.app.workspace.getLeavesOfType(PREVIEW_VIEW)[0]
    if (open) {
      void this.app.workspace.revealLeaf(open)
      if (open.view instanceof PreviewView) void open.view.showActive()
      return
    }
    const leaf = this.app.workspace.getLeaf("split", "vertical")
    await leaf.setViewState({ type: PREVIEW_VIEW, active: false })
    void this.app.workspace.revealLeaf(leaf)
  }

  /** The preview panes show the look chosen in a toolbar, or in *Set style…*. */
  previewLookChanged() {
    this.previewLook.sync()
    for (const leaf of this.app.workspace.getLeavesOfType(PREVIEW_VIEW)) if (leaf.view instanceof PreviewView) leaf.view.lookChanged()
  }

  /** Start `datme dev` unless it runs already, and wait until it answers. */
  async ensurePreview(): Promise<boolean> {
    const url = previewUrl(this.settings.port, "/")
    if (await answers(url)) return true
    if (!this.preview) {
      const [program, ...lead] = splitCommand(this.settings.command)
      this.preview = node().spawn(program, [...lead, "dev", this.vaultPath(), "--port", String(this.settings.port)], {
        env: this.env(),
        cwd: this.vaultPath(),
      })
      this.preview.on("exit", () => (this.preview = undefined))
      this.preview.on("error", (e) => {
        this.preview = undefined
        new Notice(`datme could not start: ${e.message}. Is the command right in the settings?`, 8000)
      })
    }
    const notice = new Notice("🌱 datme is starting the preview…", 0)
    for (let i = 0; i < 120 && this.preview; i++) {
      if (await answers(url)) {
        notice.hide()
        return true
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    notice.hide()
    new Notice("The datme preview did not start in time.")
    return false
  }

  async openPreview() {
    const file = this.app.workspace.getActiveFile()
    const out = file ? await this.run(["url", file.path, this.vaultPath()]).catch(() => undefined) : undefined
    if (file && out && out.code !== 0) {
      return void new Notice(`${file.basename} is not published. Use "Publish or unpublish the current note" first.`)
    }
    if (!(await this.ensurePreview())) return
    window.open(previewUrl(this.settings.port, out?.stdout.trim() || "/") + this.previewLook.query())
  }

  stopPreview() {
    this.preview?.kill()
    this.preview = undefined
  }
}

/** Whether the preview answers: through Obsidian, since fetch from app:// is a cross-origin call Vite refuses. */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await requestUrl({ url, method: "HEAD", throw: false })
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

/**
 * A pane beside the note being written: published notes related to it, and
 * the places where it names one without a link, each turned into a link with
 * one click. It follows the active note, and refreshes when it is saved.
 */
class SuggestionsView extends ItemView {
  private file: TFile | null = null
  private refresh = debounce(() => void this.update(), 1500, true)

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: DatmePlugin,
  ) {
    super(leaf)
  }

  getViewType() {
    return SUGGESTIONS_VIEW
  }

  getDisplayText() {
    return "datme suggestions"
  }

  override getIcon() {
    return "sprout"
  }

  override async onOpen() {
    this.registerEvent(this.app.workspace.on("file-open", () => void this.update()))
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f === this.file) this.refresh()
      }),
    )
    await this.update()
  }

  private runs = 0

  private async update() {
    const file = this.app.workspace.getActiveFile()
    if (!file || file.extension !== "md") return
    const run = ++this.runs
    this.file = file
    const el = this.contentEl
    el.empty()
    el.createEl("h4", { text: file.basename })
    const status = el.createEl("p", { text: "🌱 Looking for suggestions…", cls: "u-muted" })
    let found: Suggestions
    try {
      found = await this.plugin.suggestions(file)
    } catch (e) {
      if (run === this.runs) status.setText(`datme could not suggest anything: ${(e as Error).message}`)
      return
    }
    // Another note was opened, or this one saved and asked again, meanwhile: the newer answer shows.
    if (run !== this.runs) return
    status.remove()
    this.render(found, file)
  }

  private render(found: Suggestions, file: TFile) {
    const el = this.contentEl
    el.createEl("h5", { text: "Named without a link" })
    if (!found.mentions.length) el.createEl("p", { text: "None.", cls: "u-muted" })
    const mentions = el.createEl("ul")
    for (const m of found.mentions) {
      const li = mentions.createEl("li")
      li.createSpan({ text: `“${m.text}”, line ${m.line} ` })
      const button = li.createEl("button", { text: `Link ${m.title}` })
      button.addEventListener("click", async () => {
        const link = this.linkOf(m, file)
        if (!(await this.link(file, m, link))) return
        li.remove()
        // The link is longer than the words: later mentions moved by the difference.
        const shift = link.length - m.text.length
        for (const later of found.mentions) if (later.offset > m.offset) later.offset += shift
      })
    }
    el.createEl("h5", { text: "Related notes" })
    if (!found.related.length) el.createEl("p", { text: "None.", cls: "u-muted" })
    const related = el.createEl("ul")
    for (const r of found.related) {
      const li = related.createEl("li")
      const a = li.createEl("a", { text: r.title, href: "#" })
      a.addEventListener("click", (e) => {
        e.preventDefault()
        void this.app.workspace.openLinkText(r.file, file.path, false)
      })
      const why = relatedWhy(r)
      if (why) li.createSpan({ text: ` · ${why}`, cls: "u-muted" })
    }
  }

  /**
   * Turn a mention into a link, if the words are still where datme saw them.
   * The pane refreshes once the note is saved, when the offsets are right again.
   */
  /** The link to put in place of a mention, as Obsidian would write it from this note. */
  private linkOf(m: Mention, file: TFile): string {
    const target = this.app.vault.getFileByPath(m.file)
    return mentionLink(m, target ? this.app.metadataCache.fileToLinktext(target, file.path, true) : undefined)
  }

  private async link(file: TFile, m: Mention, link: string): Promise<boolean> {
    const moved = () => {
      new Notice("The note changed since datme read it; save it to refresh the suggestions.", 4000)
      return false
    }
    // An editor holding the note, focused or not, has the latest text, unsaved typing included.
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file === file)
    if (view) {
      const editor = view.editor
      const at = locate(editor.getValue(), m)
      if (at === undefined) return moved()
      editor.replaceRange(link, editor.offsetToPos(at), editor.offsetToPos(at + m.text.length))
      return true
    }
    // Otherwise read and write in one step, so no other change lands in between.
    let found = false
    await this.app.vault.process(file, (text) => {
      const at = locate(text, m)
      if (at === undefined) return text
      found = true
      return text.slice(0, at) + link + text.slice(at + m.text.length)
    })
    return found || moved()
  }
}

/**
 * The state of the garden at a glance: how many notes are published, private,
 * drafts or scheduled, the problems of the last check, and links to the site
 * and to the current note on it. It works on a phone too, from the saved report.
 */
class DashboardView extends ItemView {
  refresh = debounce(() => void this.update(), 1000, true)
  /** URL paths of notes, asked of datme once per note until its frontmatter changes. */
  private urls = new Map<string, Promise<string | undefined>>()
  /** The frontmatter each note had when its URL was asked, as JSON. */
  private frontmatters = new Map<string, string>()

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: DatmePlugin,
  ) {
    super(leaf)
  }

  getViewType() {
    return DASHBOARD_VIEW
  }

  getDisplayText() {
    return "Garden dashboard"
  }

  override getIcon() {
    return "sprout"
  }

  override async onOpen() {
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()))
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()))
    // "changed" fires on every save; only new frontmatter can move a note's URL.
    this.registerEvent(
      this.app.metadataCache.on("changed", (f, _data, cache) => {
        const fm = JSON.stringify(cache.frontmatter ?? null)
        if (this.frontmatters.get(f.path) !== fm) this.urls.delete(f.path)
        this.frontmatters.set(f.path, fm)
      }),
    )
    this.plugin.report ??= await this.plugin.savedReport()
    await this.update()
  }

  private async update() {
    const { config, report } = this.plugin
    const notes = this.app.vault.getMarkdownFiles().map((f) => ({ path: f.path, fm: this.app.metadataCache.getFileCache(f)?.frontmatter }))
    const counts = gardenCounts(notes, config, new Date())
    const active = this.app.workspace.getActiveFile()
    let noteUrl: string | undefined
    if (active?.extension === "md" && config.url) {
      if (!this.urls.has(active.path)) {
        this.urls.set(active.path, this.plugin.noteUrl(active))
        this.frontmatters.set(active.path, JSON.stringify(this.app.metadataCache.getFileCache(active)?.frontmatter ?? null))
      }
      noteUrl = await this.urls.get(active.path)
    }
    const el = this.contentEl
    el.empty()
    el.createEl("h4", { text: "Garden" })
    const list = el.createEl("ul")
    list.createEl("li", { text: `🌱 ${counts.published} published${counts.unlisted ? ` (${counts.unlisted} unlisted)` : ""}` })
    list.createEl("li", { text: `🔒 ${counts.private} private` })
    if (counts.drafts) list.createEl("li", { text: `📝 ${counts.drafts} draft${counts.drafts === 1 ? "" : "s"}` })
    if (counts.scheduled.length) {
      const li = list.createEl("li", { text: `⏳ ${counts.scheduled.length} scheduled` })
      const days = li.createEl("ul")
      for (const s of counts.scheduled) this.noteLink(days.createEl("li", { text: `${s.date} ` }), s.path)
    }
    // Drawn in its place, once the pipeline files are read.
    void renderCalendar(el.createDiv(), counts.scheduled, this.app.vault.adapter, (path) => void this.app.workspace.openLinkText(path, "", false))

    el.createEl("h4", { text: "Last check" })
    if (!report) el.createEl("p", { text: Platform.isDesktopApp ? "Not checked yet." : "No saved report yet.", cls: "u-muted" })
    else {
      const { error, warning, info } = report.result.counts
      const p = el.createEl("p", { text: `⛔ ${error} · ⚠️ ${warning} · ℹ️ ${info}` })
      if (report.at) p.createSpan({ text: ` · ${ago(report.at, Date.now())}`, cls: "u-muted" })
      el.createEl("button", { text: "Open the report" }).addEventListener("click", () =>
        new ProblemsModal(this.app, report.result, this.plugin.settings.showNotices, report.at ? ago(report.at, Date.now()) : undefined).open(),
      )
    }
    if (Platform.isDesktopApp) el.createEl("button", { text: "Check now" }).addEventListener("click", () => void this.plugin.check())

    renderTending(this.plugin, el, (parent, path) => this.noteLink(parent, path))

    // With a webmention.io token: which notes readers answer most.
    if (this.plugin.responses.enabled) {
      el.createEl("h4", { text: "Responses" })
      const counts = await this.plugin.responses.refresh()
      const byUrl = this.plugin.notesByUrl()
      const top = [...(counts ?? [])].filter(([url]) => byUrl.has(url)).sort((a, b) => b[1] - a[1]).slice(0, 10)
      if (!counts) el.createEl("p", { cls: "u-muted", text: "webmention.io could not be reached." })
      else if (!top.length) el.createEl("p", { cls: "u-muted", text: "No webmentions yet." })
      const list = el.createEl("ul")
      for (const [url, n] of top) this.noteLink(list.createEl("li", { text: `💬 ${n} · ` }), byUrl.get(url)!.path)
    }

    if (config.url) {
      el.createEl("h4", { text: "On the web" })
      const links = el.createEl("ul")
      links.createEl("li").createEl("a", { text: config.url.replace(/^https?:\/\//, ""), href: config.url })
      if (active && noteUrl) links.createEl("li").createEl("a", { text: active.basename, href: publicUrl(config.url, noteUrl) })
    }
  }

  private noteLink(parent: HTMLElement, path: string) {
    const a = parent.createEl("a", { text: path.replace(/\.md$/, ""), href: "#" })
    a.addEventListener("click", (e) => {
      e.preventDefault()
      void this.app.workspace.openLinkText(path, "", false)
    })
  }
}

class ProblemsModal extends Modal {
  constructor(
    app: App,
    private result: CheckResult,
    private withInfo: boolean,
    /** For a saved report: how long ago it was saved. */
    private age?: string,
  ) {
    super(app)
  }

  override onOpen() {
    const { contentEl } = this
    this.setTitle(`datme check: ${summary(this.result.counts)}`)
    if (this.age) contentEl.createEl("p", { text: `Saved ${this.age}.`, cls: "u-muted" })
    const groups = groupProblems(this.result.problems, this.withInfo)
    if (!groups.length) return void contentEl.createEl("p", { text: "🌱 The garden is healthy." })
    const icon = { error: "⛔", warning: "⚠️", info: "ℹ️" }
    for (const [file, problems] of groups) {
      const head = contentEl.createEl("h4")
      const link = head.createEl("a", { text: file, href: "#" })
      link.addEventListener("click", (e) => {
        e.preventDefault()
        this.close()
        void this.app.workspace.openLinkText(file, "", false)
      })
      const list = contentEl.createEl("ul")
      for (const p of problems) list.createEl("li", { text: `${icon[p.level]} ${p.message}` })
    }
  }

  override onClose() {
    this.contentEl.empty()
  }
}

class DatmeSettings extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: DatmePlugin,
  ) {
    super(app, plugin)
  }

  display() {
    const { containerEl } = this
    containerEl.empty()
    new Setting(containerEl)
      .setName("Command")
      .setDesc("How to run datme, e.g. `bunx @dynamotn/datme`, `npx @dynamotn/datme` or the path of a global install.")
      .addText((t) =>
        t.setValue(this.plugin.settings.command).onChange(async (v) => {
          this.plugin.settings.command = v.trim() || DEFAULTS.command
          await this.plugin.saveSettings()
        }),
      )
    new Setting(containerEl)
      .setName("Preview port")
      .setDesc("Port of the preview server started by the plugin.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.port)).onChange(async (v) => {
          const port = Number(v)
          if (Number.isInteger(port) && port > 0 && port < 65536) {
            this.plugin.settings.port = port
            await this.plugin.saveSettings()
          }
        }),
      )
    new Setting(containerEl)
      .setName("Save the check report")
      .setDesc(`Keep the last report in ${REPORT}, so the plugin on your phone can show it once the vault syncs.`)
      .addToggle((t) =>
        t.setValue(this.plugin.settings.saveReport).onChange(async (v) => {
          this.plugin.settings.saveReport = v
          await this.plugin.saveSettings()
        }),
      )
    new Setting(containerEl)
      .setName("Badges in the file explorer")
      .setDesc("Show beside each note whether datme publishes it (🌱 published, 🔒 private, 📝 draft, ⏳ scheduled, 👁 unlisted), and beside each folder how many of its notes it publishes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.explorerBadges).onChange(async (v) => {
          this.plugin.settings.explorerBadges = v
          await this.plugin.saveSettings()
          this.plugin.explorer.render()
        }),
      )
    new Setting(containerEl)
      .setName("Mark links to private notes")
      .setDesc("Give links to notes datme does not publish a dotted underline and a 🔒, with a tooltip saying what the site shows instead (privateLinks in datme.yaml).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.markPrivateLinks).onChange(async (v) => {
          this.plugin.settings.markPrivateLinks = v
          await this.plugin.saveSettings()
          this.plugin.redrawLinks()
        }),
      )
    new Setting(containerEl)
      .setName("Notes to tend in the status bar")
      .setDesc("Count the notes of the dashboard's Tend list in the status bar: orphans, dead ends, notes out of date and notes left fleeting.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.tendCount).onChange(async (v) => {
          this.plugin.settings.tendCount = v
          await this.plugin.saveSettings()
          this.plugin.tendingChanged()
        }),
      )
    new Setting(containerEl)
      .setName("Days before a fleeting note asks to be tended")
      .setDesc("A note in a fleeting or literature stage of datme.yaml joins the Tend list once untouched this long.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.staleDays)).onChange(async (v) => {
          const days = Number(v)
          if (Number.isInteger(days) && days > 0) {
            this.plugin.settings.staleDays = days
            await this.plugin.saveSettings()
            this.plugin.tendingChanged()
          }
        }),
      )
    // Obsidian keeps secrets apart from the vault since 1.11.4; the setting holds only the secret's name.
    if (this.app.secretStorage && typeof SecretComponent === "function") {
      new Setting(containerEl)
        .setName("webmention.io token")
        .setDesc("Optional. With the token of your webmention.io account, the dashboard counts responses by note and the plugin can tell you of new ones. It stays in Obsidian's secret storage, out of the vault.")
        .addComponent((el) =>
          new SecretComponent(this.app, el).setValue(this.plugin.settings.webmentionToken).onChange(async (v) => {
            this.plugin.settings.webmentionToken = v
            await this.plugin.saveSettings()
            this.plugin.responses.start()
          }),
        )
      new Setting(containerEl)
        .setName("Tell me of new responses")
        .setDesc("Every 30 minutes, ask webmention.io for new webmentions and show a notice for each. Needs the token.")
        .addToggle((t) =>
          t.setValue(this.plugin.settings.notifyResponses).onChange(async (v) => {
            this.plugin.settings.notifyResponses = v
            await this.plugin.saveSettings()
            this.plugin.responses.start()
          }),
        )
    }
    new Setting(containerEl)
      .setName("Show notices")
      .setDesc("Also list notices in the check report: links to unpublished notes, scheduled notes, orphans, dead ends and hubs.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showNotices).onChange(async (v) => {
          this.plugin.settings.showNotices = v
          await this.plugin.saveSettings()
        }),
      )
  }
}
