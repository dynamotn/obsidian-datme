/**
 * datme for Obsidian: toggle whether a note is published, check the garden for
 * broken links, preview the current note as the site will show it, and suggest
 * links while writing. The plugin runs the datme command, so it works on
 * desktop only.
 */
import { spawn, type ChildProcess } from "node:child_process"
import os from "node:os"
import {
  debounce,
  FileSystemAdapter,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type App,
  type WorkspaceLeaf,
} from "obsidian"
import {
  augmentedPath,
  groupProblems,
  isPublished,
  mentionLink,
  parseCheck,
  parseSuggestions,
  previewUrl,
  publishMode,
  relatedWhy,
  splitCommand,
  summary,
  toggledPublish,
  type CheckResult,
  type Mention,
  type PublishMode,
  type Suggestions,
} from "./logic"

const SUGGESTIONS_VIEW = "datme-suggestions"

interface Settings {
  /** How to run datme: a path, or a command with its first arguments. */
  command: string
  port: number
  /** Show links to unpublished notes and other notices in the check report. */
  showNotices: boolean
}

const DEFAULTS: Settings = { command: "bunx @dynamotn/datme", port: 4321, showNotices: false }

export default class DatmePlugin extends Plugin {
  settings: Settings = { ...DEFAULTS }
  private preview: ChildProcess | undefined
  private statusEl: HTMLElement | undefined
  private mode: PublishMode = "explicit"

  override async onload() {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) }
    await this.readMode()

    this.addRibbonIcon("sprout", "datme: preview this note", () => void this.openPreview())
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

    this.addCommand({
      id: "toggle-publish",
      name: "Publish or unpublish the current note",
      checkCallback: (checking) => {
        const file = this.markdownFile()
        if (file && !checking) void this.togglePublish()
        return !!file
      },
    })
    this.addCommand({ id: "check", name: "Check the garden for problems", callback: () => void this.check() })
    this.addCommand({ id: "preview", name: "Preview the current note", callback: () => void this.openPreview() })
    this.addCommand({ id: "stop-preview", name: "Stop the preview server", callback: () => this.stopPreview() })
    this.registerView(SUGGESTIONS_VIEW, (leaf) => new SuggestionsView(leaf, this))
    this.addCommand({ id: "suggestions", name: "Show link suggestions", callback: () => void this.openSuggestions() })
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
    const exists = await this.app.vault.adapter.exists("datme.yaml")
    this.mode = publishMode(exists ? await this.app.vault.adapter.read("datme.yaml") : null)
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

  async togglePublish() {
    const file = this.markdownFile()
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

  /** The suggestions pane in the right sidebar, opened once. */
  async openSuggestions() {
    let leaf = this.app.workspace.getLeavesOfType(SUGGESTIONS_VIEW)[0]
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!
      await leaf.setViewState({ type: SUGGESTIONS_VIEW, active: true })
    }
    void this.app.workspace.revealLeaf(leaf)
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
      const child = spawn(program, [...lead, ...args], { env: this.env(), cwd: this.vaultPath() })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.on("error", reject)
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    })
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, PATH: augmentedPath(process.env.PATH, os.homedir()), FORCE_COLOR: "0", NO_COLOR: "1" }
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
  }

  /** Start `datme dev` unless it runs already, and wait until it answers. */
  private async ensurePreview(): Promise<boolean> {
    const url = previewUrl(this.settings.port, "/")
    if (await answers(url)) return true
    if (!this.preview) {
      const [program, ...lead] = splitCommand(this.settings.command)
      this.preview = spawn(program, [...lead, "dev", this.vaultPath(), "--port", String(this.settings.port)], {
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

class ProblemsModal extends Modal {
  constructor(
    app: App,
    private result: CheckResult,
    private withInfo: boolean,
  ) {
    super(app)
  }

  override onOpen() {
    const { contentEl } = this
    this.setTitle(`datme check: ${summary(this.result.counts)}`)
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
      .setName("Show notices")
      .setDesc("Also list links to unpublished notes and scheduled notes in the check report.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showNotices).onChange(async (v) => {
          this.plugin.settings.showNotices = v
          await this.plugin.saveSettings()
        }),
      )
  }
}
