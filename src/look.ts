/**
 * How the preview pane shows a page: light or dark, at a phone's width, and
 * with the style, layout or frame the 🎨 bar of `datme dev` can try on a note
 * without writing anything (`?style=`, `?layout=`, `?chrome=`).
 */
import { setIcon } from "obsidian"
import { CHROMES, LAYOUTS, STYLES, type Choice } from "./logic"

export type Scheme = "auto" | "light" | "dark"

const SCHEMES: Record<Scheme, { icon: string; label: string; next: Scheme }> = {
  auto: { icon: "sun-moon", label: "As the site decides: click for light", next: "light" },
  light: { icon: "sun", label: "Light: click for dark", next: "dark" },
  dark: { icon: "moon", label: "Dark: click to let the site decide", next: "auto" },
}

export class PreviewLook {
  scheme: Scheme = "auto"
  phone = false
  /** "" keeps what the note and datme.yaml decide. */
  style = ""
  layout = ""
  chrome = ""
  /** Puts the toolbar's controls back in line with the choices, when they change elsewhere. */
  private controls: (() => void)[] = []

  /** Show the choices in the toolbar again, after they changed elsewhere. */
  sync() {
    for (const update of this.controls) update()
  }

  /** The 🎨 bar's query for the choices made, or "". */
  query(): string {
    const params = new URLSearchParams()
    if (this.style) params.set("style", this.style)
    if (this.layout) params.set("layout", this.layout)
    if (this.chrome) params.set("chrome", this.chrome)
    const q = params.toString()
    return q ? `?${q}` : ""
  }

  /**
   * A script that puts the page in the chosen scheme, as the site's own
   * toggle does: `theme` in localStorage and `data-theme` on the root. Letting
   * the site decide again needs a reload, once the stored choice is gone.
   */
  script(): string {
    if (this.scheme === "auto") return `if (localStorage.getItem("theme")) { localStorage.removeItem("theme"); location.reload() }`
    const v = JSON.stringify(this.scheme)
    return `localStorage.setItem("theme", ${v}); document.documentElement.dataset.theme = ${v}`
  }

  /** The toggles and pickers, at the end of a toolbar; onChange runs after each choice. */
  render(bar: HTMLElement, onChange: () => void) {
    this.controls = []
    const scheme = bar.createEl("button", { cls: "clickable-icon" })
    const showScheme = () => {
      setIcon(scheme, SCHEMES[this.scheme].icon)
      scheme.setAttribute("aria-label", SCHEMES[this.scheme].label)
    }
    showScheme()
    this.controls.push(showScheme)
    scheme.addEventListener("click", () => {
      this.scheme = SCHEMES[this.scheme].next
      showScheme()
      onChange()
    })

    const phone = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Phone width" } })
    setIcon(phone, "smartphone")
    phone.toggleClass("is-active", this.phone)
    this.controls.push(() => phone.toggleClass("is-active", this.phone))
    phone.addEventListener("click", () => {
      this.phone = !this.phone
      phone.toggleClass("is-active", this.phone)
      onChange()
    })

    const select = (label: string, choices: Choice[], get: () => string, set: (v: string) => void) => {
      const el = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": label } })
      el.createEl("option", { text: `${label}: the note's`, value: "" })
      for (const c of choices) el.createEl("option", { text: c.value, value: c.value, attr: { title: c.description } })
      el.value = get()
      this.controls.push(() => (el.value = get()))
      el.addEventListener("change", () => {
        set(el.value)
        onChange()
      })
    }
    select("Style", STYLES, () => this.style, (v) => (this.style = v))
    // "none" previews the note without the layout it names.
    select("Layout", [{ value: "none", description: "No layout" }, ...LAYOUTS], () => this.layout, (v) => (this.layout = v))
    select("Frame", CHROMES, () => this.chrome, (v) => (this.chrome = v))
  }
}
