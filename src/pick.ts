/**
 * *Set style…* and *Set layout…*: every style or layout with a line on it,
 * which one the note has now and the rule that gives it, as the 🎨 bar says.
 * Choosing one writes it in the frontmatter, *Default* removes it; on the
 * desktop, Mod+Enter tries it in the preview pane first, writing nothing.
 */
import { FuzzySuggestModal, getAllTags, Notice, Platform, type App, type FuzzyMatch, type TFile } from "obsidian"
import { explainLayout, explainStyle, LAYOUTS, STYLES, type Choice, type Look } from "./logic"
import type DatmePlugin from "./main"

export type LookKey = "style" | "layout"

type Item = Choice & { remove?: true }

export class LookModal extends FuzzySuggestModal<Item> {
  private look: Look

  constructor(
    app: App,
    private plugin: DatmePlugin,
    private file: TFile,
    private key: LookKey,
  ) {
    super(app)
    const cache = app.metadataCache.getFileCache(file)
    const note = { path: file.path, fm: cache?.frontmatter, tags: cache ? (getAllTags(cache) ?? []) : [] }
    this.look = key === "style" ? explainStyle(note, plugin.config, new Date()) : explainLayout(note)
    this.setPlaceholder(`${key === "style" ? "Style" : "Layout"} of ${file.basename}: ${this.look.value ?? "none"}, from ${this.look.rule}`)
    const instructions = [
      { command: "↑↓", purpose: "to choose" },
      { command: "↵", purpose: `to write ${key}:` },
    ]
    if (Platform.isDesktopApp) {
      instructions.push({ command: Platform.isMacOS ? "⌘ ↵" : "ctrl ↵", purpose: "to preview without writing" })
      this.scope.register(["Mod"], "Enter", (evt) => {
        evt.preventDefault()
        const item = this.highlighted()
        if (item) void this.preview(item)
        return false
      })
    }
    this.setInstructions(instructions)
  }

  getItems(): Item[] {
    const list = this.key === "style" ? STYLES : LAYOUTS
    const current = this.file && this.app.metadataCache.getFileCache(this.file)?.frontmatter?.[this.key]
    const own = current != null && String(current).trim() !== ""
    const items: Item[] = list.map((c) => ({ ...c, description: c.value === this.look.value ? `${c.description} · now, from ${this.look.rule}` : c.description }))
    return own ? [{ value: "Default", description: `Remove ${this.key}: from the note`, remove: true }, ...items] : items
  }

  getItemText(item: Item): string {
    return `${item.value} ${item.description}`
  }

  override renderSuggestion(match: FuzzyMatch<Item>, el: HTMLElement) {
    el.addClass("mod-complex")
    const content = el.createDiv({ cls: "suggestion-content" })
    content.createDiv({ cls: "suggestion-title", text: match.item.value })
    content.createDiv({ cls: "suggestion-note", text: match.item.description })
  }

  async onChooseItem(item: Item) {
    try {
      await this.app.fileManager.processFrontMatter(this.file, (fm: Record<string, unknown>) => {
        if (item.remove) delete fm[this.key]
        else fm[this.key] = item.value
      })
    } catch (e) {
      return void new Notice(`datme could not change ${this.file.basename}: its frontmatter cannot be read (${(e as Error).message}).`, 8000)
    }
    new Notice(item.remove ? `${this.file.basename} has no ${this.key} of its own now` : `${this.file.basename}: ${this.key} ${item.value}`)
  }

  /** Try the item in the preview pane, keeping the modal open to compare more. */
  private async preview(item: Item) {
    const look = this.plugin.previewLook
    look[this.key] = item.remove ? (this.key === "layout" ? "none" : "") : item.value
    await this.plugin.openPreviewPane()
    this.plugin.previewLookChanged()
  }

  /** The item under the cursor, from the list Obsidian keeps but does not document. */
  private highlighted(): Item | undefined {
    const chooser = (this as unknown as { chooser?: { values?: FuzzyMatch<Item>[]; selectedItem?: number } }).chooser
    return chooser?.values?.[chooser.selectedItem ?? 0]?.item
  }
}
