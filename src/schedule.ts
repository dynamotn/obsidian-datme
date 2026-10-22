/**
 * *Schedule this note…*: a day, and a time if wanted, written as the note's
 * `publish_date`. datme publishes it on the first build from then on. A
 * private note is marked published as well, or the date would do nothing.
 */
import { Modal, Notice, Setting, type App, type TFile } from "obsidian"
import { isPublished, publishDateValue, toggledPublish, type PublishMode } from "./logic"

export class ScheduleModal extends Modal {
  constructor(
    app: App,
    private file: TFile,
    private mode: PublishMode,
  ) {
    super(app)
  }

  override onOpen() {
    const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter
    const current = fm?.publish_date ?? fm?.publishDate
    const at = current ? new Date(String(current)) : undefined
    const known = at && !Number.isNaN(at.getTime())
    const tomorrow = new Date(Date.now() + 86_400_000)
    const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString()
    // A day alone is the start of that day in UTC: it is shown as written, not moved into this time zone.
    const timed = known && /T\d/.test(String(current))
    let day = known ? (timed ? local(at) : String(current)).slice(0, 10) : local(tomorrow).slice(0, 10)
    let time = timed ? local(at).slice(11, 16) : ""

    this.setTitle(`Schedule ${this.file.basename}`)
    this.contentEl.createEl("p", {
      cls: "u-muted",
      text: "datme publishes the note on the first build from then on: the site needs a daily build for it to appear on its day.",
    })
    new Setting(this.contentEl).setName("Day").addText((t) => {
      t.inputEl.type = "date"
      t.setValue(day).onChange((v) => (day = v))
    })
    new Setting(this.contentEl)
      .setName("Time")
      .setDesc("Optional. Kept with this computer's time zone.")
      .addText((t) => {
        t.inputEl.type = "time"
        t.setValue(time).onChange((v) => (time = v))
      })
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Schedule")
        .setCta()
        .onClick(() => void this.save(day, time)),
    )
  }

  private async save(day: string, time: string) {
    let value: string
    try {
      value = publishDateValue(day, time || undefined, -new Date().getTimezoneOffset())
    } catch (e) {
      return void new Notice((e as Error).message)
    }
    let flipped = false
    try {
      await this.app.fileManager.processFrontMatter(this.file, (fm: Record<string, unknown>) => {
        delete fm.publishDate
        fm.publish_date = value
        if (!isPublished(fm, this.mode)) {
          const next = toggledPublish(fm, this.mode)
          if (next === undefined) delete fm.publish
          else fm.publish = next
          flipped = true
        }
      })
    } catch (e) {
      return void new Notice(`datme could not change ${this.file.basename}: its frontmatter cannot be read (${(e as Error).message}).`, 8000)
    }
    this.close()
    new Notice(`⏳ ${this.file.basename} is published from ${value.replace("T", " ").slice(0, 16)}${flipped ? " (it was private)" : ""}`)
  }

  override onClose() {
    this.contentEl.empty()
  }
}

/** Remove a note's `publish_date`, so the next build publishes it. */
export async function unschedule(app: App, file: TFile) {
  let had = false
  try {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      had = fm.publish_date != null || fm.publishDate != null
      delete fm.publish_date
      delete fm.publishDate
    })
  } catch (e) {
    return void new Notice(`datme could not change ${file.basename}: its frontmatter cannot be read (${(e as Error).message}).`, 8000)
  }
  new Notice(had ? `${file.basename} has no publish_date now: the next build publishes it, if it is published.` : `${file.basename} was not scheduled.`)
}
