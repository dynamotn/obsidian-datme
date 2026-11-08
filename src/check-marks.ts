/**
 * The problems of the last check, in the note being edited: underlined, with
 * a marker in the gutter and the message on hover. A check reads the notes as
 * they were when it started; the edits made meanwhile move its places, so they
 * are kept from that moment and the places mapped through them.
 */
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint"
import { ChangeSet, MapMode, StateEffect, StateField, type Text } from "@codemirror/state"
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import { editorInfoField, TFile } from "obsidian"
import { noteProblems, placeProblems } from "./logic"
import type DatmePlugin from "./main"

/** A check starts reading this document, or the places of the last one are known in it from now; null: unknown. */
const checkFrom = StateEffect.define<Text | null>()

/** The document a running check reads, and the edits made since. */
const sinceCheck = StateField.define<{ doc: Text; changes: ChangeSet } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(checkFrom)) return e.value && { doc: e.value, changes: ChangeSet.empty(e.value.length) }
    return value && tr.docChanged ? { doc: value.doc, changes: value.changes.compose(tr.changes) } : value
  },
})

const fileOf = (view: EditorView) => view.state.field(editorInfoField, false)?.file ?? null

/** Each editor holding a note, so a check can find them. */
const views = new Set<EditorView>()

export function checkMarks(plugin: DatmePlugin) {
  return [
    sinceCheck,
    lintGutter(),
    ViewPlugin.fromClass(
      class {
        private path: string | undefined
        constructor(private view: EditorView) {
          views.add(view)
          this.path = fileOf(view)?.path
          // An editor cannot be changed while it is being set up: right after.
          queueMicrotask(() => views.has(view) && showIn(plugin, view))
        }
        update(u: ViewUpdate) {
          // Obsidian may keep the editor and swap the note in it.
          const path = fileOf(u.view)?.path
          if (path === this.path) return
          this.path = path
          // The edits kept belong to the note that was there.
          queueMicrotask(() => views.has(u.view) && showIn(plugin, u.view, true))
        }
        destroy() {
          views.delete(this.view)
        }
      },
    ),
  ]
}

/** A check is about to read the vault: each editor that matches its file on disk keeps its edits from now on. */
export async function checkStarts(plugin: DatmePlugin) {
  for (const view of views) {
    const file = fileOf(view)
    if (!file) continue
    const doc = view.state.doc
    const same = (await plugin.app.vault.read(file).catch(() => undefined)) === doc.toString()
    if (views.has(view)) view.dispatch({ effects: checkFrom.of(same ? doc : null) })
  }
}

/** A check failed: the editors stop keeping their edits. */
export function checkFailed() {
  for (const view of views) if (view.state.field(sinceCheck, false)) view.dispatch({ effects: checkFrom.of(null) })
}

/** Show the last report in every editor: after a check, or once a saved one is read. */
export function showProblems(plugin: DatmePlugin) {
  for (const view of views) showIn(plugin, view)
}

/**
 * Show the last report's problems in an editor, where they still have a
 * place. The edits are kept until the next check, so showing them again
 * later (another setting, the note swapped back) still finds their places.
 */
function showIn(plugin: DatmePlugin, view: EditorView, swapped = false) {
  const file = fileOf(view)
  if (!file) return
  const report = plugin.report
  const tracked = swapped ? null : view.state.field(sinceCheck, false)
  // Without the check's own document, only a note unchanged on disk since the check, and opened as it is there, has its places right.
  const fresh = !tracked && report?.at !== undefined && file instanceof TFile && file.stat.mtime <= report.at
  const base = tracked?.doc ?? (fresh ? view.state.doc : undefined)
  const problems = base ? noteProblems(report?.result, file.path, plugin.settings.showNotices) : []
  // A place whose text was deleted since is dropped.
  const map = tracked ? (pos: number, assoc: -1 | 1) => tracked.changes.mapPos(pos, assoc, MapMode.TrackDel) : undefined
  const diagnostics: Diagnostic[] = placeProblems(problems, base!, map).map((p) => ({ from: p.from, to: p.to, severity: p.level, message: p.message, source: "datme" }))
  view.dispatch(setDiagnostics(view.state, diagnostics), tracked ? {} : { effects: checkFrom.of(fresh ? view.state.doc : null) })
}
