/**
 * *Coming up*, on the dashboard: the scheduled notes of the next 30 days on a
 * small calendar, a day opening its note or listing its notes below, and a word on the deploy
 * pipeline when it may not build on their day: datme publishes a scheduled
 * note on the first build from its `publish_date` on.
 */
import type { DataAdapter } from "obsidian"
import { pipelineSchedule, PIPELINE_FILES, scheduleCalendar, WORKFLOW_DIR, type PipelineSchedule } from "./logic"

const DAYS = 30
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

/** The pipeline files are read again at most this often: Obsidian tells nothing of changes in hidden folders. */
const FRESH = 30_000
let cached: { at: number; schedule: PipelineSchedule } | undefined

/** What the vault's deploy pipeline says about daily builds, from its files. */
export async function readPipeline(adapter: DataAdapter): Promise<PipelineSchedule> {
  if (cached && Date.now() - cached.at < FRESH) return cached.schedule
  const files: { path: string; text: string }[] = []
  const read = async (path: string) => {
    try {
      if (await adapter.exists(path)) files.push({ path, text: await adapter.read(path) })
    } catch {
      // unreadable: as if it were not there
    }
  }
  try {
    if (await adapter.exists(WORKFLOW_DIR)) {
      for (const path of (await adapter.list(WORKFLOW_DIR)).files) if (/\.ya?ml$/.test(path)) await read(path)
    }
  } catch {
    // no workflows to read
  }
  for (const path of PIPELINE_FILES) await read(path)
  const schedule = pipelineSchedule(files)
  cached = { at: Date.now(), schedule }
  return schedule
}

/** The *Coming up* section: nothing when no note is scheduled in the next days. */
export async function renderCalendar(
  el: HTMLElement,
  scheduled: { path: string; date: string }[],
  adapter: DataAdapter,
  open: (path: string) => void,
) {
  const days = scheduleCalendar(scheduled, new Date(), DAYS)
  const soon = days.reduce((n, d) => n + d.notes.length, 0)
  if (!soon) return
  const section = el.createDiv({ cls: "datme-calendar-section" })
  section.createEl("h4", { text: "Coming up" })
  const grid = section.createDiv({ cls: "datme-calendar" })
  // The notes of the day picked, when it has several.
  const picked = section.createDiv({ cls: "datme-calendar-picked" })
  for (const w of WEEKDAYS) grid.createDiv({ cls: "datme-calendar-weekday", text: w })
  for (let i = 0; i < days[0].weekday; i++) grid.createDiv({ cls: "datme-calendar-day is-empty" })
  days.forEach((day, i) => {
    const [, month, date] = day.date.split("-")
    // The month shows where it starts, and on the first day shown.
    const label = i === 0 || date === "01" ? `${Number(date)}/${Number(month)}` : String(Number(date))
    const cell = grid.createDiv({ cls: "datme-calendar-day", text: label })
    if (i === 0) cell.addClass("is-today")
    if (!day.notes.length) return
    cell.addClass("has-notes")
    cell.createDiv({ cls: "datme-calendar-dots", text: "•".repeat(Math.min(day.notes.length, 3)) })
    const names = day.notes.map((p) => p.replace(/\.md$/, "").split("/").pop()!)
    cell.setAttribute("aria-label", `${day.date}: ${names.join(", ")}`)
    cell.addEventListener("click", () => {
      if (day.notes.length === 1) return open(day.notes[0])
      const again = cell.hasClass("is-picked")
      grid.querySelectorAll(".is-picked").forEach((c) => c.removeClass("is-picked"))
      picked.empty()
      if (again) return
      cell.addClass("is-picked")
      picked.createDiv({ cls: "u-muted", text: day.date })
      const list = picked.createEl("ul")
      day.notes.forEach((path, j) => {
        const a = list.createEl("li").createEl("a", { text: names[j], href: "#" })
        a.addEventListener("click", (e) => {
          e.preventDefault()
          open(path)
        })
      })
    })
  })
  const pipeline = await readPipeline(adapter)
  if (pipeline.kind !== "daily") {
    section.createEl("p", {
      cls: pipeline.kind === "unknown" ? "u-muted datme-calendar-note" : "datme-calendar-warning",
      text: `${pipeline.kind === "unknown" ? "ℹ️" : "⚠️"} ${pipeline.advice}`,
    })
  }
}
