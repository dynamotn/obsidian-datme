/**
 * datme.yaml in a pane of its own, since Obsidian opens no YAML file: keys
 * and values completed from datme's JSON Schema, with their descriptions, and
 * what the schema refuses underlined as you type. The schema comes from
 * datme's site, kept in the vault for a phone or a day offline.
 */
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { forceLinting, lintGutter, linter, type Diagnostic } from "@codemirror/lint"
import { EditorView, hoverTooltip, keymap, lineNumbers } from "@codemirror/view"
import { debounce, ItemView, Notice, parseYaml, requestUrl, type ViewStateResult, type WorkspaceLeaf } from "obsidian"
import { configProblems, describe, keyChoices, valueChoices, yamlErrorLine, yamlOutline, yamlPlace, type Schema } from "./config-schema"
import type DatmePlugin from "./main"

export const CONFIG_VIEW = "datme-config"
export const SCHEMA_URL = "https://dynamo-brain.gitlab.io/datme/datme.schema.json"
/** Where the schema is kept for when the site cannot be reached. */
export const SCHEMA_CACHE = ".datme/schema.json"

const isSchema = (v: unknown): v is Schema => typeof v === "object" && v !== null && "properties" in v

/** datme's schema: the kept copy at once, then the site's, once a session; undefined until one is read. */
export async function loadSchema(plugin: DatmePlugin, onChange: () => void) {
  const adapter = plugin.app.vault.adapter
  if (!plugin.schema) {
    try {
      const kept = JSON.parse(await adapter.read(SCHEMA_CACHE)) as unknown
      if (isSchema(kept)) plugin.schema = kept
    } catch {
      // no copy kept yet
    }
    if (plugin.schema) onChange()
  }
  if (plugin.schemaFetched) return
  plugin.schemaFetched = true
  try {
    const res = await requestUrl({ url: SCHEMA_URL, throw: false })
    const fetched = res.status === 200 ? (JSON.parse(res.text) as unknown) : undefined
    if (!isSchema(fetched)) return
    plugin.schema = fetched
    onChange()
    if (!(await adapter.exists(".datme"))) await adapter.mkdir(".datme")
    await adapter.write(SCHEMA_CACHE, JSON.stringify(fetched))
  } catch {
    // offline, or a read-only vault: the kept copy serves
    plugin.schemaFetched = false
  }
}

export class ConfigView extends ItemView {
  private path = ""
  private editor: EditorView | undefined
  /** The file as last read or written, to tell a change made elsewhere. */
  private synced = ""
  private save = debounce(() => void this.write(), 1000, true)

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: DatmePlugin,
  ) {
    super(leaf)
  }

  getViewType() {
    return CONFIG_VIEW
  }

  getDisplayText() {
    return this.path || "datme.yaml"
  }

  override getIcon() {
    return "settings"
  }

  override getState() {
    return { path: this.path }
  }

  override async setState(state: unknown, result: ViewStateResult) {
    const path = (state as { path?: unknown })?.path
    if (typeof path === "string" && path !== this.path) {
      this.path = path
      await this.readFile()
    }
    return super.setState(state, result)
  }

  override async onOpen() {
    this.contentEl.addClass("datme-config")
    // A save from elsewhere is taken in, unless this pane has edits of its own.
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f.path === this.path && this.editor?.state.doc.toString() === this.synced) void this.readFile()
      }),
    )
    void loadSchema(this.plugin, () => this.refresh())
  }

  override async onClose() {
    await this.write()
    this.editor?.destroy()
    this.editor = undefined
  }

  private async readFile() {
    let text: string
    try {
      text = await this.app.vault.adapter.read(this.path)
    } catch (e) {
      return void new Notice(`datme could not read ${this.path}: ${(e as Error).message}`, 6000)
    }
    this.synced = text
    if (this.editor) {
      if (this.editor.state.doc.toString() !== text) this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: text } })
      return
    }
    this.editor = new EditorView({ parent: this.contentEl, doc: text, extensions: this.extensions() })
  }

  /** Lint and completion again, once the schema came. */
  private refresh() {
    if (this.editor) forceLinting(this.editor)
  }

  private async write() {
    const text = this.editor?.state.doc.toString()
    if (text === undefined || text === this.synced) return
    const adapter = this.app.vault.adapter
    // Never over what another device or app wrote meanwhile.
    const disk = await adapter.read(this.path).catch(() => undefined)
    if (disk !== undefined && disk !== this.synced) {
      return void new Notice(`${this.path} changed elsewhere; your edits here are not saved. Copy them, then close and open it again.`, 10000)
    }
    try {
      await adapter.write(this.path, text)
    } catch (e) {
      return void new Notice(`datme could not save ${this.path}: ${(e as Error).message}`, 10000)
    }
    this.synced = text
    await this.plugin.reloadConfig()
  }

  private extensions() {
    const schema = () => this.plugin.schema
    return [
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => u.docChanged && this.save()),
      autocompletion({ override: [(ctx) => complete(schema(), ctx)] }),
      linter((view) => lint(schema(), view.state.doc.toString()), { delay: 400 }),
      lintGutter(),
      hoverTooltip((view, pos) => {
        const s = schema()
        const entry = s && yamlOutline(view.state.doc.toString()).find((e) => e.key.from <= pos && pos <= e.key.to)
        const text = entry && describe(s, entry.path)
        if (!entry || !text) return null
        return { pos: entry.key.from, end: entry.key.to, create: () => ({ dom: createDiv({ cls: "datme-config-hover", text }) }) }
      }),
    ]
  }
}

function complete(schema: Schema | undefined, ctx: CompletionContext): CompletionResult | null {
  if (!schema) return null
  const place = yamlPlace(ctx.state.sliceDoc(0, ctx.pos))
  if (!place) return null
  const choices = place.kind === "key" ? keyChoices(schema, place.path) : valueChoices(schema, place.path)
  if (!choices.length || (place.from === ctx.pos && !ctx.explicit && place.kind === "key")) return null
  return {
    from: place.from,
    validFor: /^[\w.:/-]*$/,
    options: choices.map((c) => ({
      label: c.label,
      apply: place.kind === "key" ? `${c.value}: ` : c.value,
      detail: c.type,
      info: c.description,
      type: place.kind === "key" ? "property" : "enum",
    })),
  }
}

function lint(schema: Schema | undefined, text: string): Diagnostic[] {
  let config: unknown
  try {
    config = parseYaml(text)
  } catch (e) {
    const n = yamlErrorLine(e)
    const lines = text.split("\n")
    const from = n === undefined ? 0 : lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0)
    const to = n === undefined ? 0 : from + (lines[n]?.length ?? 0)
    return [{ from, to: Math.min(to, text.length), severity: "error", message: `not valid YAML: ${(e as Error).message}`, source: "datme" }]
  }
  // The schema is stricter than datme in places (a theme pack's own style): a warning, not an error.
  return schema ? configProblems(schema, text, config).map((p) => ({ ...p, severity: "warning", source: "datme schema" })) : []
}
