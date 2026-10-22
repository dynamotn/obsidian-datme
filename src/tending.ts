/**
 * The garden's to-do list, on the dashboard: orphans and dead ends from the
 * last check, notes readers see as out of date, and fleeting or literature
 * notes left alone too long, oldest first. *Snooze* hides one for a month,
 * *Done* counts as tending it. A count can sit in the status bar too.
 */
import { setIcon } from "obsidian"
import { ago, prunedTendState, stillToTend, tendingQueue, tendKey, type TendItem } from "./logic"
import type DatmePlugin from "./main"

const SNOOZE_DAYS = 30
const SHOWN = 15

const ICONS: Record<TendItem["kind"], string> = { orphan: "🪴", "dead-end": "🚧", outdated: "⏳", stalled: "🌾" }

/** What is still to tend now, with the queue it comes from. */
export function tendingNow(plugin: DatmePlugin): { queue: TendItem[]; todo: TendItem[] } {
  const { app, config, report, settings } = plugin
  const notes = app.vault.getMarkdownFiles().map((f) => ({ path: f.path, fm: app.metadataCache.getFileCache(f)?.frontmatter, mtime: f.stat.mtime }))
  const now = Date.now()
  const queue = tendingQueue(notes, report?.result, config, now, settings.staleDays)
  return { queue, todo: stillToTend(queue, settings.tend, now, report?.at, config, settings.staleDays) }
}

/** Snooze an item, or mark it done, and forget what no longer matters. */
async function mark(plugin: DatmePlugin, item: TendItem, how: "snooze" | "done", queue: TendItem[]) {
  const now = Date.now()
  const state = prunedTendState(plugin.settings.tend, queue, now)
  if (how === "snooze") state.snoozed[tendKey(item)] = now + SNOOZE_DAYS * 86_400_000
  else state.done[tendKey(item)] = now
  plugin.settings.tend = state
  await plugin.saveSettings()
  plugin.tendingChanged()
}

/** The *Tend* section of the dashboard. */
export function renderTending(plugin: DatmePlugin, el: HTMLElement, openNote: (parent: HTMLElement, path: string) => void) {
  const { queue, todo } = tendingNow(plugin)
  el.createEl("h4", { text: "Tend" })
  if (!todo.length) {
    const hint = plugin.report ? "Nothing to tend. 🌱" : "Nothing to tend yet; a check finds orphans and dead ends."
    return void el.createEl("p", { text: hint, cls: "u-muted" })
  }
  const list = el.createEl("ul", { cls: "datme-tend" })
  const now = Date.now()
  for (const item of todo.slice(0, SHOWN)) {
    const li = list.createEl("li")
    li.createSpan({ text: `${ICONS[item.kind]} ` })
    openNote(li, item.path)
    li.createDiv({ cls: "u-muted datme-tend-why", text: `${item.why} · tended ${ago(item.since, now)}` })
    const actions = li.createDiv({ cls: "datme-tend-actions" })
    const button = (icon: string, label: string, how: "snooze" | "done") => {
      const b = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } })
      setIcon(b, icon)
      b.addEventListener("click", () => void mark(plugin, item, how, queue))
    }
    button("alarm-clock", `Snooze for ${SNOOZE_DAYS} days`, "snooze")
    button("check", "Done: I tended it", "done")
  }
  if (todo.length > SHOWN) el.createEl("p", { cls: "u-muted", text: `…and ${todo.length - SHOWN} more.` })
}

/** The status bar's "3 notes to tend", when the setting is on. */
export function tendingStatus(plugin: DatmePlugin, el: HTMLElement) {
  if (!plugin.settings.tendCount) return void el.hide()
  const notes = new Set(tendingNow(plugin).todo.map((i) => i.path)).size
  el.toggle(notes > 0)
  el.setText(`🌿 ${notes} note${notes === 1 ? "" : "s"} to tend`)
  el.setAttribute("aria-label", "Open the garden dashboard")
}
