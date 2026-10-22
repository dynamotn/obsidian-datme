/**
 * Publishing in the file explorer: a badge beside each note saying what datme
 * does with it, a count of published notes beside each folder, and, for a
 * folder or several selected files, publishing or keeping them all private at
 * once. It decides as the status bar does, so it works on a phone too.
 */
import { debounce, Modal, Notice, TFile, TFolder, type App, type Menu, type TAbstractFile, type View } from "obsidian"
import { BADGE_ICONS, badgeOf, folderCounts, isIgnored, publishFor } from "./logic"
import type DatmePlugin from "./main"

const BADGE_LABELS = {
  published: "datme publishes this note",
  private: "datme keeps this note private",
  draft: "A draft: datme publishes it once draft is removed",
  scheduled: "Scheduled: datme publishes it on its publish_date",
  unlisted: "Published, but kept off lists and feeds",
}

/** What the plugin uses of the file explorer, which Obsidian does not document. */
interface ExplorerView extends View {
  fileItems?: Record<string, { selfEl?: HTMLElement; el?: HTMLElement }>
}

export class ExplorerBadges {
  refresh = debounce(() => this.render(), 300, true)

  constructor(private plugin: DatmePlugin) {}

  private get app(): App {
    return this.plugin.app
  }

  /** Put the badges where they belong, or take them away when the setting is off. */
  render() {
    const on = this.plugin.settings.explorerBadges
    const { config } = this.plugin
    const now = new Date()
    const notes = this.app.vault.getMarkdownFiles().map((f) => ({ path: f.path, fm: this.app.metadataCache.getFileCache(f)?.frontmatter }))
    const folders = on ? folderCounts(notes, config, now) : new Map()
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const items = (leaf.view as ExplorerView).fileItems ?? {}
      for (const [path, item] of Object.entries(items)) {
        const self = item.selfEl ?? item.el
        if (!self) continue
        self.querySelector(":scope > .datme-badge")?.remove()
        if (!on) continue
        const file = this.app.vault.getAbstractFileByPath(path)
        if (file instanceof TFile && file.extension === "md" && !isIgnored(path, config)) {
          const badge = badgeOf(this.app.metadataCache.getFileCache(file)?.frontmatter, config.mode, now)
          self.createSpan({ cls: `datme-badge datme-badge-${badge}`, text: BADGE_ICONS[badge], attr: { "aria-label": BADGE_LABELS[badge] } })
        } else if (file instanceof TFolder && folders.has(path)) {
          const { published, total } = folders.get(path)!
          self.createSpan({
            cls: "datme-badge datme-badge-folder",
            text: `${published}/${total}`,
            attr: { "aria-label": `datme publishes ${published} of the ${total} notes in this folder` },
          })
        }
      }
    }
  }

  /** The notes a selection stands for: the notes themselves, and every note under a folder. */
  notesOf(files: TAbstractFile[]): TFile[] {
    const out = new Set<TFile>()
    const add = (f: TAbstractFile) => {
      if (f instanceof TFile && f.extension === "md" && !isIgnored(f.path, this.plugin.config)) out.add(f)
      else if (f instanceof TFolder) f.children.forEach(add)
    }
    files.forEach(add)
    return [...out].sort((a, b) => a.path.localeCompare(b.path))
  }

  /** *Publish all* and *Keep all private*, for a folder or several files. */
  addMenuItems(menu: Menu, files: TAbstractFile[]) {
    const notes = this.notesOf(files)
    if (!notes.length) return
    for (const publish of [true, false]) {
      menu.addItem((item) =>
        item
          .setTitle(publish ? "datme: publish all" : "datme: keep all private")
          .setIcon(publish ? "sprout" : "lock")
          .setSection("action")
          .onClick(() => this.confirm(notes, publish)),
      )
    }
  }

  private confirm(notes: TFile[], publish: boolean) {
    const mode = this.plugin.config.mode
    const changing = notes.filter((f) => publishFor(this.app.metadataCache.getFileCache(f)?.frontmatter, mode, publish) !== "keep")
    if (!changing.length) return void new Notice(publish ? "datme publishes all these notes already." : "All these notes are private already.")
    new BulkModal(this.app, changing, publish, async () => {
      let failed = 0
      for (const file of changing) {
        try {
          await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            const next = publishFor(fm, mode, publish)
            if (next === "keep") return
            if (next === undefined) delete fm.publish
            else fm.publish = next
          })
        } catch {
          failed++
        }
      }
      const done = changing.length - failed
      new Notice(
        `${publish ? "🌱" : "🔒"} ${done} note${done === 1 ? "" : "s"} ${publish ? "will be published" : "stay private"}` +
          (failed ? `; ${failed} could not be changed, their frontmatter cannot be read.` : "."),
        failed ? 8000 : 4000,
      )
    }).open()
  }
}

/** Lists the notes that change before changing them. */
class BulkModal extends Modal {
  constructor(
    app: App,
    private notes: TFile[],
    private publish: boolean,
    private onConfirm: () => Promise<void>,
  ) {
    super(app)
  }

  override onOpen() {
    const n = this.notes.length
    this.setTitle(this.publish ? `Publish ${n} note${n === 1 ? "" : "s"}?` : `Keep ${n} note${n === 1 ? "" : "s"} private?`)
    const list = this.contentEl.createEl("ul", { cls: "datme-bulk-list" })
    for (const f of this.notes) list.createEl("li", { text: f.path.replace(/\.md$/, "") })
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" })
    const ok = buttons.createEl("button", { text: this.publish ? "Publish" : "Keep private", cls: "mod-cta" })
    ok.addEventListener("click", () => {
      this.close()
      void this.onConfirm()
    })
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close())
  }

  override onClose() {
    this.contentEl.empty()
  }
}
