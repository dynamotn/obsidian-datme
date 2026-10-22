/**
 * Links to notes datme does not publish look like any other in Obsidian, yet
 * the site shows them as plain text, a placeholder or nothing (`privateLinks`).
 * Here they get a dotted underline and a 🔒, with a tooltip saying what readers
 * will see, in live preview and in reading view. It decides as the status bar
 * does, so it works on a phone too.
 */
import type { Range } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import { editorInfoField, type MarkdownPostProcessorContext } from "obsidian"
import { frontmatterEnd, isIgnored, linksIn, noteState, privateLinkLabel } from "./logic"
import type DatmePlugin from "./main"

/** The tooltip of a link from a note, or undefined when the site shows it as a link (or it leads nowhere). */
export function privateLinkTip(plugin: DatmePlugin, link: { target: string; alias?: string }, sourcePath: string): string | undefined {
  const { app, config } = plugin
  const linkpath = link.target.split("#")[0]
  // A link to a heading of the note itself.
  if (!linkpath) return undefined
  const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)
  if (!file || file.extension !== "md") return undefined
  const { state, date } = noteState(app.metadataCache.getFileCache(file)?.frontmatter, config.mode, new Date())
  if (state === "published" && !isIgnored(file.path, config)) return undefined
  return privateLinkLabel({ target: file.basename, alias: link.alias }, config.privateLinks, { state: state === "published" ? "private" : state, date })
}

/** Reading view: the rendered links of a section. */
export function markRenderedLinks(plugin: DatmePlugin, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
  if (!plugin.settings.markPrivateLinks) return
  for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a.internal-link"))) {
    const target = a.dataset.href ?? a.getAttribute("href") ?? ""
    const text = a.textContent ?? ""
    const tip = privateLinkTip(plugin, { target, alias: text }, ctx.sourcePath)
    if (!tip) continue
    a.addClass("datme-private-link")
    a.setAttribute("aria-label", tip)
  }
}

class LockWidget extends WidgetType {
  constructor(private tip: string) {
    super()
  }

  override eq(other: LockWidget) {
    return other.tip === this.tip
  }

  toDOM() {
    const span = document.createElement("span")
    span.className = "datme-private-lock"
    span.textContent = "🔒"
    span.setAttribute("aria-label", this.tip)
    return span
  }
}

/** Live preview and source mode: the links of the lines in view. */
export function privateLinkMarker(plugin: DatmePlugin) {
  const build = (view: EditorView): DecorationSet => {
    const marks: Range<Decoration>[] = []
    if (!plugin.settings.markPrivateLinks) return Decoration.none
    const source = view.state.field(editorInfoField, false)?.file?.path
    if (!source) return Decoration.none
    const doc = view.state.doc
    // Links in the frontmatter are values of properties, not links on the page.
    const fmEnd = frontmatterEnd((n) => doc.line(n + 1).text, doc.lines) ?? -1
    for (const { from, to } of view.visibleRanges) {
      for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
        if (n - 1 <= fmEnd) continue
        const line = doc.line(n)
        for (const link of linksIn(line.text)) {
          const tip = privateLinkTip(plugin, link, source)
          if (!tip) continue
          marks.push(Decoration.mark({ class: "datme-private-link", attributes: { "aria-label": tip } }).range(line.from + link.from, line.from + link.to))
          marks.push(Decoration.widget({ widget: new LockWidget(tip), side: 1 }).range(line.from + link.to))
        }
      }
    }
    return Decoration.set(marks, true)
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.reconfigured)) this.decorations = build(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}
