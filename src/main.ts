/**
 * datme for Obsidian: toggle whether a note is published, check the garden for
 * broken links, and preview the current note as the site will show it. The
 * plugin runs the datme command, so it works on desktop only.
 */
import { spawn, type ChildProcess } from "node:child_process"
import os from "node:os"
import {
  FileSystemAdapter,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type App,
} from "obsidian"
import {
  augmentedPath,
  groupProblems,
  isPublished,
  parseCheck,
  previewUrl,
  publishMode,
  splitCommand,
  summary,
  toggledPublish,
  type CheckResult,
  type PublishMode,
} from "./logic"

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

  /** Run datme with these arguments; resolves with its output once it exits. */
  private run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
