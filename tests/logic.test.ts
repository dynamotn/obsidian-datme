import { describe, expect, test } from "bun:test"
import {
  ago,
  augmentedPath,
  groupProblems,
  isPublished,
  mentionLink,
  parseCheck,
  parseSuggestions,
  previewUrl,
  publishMode,
  relatedWhy,
  splitCommand,
  summary,
  toggledPublish,
  type Problem,
} from "../src/logic"

describe("publishing", () => {
  test("the vault's mode comes from datme.yaml, explicit by default", () => {
    expect(publishMode(null)).toBe("explicit")
    expect(publishMode("site:\n  title: x\npublish: all # everything\n")).toBe("all")
    expect(publishMode("site:\n  publish: all\n")).toBe("explicit")
  })

  test("a note is published as datme decides it", () => {
    expect(isPublished({ publish: true }, "explicit")).toBe(true)
    expect(isPublished({ publish: "true" }, "explicit")).toBe(true)
    expect(isPublished({}, "explicit")).toBe(false)
    expect(isPublished(undefined, "all")).toBe(true)
    expect(isPublished({ publish: false }, "all")).toBe(false)
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
