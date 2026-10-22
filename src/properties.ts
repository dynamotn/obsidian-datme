/**
 * The properties datme reads, while they are written: the values a property
 * can take offered as you type them in the frontmatter, and values datme would
 * not take underlined with the words of `datme check`. Both work from the
 * plugin's own lists and datme.yaml, so on a phone too.
 */
import { RangeSetBuilder } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import { EditorSuggest, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from "obsidian"
import { frontmatterEnd, KNOWN_PROPERTIES, propertyChoices, propertyLine, propertyProblem, type Choice, type KnownProperty } from "./logic"
import type DatmePlugin from "./main"

const known = (key: string): key is KnownProperty => (KNOWN_PROPERTIES as readonly string[]).includes(key)

/** Offers the values of style, layout, chrome, stage, lang and password after their key in the frontmatter. */
export class PropertySuggest extends EditorSuggest<Choice> {
  private key: KnownProperty = "style"

  constructor(private plugin: DatmePlugin) {
    super(plugin.app)
    this.limit = 50
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const end = frontmatterEnd((n) => editor.getLine(n), editor.lineCount())
    if (end === undefined || cursor.line < 1 || cursor.line >= end) return null
    const line = editor.getLine(cursor.line).slice(0, cursor.ch)
    const at = propertyLine(line)
    if (!at || !known(at.key) || cursor.ch < at.from) return null
    this.key = at.key
    // Inside quotes, the value starts after them.
    const from = /["']/.test(line.charAt(at.from)) ? at.from + 1 : at.from
    return { start: { line: cursor.line, ch: from }, end: cursor, query: line.slice(from) }
  }

  getSuggestions(context: EditorSuggestContext): Choice[] {
    const query = context.query.trim().toLowerCase()
    const choices = propertyChoices(this.key, this.plugin.config, this.key === "password" ? this.plugin.passwordGroups() : [])
    return choices.filter((c) => c.value.toLowerCase().includes(query)).sort((a, b) => +!a.value.toLowerCase().startsWith(query) - +!b.value.toLowerCase().startsWith(query))
  }

  renderSuggestion(choice: Choice, el: HTMLElement) {
    el.addClass("mod-complex")
    const content = el.createDiv({ cls: "suggestion-content" })
    content.createDiv({ cls: "suggestion-title", text: choice.value })
    if (choice.description) content.createDiv({ cls: "suggestion-note", text: choice.description })
  }

  selectSuggestion(choice: Choice) {
    const ctx = this.context
    if (!ctx) return
    // The rest of the line goes too: picking a value replaces the one being written.
    const line = ctx.editor.getLine(ctx.start.line)
    const at = propertyLine(line)
    const end = at ? { line: ctx.start.line, ch: Math.max(at.to, ctx.end.ch) } : ctx.end
    // An @group needs quotes, since @ cannot start a plain YAML value.
    const quoted = this.key === "password" && line.charAt(ctx.start.ch - 1) !== '"' && line.charAt(ctx.start.ch - 1) !== "'"
    ctx.editor.replaceRange(quoted ? `"${choice.value}"` : choice.value, ctx.start, end)
  }
}

const problemMark = (message: string) => Decoration.mark({ class: "datme-property-problem", attributes: { "aria-label": message, title: message } })

/** Underlines, in the frontmatter of the note being edited, the values datme would not take. */
export function propertyLinter(plugin: DatmePlugin) {
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>()
    const doc = view.state.doc
    const end = frontmatterEnd((n) => doc.line(n + 1).text, doc.lines)
    if (end === undefined) return builder.finish()
    for (let n = 1; n < end; n++) {
      const line = doc.line(n + 1)
      const at = propertyLine(line.text)
      if (!at || !known(at.key)) continue
      const message = propertyProblem(at.key, at.value, plugin.config)
      if (message && at.to > at.from) builder.add(line.from + at.from, line.from + at.to, problemMark(message))
    }
    return builder.finish()
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(u: ViewUpdate) {
        // The plugin reconfigures editors when datme.yaml changes, which counts as a new viewport.
        if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.reconfigured)) this.decorations = build(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}
