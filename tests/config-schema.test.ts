import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { configProblems, describe as describeAt, keyChoices, validate, valueChoices, yamlErrorLine, yamlOutline, yamlPlace, type Schema } from "../src/config-schema"

// A part of datme's own schema: site, publish, privateLinks, nav, home, comments, history.
const schema = JSON.parse(readFileSync(new URL("fixtures/datme.schema.trimmed.json", import.meta.url), "utf8")) as Schema

const config = `# my garden
site:
  title: Garden
  url: https://example.org # live
  colour: red
publish: everything
nav:
  - home
  - note: About
    label: About me
  - nowhere
home:
  note: index.md
  layout: grid
history: "yes"
`

describe("datme.yaml outline", () => {
  test("each key and list item, with its path and places", () => {
    const entries = yamlOutline(config)
    const at = (path: (string | number)[]) => entries.find((e) => JSON.stringify(e.path) === JSON.stringify(path))!
    expect(entries.map((e) => e.path.join("."))).toEqual(["site", "site.title", "site.url", "site.colour", "publish", "nav", "nav.0", "nav.1", "nav.1.note", "nav.1.label", "nav.2", "home", "home.note", "home.layout", "history"])
    const slice = (r: { from: number; to: number }) => config.slice(r.from, r.to)
    expect(slice(at(["site", "url"]).value)).toBe("https://example.org")
    expect(slice(at(["nav", 2]).value)).toBe("nowhere")
    expect(slice(at(["nav", 1, "label"]).key)).toBe("label")
    expect(slice(at(["history"]).value)).toBe('"yes"')
  })

  test("a list may sit at its key's indent, and block text is skipped", () => {
    const text = "ignore:\n- drafts/\n- '*.tmp'\nfooter:\n  text: |\n    not: a key\n  links: []\n"
    expect(yamlOutline(text).map((e) => e.path.join("."))).toEqual(["ignore", "ignore.0", "ignore.1", "footer", "footer.text", "footer.links"])
  })
})

describe("datme.yaml completion", () => {
  test("keys by where the cursor is", () => {
    expect(yamlPlace("")).toEqual({ kind: "key", path: [], from: 0 })
    expect(yamlPlace("site:\n  ti")).toEqual({ kind: "key", path: ["site"], from: 8 })
    expect(yamlPlace("site:\n  title: x\npu")).toMatchObject({ kind: "key", path: [] })
    expect(yamlPlace("nav:\n  - home\n  - no")).toMatchObject({ kind: "key", path: ["nav", 1] })
    expect(yamlPlace("home:\n  note: a.md\n  ")).toMatchObject({ kind: "key", path: ["home"] })
  })

  test("values after a key and a space", () => {
    expect(yamlPlace("home:\n  layout: b")).toEqual({ kind: "value", path: ["home", "layout"], from: 16 })
    expect(yamlPlace('publish: "e')).toEqual({ kind: "value", path: ["publish"], from: 10 })
    expect(yamlPlace("publish:")).toBeUndefined()
  })

  test("the keys and values the schema has there, with their descriptions", () => {
    expect(keyChoices(schema, ["site"]).map((c) => c.label)).toContain("url")
    expect(keyChoices(schema, []).find((c) => c.label === "nav")).toMatchObject({ type: "array", description: expect.stringContaining("Main menu") })
    // home is a string or an object: the object's keys are offered.
    expect(keyChoices(schema, ["home"]).map((c) => c.label)).toEqual(["note", "layout", "tiles"])
    expect(keyChoices(schema, ["nav", 0]).map((c) => c.label)).toEqual(["note", "label", "url"])
    expect(valueChoices(schema, ["publish"]).map((c) => c.value)).toEqual(["explicit", "all"])
    expect(valueChoices(schema, ["history"]).map((c) => c.value)).toEqual(["true", "false"])
    expect(valueChoices(schema, ["comments", "provider"]).map((c) => c.value)).toEqual(["giscus", "commento"])
    expect(describeAt(schema, ["home"])).toContain("home page")
  })
})

describe("datme.yaml validation", () => {
  const parsed = {
    site: { title: "Garden", url: "https://example.org", colour: "red" },
    publish: "everything",
    nav: ["home", { note: "About", label: "About me" }, "nowhere"],
    home: { note: "index.md", layout: "grid" },
    history: "yes",
  }

  test("unknown keys, wrong types and values outside an enum", () => {
    expect(validate(schema, parsed).map((p) => `${p.path.join(".")}: ${p.message}`)).toEqual([
      "site.colour: unknown key colour in site",
      "publish: publish should be one of explicit, all",
      "nav.2: item 3 of nav should be one of home, tags, archive, recent, timeline, map, stats, calendar, practice, changes",
      "home.layout: layout should be one of default, bento",
      "history: history should be boolean",
    ])
  })

  test("a value being written, and what fits one of its forms, pass", () => {
    expect(validate(schema, { site: null, home: "index.md", nav: [{ url: "https://x.org", label: "X" }], comments: { provider: "commento" } })).toEqual([])
    expect(validate(schema, { comments: { provider: "giscus", mapping: "nope" } }).map((p) => p.path.join("."))).toEqual(["comments.mapping"])
  })

  test("problems land on the key or value they are about", () => {
    const marks = configProblems(schema, config, parsed).map((p) => [config.slice(p.from, p.to), p.message.split(" ")[0]])
    expect(marks).toEqual([
      ["colour", "unknown"],
      ["everything", "publish"],
      ["nowhere", "item"],
      ["grid", "layout"],
      ['"yes"', "history"],
    ])
  })

  test("a value inside a flow list is shown on its key", () => {
    const text = "nav: [home, nowhere]\n"
    expect(configProblems(schema, text, { nav: ["home", "nowhere"] }).map((p) => text.slice(p.from, p.to))).toEqual(["[home, nowhere]"])
  })

  test("the line of a YAML error, from either parser's shape", () => {
    expect(yamlErrorLine({ linePos: [{ line: 3, col: 1 }] })).toBe(2)
    expect(yamlErrorLine({ mark: { line: 4 } })).toBe(4)
    expect(yamlErrorLine(new Error("x"))).toBeUndefined()
  })
})
