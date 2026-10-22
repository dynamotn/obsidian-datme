import { describe, expect, test } from "bun:test"
import {
  ago,
  giscusTerm,
  mentionCounts,
  mentionTargets,
  pageTitles,
  parseGiscus,
  parseMentions,
  plainText,
  responseLine,
  type Response,
  prunedTendState,
  stillToTend,
  tendingQueue,
  updatedAt,
  publishDateValue,
  linksIn,
  privateLinkLabel,
  notePath,
  publicUrl,
  textFragment,
  explainChrome,
  explainLayout,
  explainStyle,
  frontmatterEnd,
  lockVariable,
  propertyChoices,
  propertyLine,
  propertyProblem,
  propertyProblems,
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
      "/usr/bin:/opt/homebrew/bin:/Users/me/.bun/bin:/usr/local/bin:/Users/me/.local/bin:/Users/me/.npm-global/bin:/Users/me/.local/share/mise/shims:/Users/me/.asdf/shims",
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
      appearance: { style: "notebook", folders: {}, classic: [], tags: {}, stages: {}, languages: {}, schedule: [] },
      home: "index.md",
      outdatedAfter: undefined,
      responses: {},
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
      { name: "01_Seeds", label: "🌱 Fleeting", preset: "fleeting" },
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

describe("properties", () => {
  const config = gardenConfig({ languages: ["vi-VN", "en-US"], stages: { "01_Seeds": "fleeting" } })

  test("styles, layouts and frames are matched as datme does: trimmed, any case", () => {
    expect(propertyProblem("style", " Garden ", config)).toBeUndefined()
    expect(propertyProblem("layout", "BOOKS", config)).toBeUndefined()
    expect(propertyProblem("chrome", "minimal", config)).toBeUndefined()
  })

  test("an unknown value gets datme check's words", () => {
    expect(propertyProblem("style", "gardn", config)).toStartWith('style "gardn" is not one of notebook, classic, garden,')
    expect(propertyProblem("style", "gardn", config)).toEndWith("so the note keeps its usual style")
    expect(propertyProblem("layout", "book", config)).toEndWith("so the note is laid out as usual")
    expect(propertyProblem("chrome", "none", config)).toBe('chrome "none" is not one of full, minimal, so the note keeps its usual frame')
  })

  test("a theme pack may add styles, so no style is questioned then", () => {
    expect(propertyProblem("style", "mine", gardenConfig({ theme: { preset: "Themes/mine" } }))).toBeUndefined()
  })

  test("stages and languages come from datme.yaml, matched exactly", () => {
    expect(propertyProblem("stage", "01_Seeds", config)).toBeUndefined()
    expect(propertyProblem("stage", "01_seeds", config)).toContain("is not one of 01_Seeds")
    expect(propertyProblem("stage", "x", gardenConfig(null))).toBe('stage "x" is ignored: datme.yaml has no stages')
    expect(propertyProblem("lang", "en-US", config)).toBeUndefined()
    expect(propertyProblem("lang", "en", config)).toBe('lang "en" is not one of vi-VN, en-US, so the note is in vi-VN')
  })

  test("a password group must be a name; any other password is the password itself", () => {
    expect(propertyProblem("password", "@close-friends", config)).toBeUndefined()
    expect(propertyProblem("password", "@close friends", config)).toContain("is not a group name")
    expect(propertyProblem("password", "s3cret", config)).toBeUndefined()
    expect(lockVariable("@close-friends")).toBe("CLOSE_FRIENDS")
  })

  test("empty values and other keys are left alone", () => {
    expect(propertyProblem("style", "", config)).toBeUndefined()
    expect(propertyProblem("style", null, config)).toBeUndefined()
    expect(propertyProblem("title", "anything", config)).toBeUndefined()
    expect(propertyProblems({ style: "x", layout: "cv", chrome: "y" }, config).map((p) => p.key)).toEqual(["style", "chrome"])
  })

  test("the choices of a property, from the plugin's lists and datme.yaml", () => {
    expect(propertyChoices("style", config).map((c) => c.value)).toContain("lacquer")
    expect(propertyChoices("layout", config).find((c) => c.value === "books")).toMatchObject({ collection: true })
    expect(propertyChoices("stage", config)).toEqual([{ value: "01_Seeds", description: "🌱 Fleeting" }])
    expect(propertyChoices("lang", config).map((c) => c.value)).toEqual(["vi-VN", "en-US"])
    expect(propertyChoices("password", config, ["@b", "@a", "@b"]).map((c) => c.value)).toEqual(["@a", "@b"])
  })

  test("a frontmatter line gives its key and where its value is, quotes and comments aside", () => {
    expect(propertyLine("style: garden")).toEqual({ key: "style", from: 7, to: 13, value: "garden" })
    expect(propertyLine('password: "@friends" # who')).toEqual({ key: "password", from: 11, to: 19, value: "@friends" })
    expect(propertyLine("style:")).toEqual({ key: "style", from: 6, to: 6, value: "" })
    expect(propertyLine("  - item")).toBeUndefined()
  })

  test("the frontmatter ends at the next --- or ...", () => {
    const lines = (text: string) => {
      const l = text.split("\n")
      return [(n: number) => l[n], l.length] as const
    }
    expect(frontmatterEnd(...lines("---\nstyle: x\n---\nbody"))).toBe(2)
    expect(frontmatterEnd(...lines("---\nstyle: x\n...\n"))).toBe(2)
    expect(frontmatterEnd(...lines("body\n---\n"))).toBeUndefined()
    expect(frontmatterEnd(...lines("---\nstyle: x"))).toBeUndefined()
  })
})

describe("the look of a note", () => {
  const now = new Date("2026-10-22T12:00:00Z")
  const config = gardenConfig({
    languages: ["vi-VN", "en-US"],
    stages: { "01_Seeds": "fleeting" },
    appearance: {
      style: "classic",
      folders: { "/Writing/": "manuscript", "Writing/Poems": "zine" },
      classic: ["Old"],
      tags: { "#Poem": "herbarium", "essay writing": "wiki" },
      stages: { "01_Seeds": "garden" },
      languages: { vi: "lacquer" },
      schedule: [{ style: "eink", from: "12-20", to: "01-05" }],
    },
  })
  const style = (path: string, fm: Record<string, unknown> = {}, tags: string[] = [], at = now) => explainStyle({ path, fm, tags }, config, at)

  test("a note's own style wins, then its layout's", () => {
    expect(style("Writing/a.md", { style: "Terminal" })).toEqual({ value: "terminal", rule: "style: in Writing/a.md" })
    expect(style("Writing/a.md", { layout: "cv" })).toEqual({ value: "resume", rule: "the default of layout: cv" })
    expect(style("Writing/a.md", { style: "nope", layout: "books" }).rule).toBe("appearance.folders → Writing")
  })

  test("then appearance: tags (nested ones too), stages, folders (the deepest), days, languages, the site's", () => {
    expect(style("Writing/a.md", {}, ["#poem/haiku"])).toEqual({ value: "herbarium", rule: "appearance.tags → poem" })
    expect(style("x.md", {}, ["#Essay-Writing"])).toEqual({ value: "wiki", rule: "appearance.tags → essay-writing" })
    expect(style("01_Seeds/a.md")).toEqual({ value: "garden", rule: "appearance.stages → 01_Seeds" })
    expect(style("Writing/Poems/b/a.md")).toEqual({ value: "zine", rule: "appearance.folders → Writing/Poems" })
    expect(style("Old/a.md")).toEqual({ value: "notebook", rule: "appearance.classic → Old" })
    expect(style("a.md", {}, [], new Date("2026-12-31"))).toEqual({ value: "eink", rule: "appearance.schedule → 12-20 to 01-05" })
    expect(style("a.md")).toEqual({ value: "lacquer", rule: "appearance.languages → vi" })
    expect(style("a.md", { lang: "en-US" })).toEqual({ value: "classic", rule: "appearance.style" })
  })

  test("the frame and the layout", () => {
    expect(explainChrome({ path: "a.md", fm: { chrome: "minimal" } })).toEqual({ value: "minimal", rule: "chrome: in a.md" })
    expect(explainChrome({ path: "a.md", fm: { layout: "faq" } })).toEqual({ value: "full", rule: "the default of layout: faq" })
    expect(explainChrome({ path: "a.md", fm: { layout: "books" } })).toEqual({ value: "full-norail", rule: "the default of layout: books" })
    expect(explainChrome({ path: "a.md" })).toEqual({ value: "full", rule: "the default" })
    expect(explainLayout({ path: "a.md", fm: { layout: " Books " } })).toEqual({ value: "books", rule: "layout: in a.md" })
    expect(explainLayout({ path: "a.md", fm: { layout: "nope" } })).toEqual({ rule: "no layout:" })
  })
})

describe("public links", () => {
  const config = gardenConfig({ languages: ["vi-VN", "en-US"], site: { url: "https://notes.example/garden/" } })

  test("a note's path is its file's, as datme writes it: case and accents kept, spaces as dashes", () => {
    expect(notePath("Ghi chú/Cây & hoa.md", {}, config)).toBe("/" + ["Ghi-chú", "Cây--and--hoa"].map(encodeURIComponent).join("/"))
    expect(notePath("A/What? 100%.md", {}, config)).toBe("/A/What-100-percent")
    expect(notePath("Folder/index.md", {}, config)).toBe("/Folder")
    expect(notePath("index.md", { permalink: "/ignored/" }, config)).toBe("/")
    expect(notePath("Home.md", {}, gardenConfig({ home: { note: "/Home.md" } }))).toBe("/")
  })

  test("permalinks, titles in the page's language and language prefixes", () => {
    expect(notePath("A/b.md", { permalink: "/now/" }, config)).toBe("/now")
    expect(notePath("A/b.md", { permalink: { "en-US": "en-now" }, lang: "en-US" }, config)).toBe("/en-US/en-now")
    expect(notePath("A/b.md", { title: { "vi-VN": "Tiêu đề" } }, config)).toBe("/A/" + encodeURIComponent("Tiêu-đề"))
    expect(notePath("A/b.md", { title: "Plain titles keep the path" }, config)).toBe("/A/b")
    expect(notePath("A/b.md", { lang: "en-US" }, config)).toBe("/en-US/A/b")
    expect(notePath("A/b.md", { lang: "fr" }, config)).toBe("/A/b")
  })

  test("the live address joins the site's URL, with its base path once", () => {
    expect(publicUrl("https://notes.example/garden", "/A/b")).toBe("https://notes.example/garden/A/b")
    expect(publicUrl("https://notes.example/garden", "/garden/A/b")).toBe("https://notes.example/garden/A/b")
    expect(publicUrl("https://notes.example", "/A/b")).toBe("https://notes.example/A/b")
    expect(publicUrl("https://notes.example", "/")).toBe("https://notes.example/")
  })

  test("a passage is linked as the site's share button does", () => {
    expect(textFragment("  a  short,\n passage - here ")).toBe("#:~:text=a%20short%2C%20passage%20%2D%20here")
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen"
    expect(textFragment(long)).toBe("#:~:text=one%20two%20three%20four%20five,nine%20ten%20eleven%20twelve%20thirteen")
    expect(textFragment("   ")).toBe("")
  })
})

describe("links to private notes", () => {
  test("the tooltip says what the site shows under privateLinks", () => {
    const priv = { state: "private" as const }
    expect(privateLinkLabel({ target: "Secret", alias: "my secret" }, "text", priv)).toBe("🔒 A private note: the site shows “my secret” as plain text")
    expect(privateLinkLabel({ target: "Secret" }, "placeholder", priv)).toBe("🔒 A private note: the site shows a placeholder (“a private note”)")
    expect(privateLinkLabel({ target: "Secret", alias: "secret" }, "hide", priv)).toBe("🔒 A private note: the site shows nothing")
    expect(privateLinkLabel({ target: "Secret", alias: "that one" }, "hide", priv)).toBe("🔒 A private note: the site shows “that one” as plain text")
    expect(privateLinkLabel({ target: "Later" }, "text", { state: "scheduled", date: "2027-01-01" })).toBe(
      "🔒 Published on 2027-01-01: the site shows “Later” as plain text until then",
    )
    expect(privateLinkLabel({ target: "Wip" }, "text", { state: "draft" })).toStartWith("🔒 A draft:")
  })

  test("the links of a line: wikilinks and links to notes, embeds and web links left out", () => {
    expect(linksIn("See [[A/Note#Part|this]] and [x](B%20c.md#h), ![[Pic]], [w](https://x.y/a.md)")).toEqual([
      { from: 4, to: 24, target: "A/Note#Part", alias: "this" },
      { from: 29, to: 44, target: "B c.md#h", alias: "x" },
    ])
    expect(linksIn("[[Plain]]")).toEqual([{ from: 0, to: 9, target: "Plain", alias: undefined }])
  })
})

describe("scheduling", () => {
  test("a day alone, or a time with the offset it was chosen in", () => {
    expect(publishDateValue("2026-11-01", undefined, 420)).toBe("2026-11-01")
    expect(publishDateValue("2026-11-01", "09:30", 420)).toBe("2026-11-01T09:30:00+07:00")
    expect(publishDateValue("2026-11-01", "09:30", -330)).toBe("2026-11-01T09:30:00-05:30")
    expect(new Date(publishDateValue("2026-11-01", "09:30", 420)).toISOString()).toBe("2026-11-01T02:30:00.000Z")
    expect(() => publishDateValue("1/11/2026", undefined, 0)).toThrow()
  })

  test("what it writes is what the status bar reads back", () => {
    const now = new Date("2026-10-22")
    expect(noteState({ publish: true, publish_date: publishDateValue("2026-11-01", "09:30", 420) }, "explicit", now)).toEqual({
      state: "scheduled",
      date: "2026-11-01",
    })
  })
})

describe("tending queue", () => {
  const DAY = 86_400_000
  const now = new Date("2026-10-22T00:00:00Z").getTime()
  const config = gardenConfig({ outdated: { after: 2 }, stages: { "01_Fleeting": "fleeting", "03_Permanent": "permanent" } })
  const report = {
    counts: { error: 0, warning: 0, info: 3 },
    problems: [
      { level: "info" as const, file: "A/lonely.md", message: "orphan: no published note links here, and the menu does not either" },
      { level: "info" as const, file: "A/stuck.md", message: "dead end: links to no published note" },
      { level: "info" as const, file: "A/big.md", message: "hub: links to 40 notes, 8 times the median of 5; a map of content could split it" },
    ],
  }
  const notes = [
    { path: "A/lonely.md", fm: { publish: true, updated: "2026-01-01" }, mtime: now },
    { path: "A/stuck.md", fm: { publish: true }, mtime: now - 10 * DAY },
    { path: "A/big.md", fm: { publish: true }, mtime: now },
    { path: "A/old.md", fm: { publish: true, modified: "2023-05-01" }, mtime: now },
    { path: "A/old-but-kept.md", fm: { publish: true, modified: "2023-05-01", outdated: false }, mtime: now },
    { path: "A/2020-01-01.md", fm: { publish: true }, mtime: now - 2000 * DAY },
    { path: "01_Fleeting/idea.md", fm: {}, mtime: now - 120 * DAY },
    { path: "01_Fleeting/fresh.md", fm: {}, mtime: now - 5 * DAY },
    { path: "03_Permanent/done.md", fm: {}, mtime: now - 900 * DAY },
    { path: "templates/t.md", fm: { publish: true, modified: "2000-01-01" }, mtime: now },
  ]

  test("orphans and dead ends from the check, out of date and stalled notes from their dates, oldest first", () => {
    const q = tendingQueue(notes, report, config, now, 90)
    expect(q.map((i) => `${i.kind} ${i.path}`)).toEqual([
      "outdated A/old.md",
      "orphan A/lonely.md",
      "stalled 01_Fleeting/idea.md",
      "dead-end A/stuck.md",
    ])
    expect(q[2].why).toBe("Still fleeting, untouched for 120 days")
  })

  test("without outdated.after nothing is out of date", () => {
    expect(tendingQueue(notes, undefined, gardenConfig({}), now, 90)).toEqual([])
  })

  test("a snoozed item hides until then; done hides it until it is old again, or a newer check still finds it", () => {
    const q = tendingQueue(notes, report, config, now, 90)
    const state = { snoozed: { "orphan:A/lonely.md": now + DAY }, done: { "dead-end:A/stuck.md": now - DAY, "stalled:01_Fleeting/idea.md": now - DAY } }
    expect(stillToTend(q, state, now, now - 2 * DAY, config, 90).map((i) => i.kind)).toEqual(["outdated"])
    // A check after the mark still finds the dead end; 90 days later the idea is stalled again; the orphan's snooze has run out.
    expect(stillToTend(q, state, now + 91 * DAY, now, config, 90).map((i) => i.kind)).toEqual(["outdated", "orphan", "stalled", "dead-end"])
  })

  test("pruning drops run-out snoozes and marks of items gone from the queue", () => {
    const q = tendingQueue(notes, report, config, now, 90)
    const pruned = prunedTendState({ snoozed: { "orphan:A/lonely.md": now - 1, "outdated:A/old.md": now + DAY }, done: { "orphan:Gone.md": now, "stalled:01_Fleeting/idea.md": now } }, q, now)
    expect(pruned).toEqual({ snoozed: { "outdated:A/old.md": now + DAY }, done: { "stalled:01_Fleeting/idea.md": now } })
  })

  test("the date a note was tended: updated, modified or lastmod, else the file's time", () => {
    expect(updatedAt({ updated: "2026-01-02" }, 5)).toBe(new Date("2026-01-02").getTime())
    expect(updatedAt({ modified: ["2026-10-22T21:14"] }, 5)).toBe(new Date("2026-10-22T21:14").getTime())
    expect(updatedAt({ lastmod: "not a date" }, 5)).toBe(5)
  })
})

describe("readers' responses", () => {
  test("the responses settings of datme.yaml: webmention.io's account and giscus", () => {
    expect(gardenConfig({ site: { url: "https://notes.example/g" }, webmentions: {} }).responses).toEqual({ webmentions: "notes.example" })
    expect(gardenConfig({ site: { url: "https://notes.example" }, webmentions: { domain: "me.example" } }).responses.webmentions).toBe("me.example")
    expect(gardenConfig({ site: { url: "https://notes.example" } }).responses).toEqual({})
    expect(gardenConfig({ comments: { provider: "giscus", repo: "me/garden", category: "Notes", mapping: "og:title" } }).responses.giscus).toEqual({
      repo: "me/garden",
      category: "Notes",
      mapping: "og:title",
    })
    expect(gardenConfig({ comments: { provider: "giscus", repo: "me/garden", category: "Notes" } }).responses.giscus?.mapping).toBe("pathname")
    expect(gardenConfig({ comments: { provider: "commento" } }).responses.giscus).toBeUndefined()
  })

  test("webmentions, one per property and source, newest first, the fediverse marked", () => {
    const json = {
      children: [
        { "wm-property": "like-of", url: "https://a.example/like", author: { name: "Ann", url: "https://a.example" }, "wm-received": "2026-10-01T00:00:00Z", "wm-id": 1 },
        { "wm-property": "like-of", url: "https://a.example/like", author: { name: "Ann" }, "wm-received": "2026-10-01T00:00:00Z", "wm-id": 2 },
        {
          "wm-property": "in-reply-to",
          url: "https://mastodon.social/@bo/1",
          "wm-source": "https://brid.gy/comment/mastodon/@me@x/1/2",
          author: { name: "Bo" },
          published: "2026-10-05T00:00:00Z",
          content: { html: "<p>Nice &amp; <b>true</b></p>", text: "Nice & true" },
          "wm-id": 3,
          "wm-target": "https://notes.example/A/b",
        },
        { "wm-property": "rsvp", url: "https://c.example" },
        { "wm-property": "mention-of", url: "https://d.example/post", author: {}, content: { value: "<p>see this</p>" } },
      ],
    }
    const r = parseMentions(json)
    expect(r.map((x) => `${x.kind} ${x.author.name}`)).toEqual(["reply Bo", "like Ann", "mention d.example"])
    expect(r[0]).toMatchObject({ text: "Nice & true", via: "Bridgy", id: 3, target: "https://notes.example/A/b" })
    expect(r[2].text).toBe("see this")
    expect(parseMentions({ error: "x" })).toEqual([])
  })

  test("giscus comments and their replies, newest first, deleted and hidden ones left out", () => {
    const json = {
      discussion: {
        url: "https://github.com/me/garden/discussions/7",
        reactionCount: 4,
        comments: [
          {
            author: { login: "ann", url: "https://github.com/ann" },
            bodyHTML: "<p>First</p>",
            createdAt: "2026-10-01T00:00:00Z",
            url: "https://github.com/me/garden/discussions/7#c1",
            replies: [{ author: { login: "me" }, bodyHTML: "<p>Thanks</p>", createdAt: "2026-10-03T00:00:00Z" }],
          },
          { author: { login: "spam" }, bodyHTML: "x", createdAt: "2026-10-04T00:00:00Z", isMinimized: true },
        ],
      },
    }
    const g = parseGiscus(json)
    expect(g.url).toBe("https://github.com/me/garden/discussions/7")
    expect(g.reactions).toBe(4)
    expect(g.responses.map((r) => `${r.author.name}: ${r.text}`)).toEqual(["me: Thanks", "ann: First"])
    expect(parseGiscus({ error: "Discussion not found" }).responses).toEqual([])
  })

  test("the term giscus finds a page's discussion by", () => {
    expect(giscusTerm("pathname", "https://notes.example/A/%C4%90%E1%BB%93")).toBe("A/%C4%90%E1%BB%93")
    expect(giscusTerm("pathname", "https://notes.example/")).toBe("index")
    expect(giscusTerm("url", "https://notes.example/A/b#x")).toBe("https://notes.example/A/b")
    expect(giscusTerm("og:title", "https://notes.example/A/b", { ogTitle: "B" })).toBe("B")
    expect(giscusTerm("title", "https://notes.example/A/b")).toBeUndefined()
    expect(pageTitles('<head><title>B · My &amp; garden</title><meta property="og:title" content="B"></head>')).toEqual({ title: "B · My & garden", ogTitle: "B" })
  })

  test("webmention.io knows a page with and without its trailing slash; counts go by page", () => {
    expect(mentionTargets("https://notes.example/A/b")).toEqual(["https://notes.example/A/b", "https://notes.example/A/b/"])
    expect(mentionTargets("https://notes.example/")).toEqual(["https://notes.example", "https://notes.example/"])
    const counts = mentionCounts([{ target: "https://n.example/A/b/" }, { target: "https://n.example/A/b" }, { target: "https://n.example/c#x" }, {}] as Response[])
    expect([...counts]).toEqual([
      ["https://n.example/A/b", 2],
      ["https://n.example/c", 1],
    ])
    expect(plainText("<p>a<br>b</p><p>&lt;c&gt; &#39;d&#39;</p>")).toBe("a\nb\n<c> 'd'")
    expect(responseLine({ source: "webmention", kind: "repost", author: { name: "Bo" }, via: "Bridgy" }, "Gardens")).toBe("Bo reposted Gardens (via Bridgy)")
  })
})
