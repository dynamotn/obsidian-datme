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
  Setting,
  TFile,
  type App,
  type WorkspaceLeaf,
} from "obsidian"
import {
  augmentedPath,
  gardenConfig,
  gardenCounts,
  groupProblems,
  ago,
  isPublished,
  mentionLink,
  parseCheck,
  parseSuggestions,
  previewUrl,
  relatedWhy,
  splitCommand,
  summary,
  toggledPublish,
  type CheckResult,
  type GardenConfig,
  type Mention,
  type Suggestions,
} from "./logic"

const SUGGESTIONS_VIEW = "datme-suggestions"
const DASHBOARD_VIEW = "datme-dashboard"

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
}

const DEFAULTS: Settings = { command: "bunx @dynamotn/datme", port: 4321, showNotices: false, saveReport: true }

export default class DatmePlugin extends Plugin {
  settings: Settings = { ...DEFAULTS }
  private preview: ChildProcess | undefined
  private statusEl: HTMLElement | undefined
  config: GardenConfig = gardenConfig(null)
  /** The last check report, run here or saved by another device or CI; when it was made. */
  report: { result: CheckResult; at?: number } | undefined

  private get mode() {
    return this.config.mode
  }

  override async onload() {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) }
    await this.readMode()

    const desktop = Platform.isDesktopApp
    if (desktop) this.addRibbonIcon("sprout", "datme: preview this note", () => void this.openPreview())
    this.statusEl = this.addStatusBarItem()
    this.statusEl.addClass("mod-clickable")
    this.statusEl.addEventListener("click", () => void this.togglePublish())
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateStatus()))
    this.registerEvent(this.app.metadataCache.on("changed", () => this.updateStatus()))
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f.path === "datme.yaml") void this.readMode().then(() => this.updateStatus())
      }),
    )
    // Phones have no status bar: the note's menu says and flips its state there too.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return
        const published = isPublished(this.app.metadataCache.getFileCache(file)?.frontmatter, this.mode)
        menu.addItem((item) =>
          item
            .setTitle(published ? "datme: keep private" : "datme: publish")
            .setIcon(published ? "lock" : "sprout")
            .onClick(() => void this.togglePublish(file)),
        )
      }),
    )

    this.addCommand({
      id: "toggle-publish",
      name: "Publish or unpublish the current note",
      checkCallback: (checking) => {
        const file = this.markdownFile()
        if (file && !checking) void this.togglePublish()
        return !!file
      },
    })
    // On a phone, checking means reading the last report a computer or CI saved.
    this.addCommand({ id: "check", name: "Check the garden for problems", callback: () => void (desktop ? this.check() : this.showSavedReport()) })
    this.addCommand({ id: "last-report", name: "Show the last saved check report", callback: () => void this.showSavedReport() })
    this.registerView(DASHBOARD_VIEW, (leaf) => new DashboardView(leaf, this))
    this.addCommand({ id: "dashboard", name: "Open the garden dashboard", callback: () => void this.openView(DASHBOARD_VIEW) })
    if (desktop) {
      this.addCommand({ id: "preview", name: "Preview the current note", callback: () => void this.openPreview() })
      this.addCommand({ id: "stop-preview", name: "Stop the preview server", callback: () => this.stopPreview() })
      this.registerView(SUGGESTIONS_VIEW, (leaf) => new SuggestionsView(leaf, this))
      this.addCommand({ id: "suggestions", name: "Show link suggestions", callback: () => void this.openView(SUGGESTIONS_VIEW) })
    }
    this.addSettingTab(new DatmeSettings(this.app, this))
    this.updateStatus()
  }

  override onunload() {
    this.stopPreview()
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
      if (await adapter.exists("datme.yaml")) parsed = parseYaml(await adapter.read("datme.yaml"))
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
    const published = isPublished(fm, this.mode)
    this.statusEl.setText(published ? "🌱 Published" : "🔒 Private")
    this.statusEl.setAttribute("aria-label", published ? "datme publishes this note; click to unpublish" : "Click to publish this note with datme")
  }

  async togglePublish(file = this.markdownFile()) {
    if (!file) return
    let now = false
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const next = toggledPublish(fm, this.mode)
      if (next === undefined) delete fm.publish
      else fm.publish = next
      now = isPublished(fm, this.mode)
    })
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
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW)) (leaf.view as DashboardView).refresh()
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

  /** Start `datme dev` unless it runs already, and wait until it answers. */
  private async ensurePreview(): Promise<boolean> {
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
    window.open(previewUrl(this.settings.port, out?.stdout.trim() || "/"))
  }

  stopPreview() {
    this.preview?.kill()
    this.preview = undefined
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { method: "HEAD" })).ok
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

  private async update() {
    const file = this.app.workspace.getActiveFile()
    if (!file || file.extension !== "md") return
    this.file = file
    const el = this.contentEl
    el.empty()
    el.createEl("h4", { text: file.basename })
    const status = el.createEl("p", { text: "🌱 Looking for suggestions…", cls: "u-muted" })
    let found: Suggestions
    try {
      found = await this.plugin.suggestions(file)
    } catch (e) {
      return void status.setText(`datme could not suggest anything: ${(e as Error).message}`)
    }
    // Another note was opened meanwhile.
    if (this.file !== file) return
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
        if (!(await this.link(file, m))) return
        li.remove()
        // The link is longer than the words: later mentions moved by the difference.
        const shift = mentionLink(m).length - m.text.length
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
  private async link(file: TFile, m: Mention): Promise<boolean> {
    const moved = () => {
      new Notice("The note changed since datme read it; save it to refresh the suggestions.", 4000)
      return false
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (view?.file === file) {
      const editor = view.editor
      const from = editor.offsetToPos(m.offset)
      const to = editor.offsetToPos(m.offset + m.text.length)
      if (editor.getRange(from, to) !== m.text) return moved()
      editor.replaceRange(mentionLink(m), from, to)
      return true
    }
    const text = await this.app.vault.read(file)
    if (text.slice(m.offset, m.offset + m.text.length) !== m.text) return moved()
    await this.app.vault.modify(file, text.slice(0, m.offset) + mentionLink(m) + text.slice(m.offset + m.text.length))
    return true
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
    this.registerEvent(this.app.metadataCache.on("changed", (f) => this.urls.delete(f.path)))
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
      if (!this.urls.has(active.path)) this.urls.set(active.path, this.plugin.noteUrl(active))
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

    if (config.url) {
      el.createEl("h4", { text: "On the web" })
      const links = el.createEl("ul")
      links.createEl("li").createEl("a", { text: config.url.replace(/^https?:\/\//, ""), href: config.url })
      if (active && noteUrl) links.createEl("li").createEl("a", { text: active.basename, href: config.url + noteUrl })
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
