import { describe, expect, test } from "bun:test"
import {
  ago,
  badgeOf,
  folderCounts,
  headingAt,
  headingText,
  publishFor,
  scrollScript,
  augmentedPath,
  gardenConfig,
  gardenCounts,
  groupProblems,
  isIgnored,
  isPublished,
  locate,
  mentionLink,
  noteState,
  parseCheck,
  parseSuggestions,
  previewUrl,
  relatedWhy,
  splitCommand,
  summary,
  toggledPublish,
  type Problem,
} from "../src/logic"

describe("publishing", () => {
  test("a note is published as datme decides it", () => {
    expect(isPublished({ publish: true }, "explicit")).toBe(true)
    expect(isPublished({ publish: "true" }, "explicit")).toBe(true)
    expect(isPublished({}, "explicit")).toBe(false)
    expect(isPublished(undefined, "all")).toBe(true)
    expect(isPublished({ publish: false }, "all")).toBe(false)
  })

  test("a draft or a note waiting for its publish_date is not published yet, as datme decides it", () => {
    const now = new Date("2026-10-16")
    expect(noteState({ publish: true, draft: true }, "explicit", now)).toEqual({ state: "draft" })
    expect(noteState({ publish: true, publish_date: "2027-01-02" }, "explicit", now)).toEqual({ state: "scheduled", date: "2027-01-02" })
    expect(noteState({ publish: true, publish_date: "2026-01-02" }, "explicit", now)).toEqual({ state: "published" })
    expect(noteState({ draft: true }, "explicit", now)).toEqual({ state: "private" })
  })

  test("toggling sets the key it needs, and removes it when the default does the job", () => {
    expect(toggledPublish({}, "explicit")).toBe(true)
    expect(toggledPublish({ publish: true }, "explicit")).toBeUndefined()
    expect(toggledPublish({}, "all")).toBe(false)
    expect(toggledPublish({ publish: false }, "all")).toBeUndefined()
  })
})

describe("running datme", () => {
  test("the command splits into words, quotes kept together", () => {
    expect(splitCommand("bunx @dynamotn/datme")).toEqual(["bunx", "@dynamotn/datme"])
    expect(splitCommand('"/Applications/My Tools/datme" --fresh')).toEqual(["/Applications/My Tools/datme", "--fresh"])
  })

  test("PATH gains the usual tool folders once", () => {
    expect(augmentedPath("/usr/bin:/opt/homebrew/bin", "/Users/me")).toBe(
      "/usr/bin:/opt/homebrew/bin:/Users/me/.bun/bin:/usr/local/bin:/Users/me/.local/bin:/Users/me/.npm-global/bin",
    )
  })

  test("the check report is read even after other output", () => {
    const r = parseCheck('Checking…\n{"counts":{"error":1,"warning":0,"info":0},"problems":[{"level":"error","file":"a.md","message":"x"}]}\n')
    expect(r.counts.error).toBe(1)
    expect(() => parseCheck("command not found")).toThrow("did not answer")
  })

  test("problems group by file, the worst first, notices only on request", () => {
    const ps: Problem[] = [
      { level: "info", file: "c.md", message: "private link" },
      { level: "warning", file: "a.md", message: "w" },
      { level: "error", file: "b.md", message: "e" },
      { level: "error", file: "a.md", message: "e2" },
    ]
    expect(groupProblems(ps).map(([f, list]) => [f, list.map((p) => p.level)])).toEqual([
      ["a.md", ["error", "warning"]],
      ["b.md", ["error"]],
    ])
    expect(groupProblems(ps, true)).toHaveLength(3)
  })

  test("summaries and preview addresses", () => {
    expect(summary({ error: 2, warning: 1, info: 4 })).toBe("2 errors, 1 warning")
    expect(summary({ error: 0, warning: 0, info: 4 })).toBe("no problems")
    expect(previewUrl(4321, "/Books/Dune\n")).toBe("http://localhost:4321/Books/Dune")
    expect(previewUrl(4321, "[datme] a warning\n/Books/Dune\n")).toBe("http://localhost:4321/Books/Dune")
  })
})

