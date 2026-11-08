import { describe, expect, test } from "bun:test"
import { ChangeSet, MapMode, Text } from "@codemirror/state"
import { readFileSync } from "node:fs"
import { noteProblems, parseCheck, placeProblems, problemRange } from "../src/logic"

const report = parseCheck(readFileSync(new URL("fixtures/check-format2.json", import.meta.url), "utf8"))
// Line 33 of the fixture vault's Zettelkasten.md, where its two placed problems are.
const linksLine = "Links: [[Missing note]], [[Private]], [[#Definition|jump]], #inline/tag and [the md link](../06_Reference/Niklas%20Luhmann.md)."
const zettel = Text.of([...Array.from({ length: 32 }, (_, i) => `line ${i + 1}`), linksLine, ""])
const textOf = (doc: Text, r: { from: number; to: number }) => doc.sliceString(r.from, r.to)

describe("check report format 2", () => {
  test("reads the format and the places", () => {
    expect(report.format).toBe(2)
    expect(parseCheck('Checking…\n{"format":2,"counts":{"error":0,"warning":0,"info":0},"problems":[]}').format).toBe(2)
    expect(report.problems[1]).toMatchObject({ line: 33, column: 8, endLine: 33, endColumn: 24 })
  })

  test("a note's problems, notices only when asked", () => {
    expect(noteProblems(report, "03_Atomic/Zettelkasten.md").map((p) => p.level)).toEqual(["error"])
    expect(noteProblems(report, "03_Atomic/Zettelkasten.md", true)).toHaveLength(2)
    expect(noteProblems(undefined, "a.md")).toEqual([])
  })

  test("ranges cover what datme points at, end exclusive", () => {
    const [missing, priv] = noteProblems(report, "03_Atomic/Zettelkasten.md", true)
    expect(textOf(zettel, problemRange(missing, zettel)!)).toBe("[[Missing note]]")
    expect(textOf(zettel, problemRange(priv, zettel)!)).toBe("[[Private]]")
  })

  test("columns count UTF-16 units", () => {
    const doc = Text.of(["🌱 [[Gone]]"])
    expect(textOf(doc, problemRange({ level: "error", file: "a.md", message: "", line: 1, column: 4, endLine: 1, endColumn: 12 }, doc)!)).toBe("[[Gone]]")
  })

  test("a line alone covers the line; a start alone, the rest of it; no line, no place", () => {
    const doc = Text.of(["---", "tags: [a, b", "---"])
    const p = { level: "warning" as const, file: "a.md", message: "" }
    expect(textOf(doc, problemRange({ ...p, line: 2 }, doc)!)).toBe("tags: [a, b")
    expect(textOf(doc, problemRange({ ...p, line: 2, column: 7 }, doc)!)).toBe("[a, b")
    expect(problemRange(p, doc)).toBeUndefined()
    expect(problemRange({ ...p, line: 9 }, doc)).toBeUndefined()
    // A place past the end of its line stops there.
    expect(problemRange({ ...p, line: 1, column: 1, endColumn: 99 }, doc)).toEqual({ from: 0, to: 3 })
  })

  test("places follow the edits made since the check read the note", () => {
    const problems = noteProblems(report, "03_Atomic/Zettelkasten.md", true)
    const lineStart = zettel.line(33).from
    // Text typed above the links, and the second link's words changed.
    const typed = ChangeSet.of({ from: 0, insert: "New first line\n" }, zettel.length)
    const renamed = ChangeSet.of({ from: lineStart + 27 + 15, to: lineStart + 27 + 15 + 7, insert: "Secret" }, typed.newLength)
    const changes = typed.compose(renamed)
    const now = changes.apply(zettel)
    const placed = placeProblems(problems, zettel, (pos, assoc) => changes.mapPos(pos, assoc, MapMode.TrackDel))
    expect(placed.map((p) => textOf(now, p))).toEqual(["[[Missing note]]", "[[Secret]]"])
  })

  test("a place whose text was deleted is dropped", () => {
    const [missing] = noteProblems(report, "03_Atomic/Zettelkasten.md")
    const r = problemRange(missing, zettel)!
    const changes = ChangeSet.of({ from: r.from - 1, to: r.to + 1 }, zettel.length)
    expect(placeProblems([missing], zettel, (pos, assoc) => changes.mapPos(pos, assoc, MapMode.TrackDel))).toEqual([])
  })
})
