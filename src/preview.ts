/**
 * The page of the active note as `datme dev` serves it on localhost, in a pane
 * beside the editor. It follows the active note, scrolls with the editor to the
 * same heading, and has a toolbar for the look of the page: light or dark, the
 * width of a phone, and the 🎨 bar's style and layout. Desktop only: it needs
 * Electron's webview, and the datme command to serve the page.
 */
import { debounce, ItemView, MarkdownView, setIcon, TFile, type WorkspaceLeaf } from "obsidian"
import { headingAt, headingText, previewUrl, scrollScript } from "./logic"
import type DatmePlugin from "./main"

export const PREVIEW_VIEW = "datme-preview"

/** What the plugin uses of Electron's `<webview>`. */
interface Webview extends HTMLElement {
  src: string
  reload(): void
  executeJavaScript(code: string): Promise<unknown>
}

/** Whether this Obsidian lets plugins embed pages with `<webview>`. */
export function hasWebview(): boolean {
  return !(document.createElement("webview") instanceof HTMLUnknownElement)
}

export class PreviewView extends ItemView {
  private webview: Webview | undefined
  private message!: HTMLElement
  private frame!: HTMLElement
  /** The note shown, and its page path from `datme url`. */
  private file: TFile | null = null
  private page: string | undefined
  /** The address last given to the webview, which may show it under another after a redirect. */
  private shown: string | undefined
  /** The heading last scrolled to, so the page moves only when it changes. */
  private heading: string | undefined
  private runs = 0
  private follow = debounce((file: TFile) => void this.show(file), 300, true)
  private scrolled = debounce(() => this.syncScroll(), 150)

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: DatmePlugin,
  ) {
    super(leaf)
  }

  getViewType() {
    return PREVIEW_VIEW
  }

  getDisplayText() {
    return this.file ? `Preview: ${this.file.basename}` : "datme preview"
  }

  override getIcon() {
    return "sprout"
  }

  override async onOpen() {
    this.contentEl.addClass("datme-preview")
    this.toolbar(this.contentEl.createDiv({ cls: "datme-preview-toolbar" }))
    this.message = this.contentEl.createDiv({ cls: "datme-preview-message u-muted" })
    this.frame = this.contentEl.createDiv({ cls: "datme-preview-frame" })

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "md" && file !== this.file) this.follow(file)
      }),
    )
    // A new title, permalink or publish flag can move the page.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file === this.file) this.follow(file)
      }),
    )
    // Scroll events don't bubble: listen while they go down, for whatever scrolls in the note.
    this.registerDomEvent(document, "scroll", (e) => this.onScroll(e), { capture: true })
    const file = this.app.workspace.getActiveFile()
    if (file?.extension === "md") await this.show(file)
    else this.say("Open a note to preview it.")
  }

  override async onClose() {
    this.webview?.remove()
    this.webview = undefined
  }

  private toolbar(bar: HTMLElement) {
    const button = (icon: string, label: string, onClick: (el: HTMLElement) => void) => {
      const el = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } })
      setIcon(el, icon)
      el.addEventListener("click", () => onClick(el))
      return el
    }
    button("rotate-cw", "Reload", () => this.webview?.reload())
    button("external-link", "Open in the browser", () => {
      if (this.page !== undefined) window.open(this.url())
    })
    // The look of the page: toggles and pickers in the same row.
    this.plugin.previewLook.render(bar, () => this.lookChanged())
  }

  /** Show a note's page, starting the preview server when it is not running. */
  private async show(file: TFile) {
    const run = ++this.runs
    this.file = file
    this.heading = undefined
    // @ts-expect-error: refreshes the tab title, which Obsidian reads from getDisplayText
    this.leaf.updateHeader?.()
    this.say(`🌱 Finding ${file.basename} on the site…`)
    const page = await this.plugin.pagePath(file)
    if (run !== this.runs) return
    if (page === undefined) {
      this.page = undefined
      this.webview?.hide()
      return this.say(`${file.basename} is not published, so the site has no page for it.`)
    }
    if (!(await this.plugin.ensurePreview())) {
      if (run === this.runs) this.say("The datme preview did not start. Is the command right in the settings?")
      return
    }
    if (run !== this.runs) return
    this.page = page
    this.say("")
    this.loadPage()
  }

  /** The address of the page shown, with the look chosen in the toolbar. */
  private url(): string {
    return previewUrl(this.plugin.settings.port, this.page ?? "/") + this.plugin.previewLook.query()
  }

  /** A new look: a style or layout is another address; light, dark and phone width change the page in place. */
  private lookChanged() {
    this.frame.toggleClass("is-phone", this.plugin.previewLook.phone)
    if (this.page === undefined || !this.webview) return
    if (this.shown !== this.url()) this.loadPage()
    else this.applyLook()
  }

  private loadPage() {
    const url = this.url()
    if (!this.webview) {
      this.webview = this.frame.createEl("webview" as keyof HTMLElementTagNameMap) as unknown as Webview
      // The page keeps its own storage, apart from Obsidian's.
      this.webview.setAttribute("partition", "datme-preview")
      this.webview.addEventListener("dom-ready", () => {
        this.applyLook()
        this.heading = undefined
        this.syncScroll()
      })
      // The server stopped, or restarts after a change of datme.yaml: start it again and retry.
      this.webview.addEventListener("did-fail-load", (e) => {
        if ((e as Event & { isMainFrame?: boolean }).isMainFrame === false) return
        void this.plugin.ensurePreview().then((up) => {
          if (up) this.webview?.reload()
        })
      })
    }
    this.webview.show()
    this.frame.toggleClass("is-phone", this.plugin.previewLook.phone)
    if (this.shown !== url) {
      this.shown = url
      this.webview.src = url
    }
  }

  /** What the look needs once the page is loaded: light or dark, which the site keeps in the page. */
  private applyLook() {
    const script = this.plugin.previewLook.script()
    if (script) void this.webview?.executeJavaScript(script).catch(() => undefined)
  }

  private say(text: string) {
    this.message.setText(text)
    this.message.toggle(!!text)
  }

  private onScroll(e: Event) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view || view.file !== this.file || !(e.target instanceof Node) || !view.containerEl.contains(e.target)) return
    this.scrolled()
  }

  /** Scroll the page to the heading the editor shows at its top. */
  private syncScroll() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!this.webview || !view?.file || view.file !== this.file) return
    const headings = (this.app.metadataCache.getFileCache(view.file)?.headings ?? []).map((h) => ({
      heading: headingText(h.heading),
      level: h.level,
      line: h.position.start.line,
    }))
    const at = headingAt(headings, Math.floor(view.currentMode.getScroll()))
    const key = at?.heading ?? ""
    if (key === this.heading) return
    this.heading = key
    void this.webview.executeJavaScript(scrollScript(at?.heading)).catch(() => undefined)
  }
}