describe("suggestions", () => {
  const json = JSON.stringify({
    file: "Inbox/Draft.md",
    published: false,
    related: [{ file: "Notes/Slip box.md", title: "Slip box", url: "/Notes/Slip-box", score: 3, tags: ["pkm"], links: 1 }],
    mentions: [{ file: "Notes/Slip box.md", title: "Slip box", text: "slip box", offset: 40, line: 3 }],
  })

  test("the answer of datme related is read after anything printed before it", () => {
    const s = parseSuggestions(`[datme] a warning\n${json}`)
    expect(s.related[0].file).toBe("Notes/Slip box.md")
    expect(() => parseSuggestions("nothing")).toThrow()
  })

  test("a mention becomes a link by file name, keeping the words as written", () => {
    expect(mentionLink({ file: "Notes/Slip box.md", text: "slip box" })).toBe("[[Slip box|slip box]]")
    expect(mentionLink({ file: "Notes/Slip box.md", text: "Slip box" })).toBe("[[Slip box]]")
    // A name two notes share links by the path Obsidian gives, the words kept.
    expect(mentionLink({ file: "b/deep/Foo.md", text: "Foo" }, "deep/Foo")).toBe("[[deep/Foo|Foo]]")
  })

  test("a mention is found where datme saw it, in the file or in the editor of a CRLF note", () => {
    const m = { text: "Dune", offset: 11, line: 3 }
    expect(locate("a\r\nb\r\nread Dune", m)).toBe(11)
    expect(locate("a\nb\nread Dune", m)).toBe(9)
    expect(locate("a\nb\nread Emma", m)).toBeUndefined()
  })

  test("a related note says why", () => {
    expect(relatedWhy({ file: "a.md", title: "a", url: "/a", score: 4, tags: ["pkm", "zk"], links: 2, similarity: 0.71 })).toBe(
      "#pkm #zk · 2 shared links · ≈ 71%",
    )
  })
})

describe("ago", () => {
  test("says how long ago in the largest whole unit", () => {
    const now = Date.UTC(2026, 9, 8, 12)
    expect(ago(now - 20_000, now)).toBe("just now")
    expect(ago(now - 60_000, now)).toBe("1 minute ago")
    expect(ago(now - 5 * 3_600_000, now)).toBe("5 hours ago")
    expect(ago(now - 3 * 86_400_000, now)).toBe("3 days ago")
  })
})

describe("on a phone", () => {
  test("the plugin loads no Node module up front, and the manifest allows mobile", async () => {
    const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text()
    // Only type imports from node: at the top; the modules themselves load on desktop, when needed.
    expect(main.match(/^import (?!type )[^\n]*from "node:/gm)).toBeNull()
    const manifest = await Bun.file(new URL("../manifest.json", import.meta.url)).json()
    expect(manifest.isDesktopOnly).toBe(false)
  })
})

describe("garden dashboard", () => {
  test("reads the mode, URL and ignored folders of datme.yaml", () => {
    expect(gardenConfig({ publish: "all", site: { url: "https://notes.example/" }, ignore: ["/Archive/"] })).toMatchObject({
      mode: "all",
      url: "https://notes.example",
      ignore: [".git", ".obsidian", ".trash", "node_modules", "private", "templates", "Archive"],
    })
    expect(gardenConfig(null)).toEqual({
      mode: "explicit",
      url: undefined,
      ignore: [".git", ".obsidian", ".trash", "node_modules", "private", "templates"],
      languages: ["en-US"],
      stages: [],
      privateLinks: "text",
      preset: undefined,
    })
  })

  test("reads languages, stages, privateLinks and the theme pack of datme.yaml", () => {
    const c = gardenConfig({
      languages: ["vi-VN", "en-US", "x"],
      stages: { "01_Seeds": "fleeting", ideas: "Ideas", "02_Trees": { icon: "🌳", label: "Trees" }, "03_Rocks": null },
      privateLinks: "hide",
      theme: { preset: "Themes/mine" },
    })
    expect(c.languages).toEqual(["vi-VN", "en-US"])
    expect(c.stages).toEqual([
      { name: "01_Seeds", label: "🌱 Fleeting" },
      { name: "ideas", label: "Ideas" },
      { name: "02_Trees", label: "Trees" },
      { name: "03_Rocks", label: "Rocks" },
    ])
    expect(c.privateLinks).toBe("hide")
    expect(c.preset).toBe("Themes/mine")
    expect(gardenConfig({ privateLinks: "nope" }).privateLinks).toBe("text")
  })

  test("ignored folders match without regard to case, as datme does", () => {
    const c = gardenConfig({ ignore: ["Archive"] })
    expect(isIgnored("archive/old.md", c)).toBe(true)
    expect(isIgnored("Private/x.md", c)).toBe(true)
    expect(isIgnored(".hidden/x.md", c)).toBe(true)
    expect(isIgnored("Archived.md", c)).toBe(false)
  })

  test("counts notes as datme decides: published, unlisted, private, drafts and scheduled", () => {
    const now = new Date("2026-10-08T12:00:00Z")
    const counts = gardenCounts(
      [
        { path: "a.md", fm: { publish: true } },
        { path: "b.md", fm: { publish: true, unlisted: true } },
        { path: "c.md", fm: { publish: true, draft: true } },
        { path: "d.md", fm: { publish: true, publish_date: "2026-12-01" } },
        { path: "e.md", fm: { publish: true, publish_date: "2026-01-01" } },
        { path: "f.md", fm: { draft: true } },
        { path: "g.md" },
        { path: "templates/t.md", fm: { publish: true } },
        { path: "Archive/old.md", fm: { publish: true } },
      ],
      gardenConfig({ ignore: ["Archive"] }),
      now,
    )
    expect(counts).toEqual({ published: 3, unlisted: 1, private: 2, drafts: 1, scheduled: [{ path: "d.md", date: "2026-12-01" }] })
  })
})

describe("preview pane", () => {
  const headings = [
    { heading: "Intro", level: 1, line: 3 },
    { heading: "Details", level: 2, line: 10 },
  ]

  test("the heading at a line is the last one that starts at or before it", () => {
    expect(headingAt(headings, 0)).toBeUndefined()
    expect(headingAt(headings, 3)).toEqual({ heading: "Intro", level: 1 })
    expect(headingAt(headings, 42)).toEqual({ heading: "Details", level: 2 })
  })

  test("a heading's words are what the page shows: links by their text, no emphasis marks", () => {
    expect(headingText("About [[Notes/Gardens|my garden]]")).toBe("About my garden")
    expect(headingText("See [[Notes/Gardens]]")).toBe("See Gardens")
    expect(headingText("A **bold** `code` [link](https://x.y)")).toBe("A bold code link")
  })

  test("the scroll script looks for the heading by its words, safely quoted", () => {
    const script = scrollScript('Say "hi" </script>')
    expect(script).toContain(JSON.stringify('Say "hi" </script>'))
    expect(scrollScript(undefined)).toContain("const want = null")
  })
})

describe("file explorer", () => {
  const now = new Date("2026-10-22")

  test("a note's badge is its state, and unlisted for a published note kept off lists", () => {
    expect(badgeOf({ publish: true }, "explicit", now)).toBe("published")
    expect(badgeOf({ publish: true, unlisted: true }, "explicit", now)).toBe("unlisted")
    expect(badgeOf({}, "explicit", now)).toBe("private")
    expect(badgeOf({ publish: true, draft: "true" }, "explicit", now)).toBe("draft")
    expect(badgeOf({ publish: true, publish_date: "2027-01-01" }, "explicit", now)).toBe("scheduled")
  })

  test("each folder counts the published notes under it, ignored ones left out", () => {
    const counts = folderCounts(
      [
        { path: "A/one.md", fm: { publish: true } },
        { path: "A/B/two.md", fm: { publish: true } },
        { path: "A/B/three.md", fm: {} },
        { path: "templates/t.md", fm: { publish: true } },
        { path: "top.md", fm: { publish: true } },
      ],
      gardenConfig(null),
      now,
    )
    expect(counts.get("A")).toEqual({ published: 2, total: 3 })
    expect(counts.get("A/B")).toEqual({ published: 1, total: 2 })
    expect(counts.has("templates")).toBe(false)
  })

  test("publishing many notes changes only those that need it, with the key the mode wants", () => {
    expect(publishFor({ publish: true }, "explicit", true)).toBe("keep")
    expect(publishFor({}, "explicit", true)).toBe(true)
    expect(publishFor({ publish: true }, "explicit", false)).toBeUndefined()
    expect(publishFor({}, "all", false)).toBe(false)
    expect(publishFor({ publish: false }, "all", true)).toBeUndefined()
  })
})
