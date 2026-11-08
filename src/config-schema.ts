/**
 * datme.yaml against datme's JSON Schema, without Obsidian: the keys and
 * values a place in the file takes, and what in a parsed config the schema
 * refuses, put back on the lines of the file.
 *
 * Only the part of JSON Schema datme's schema uses for its shape: type,
 * properties, additionalProperties, items, enum, const, anyOf and oneOf (read
 * as anyOf), with description and default. Patterns, lengths, bounds, formats
 * and required keys are left to `datme check`.
 */

export type Key = string | number

export interface Schema {
  type?: string | string[]
  properties?: Record<string, Schema>
  additionalProperties?: boolean | Schema
  items?: Schema
  enum?: unknown[]
  const?: unknown
  anyOf?: Schema[]
  oneOf?: Schema[]
  default?: unknown
  description?: string
}

/** The alternatives of a schema, each keeping the description of the whole when it has none. */
function spread(s: Schema): Schema[] {
  const alternatives = s.anyOf ?? s.oneOf
  if (!alternatives) return [s]
  return alternatives.flatMap(spread).map((a) => (a.description || !s.description ? a : { ...a, description: s.description }))
}

/** The schemas a value at this path may follow. */
export function schemasAt(schema: Schema, path: Key[]): Schema[] {
  let now = spread(schema)
  for (const key of path) {
    now = now.flatMap((s) => {
      const sub = typeof key === "number" ? s.items : (s.properties?.[key] ?? (typeof s.additionalProperties === "object" ? s.additionalProperties : undefined))
      return sub ? spread(sub) : []
    })
  }
  return now
}

const typesOf = (s: Schema) => (s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type])

export interface SchemaChoice {
  label: string
  /** What is written: the key, or the value as YAML. */
  value: string
  description?: string
  type?: string
}

/** The keys an object at this path takes. */
export function keyChoices(schema: Schema, path: Key[]): SchemaChoice[] {
  const out = new Map<string, SchemaChoice>()
  for (const s of schemasAt(schema, path)) {
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (out.has(key)) continue
      const alternatives = spread(sub)
      const type = [...new Set(alternatives.flatMap(typesOf))].join(" or ") || undefined
      out.set(key, { label: key, value: key, description: alternatives.find((a) => a.description)?.description, type })
    }
  }
  return [...out.values()]
}

/** The values a key takes when they are few: its enum, const or booleans. */
export function valueChoices(schema: Schema, path: Key[]): SchemaChoice[] {
  const out = new Map<string, SchemaChoice>()
  for (const s of schemasAt(schema, path)) {
    const values = [...(s.enum ?? []), ...(s.const !== undefined ? [s.const] : []), ...(typesOf(s).includes("boolean") ? [true, false] : [])]
    for (const v of values) {
      const value = typeof v === "string" ? v : JSON.stringify(v)
      if (!out.has(value)) out.set(value, { label: value, value, description: s.description })
    }
  }
  return [...out.values()]
}

/** The description of what is at this path, for a hover. */
export function describe(schema: Schema, path: Key[]): string | undefined {
  return schemasAt(schema, path).find((s) => s.description)?.description
}

export interface SchemaProblem {
  path: Key[]
  message: string
  /** The key itself is wrong, or its value. */
  at: "key" | "value"
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function fits(type: string, v: unknown): boolean {
  if (type === "integer") return Number.isInteger(v)
  if (type === "object") return isObject(v)
  if (type === "array") return Array.isArray(v)
  if (type === "null") return v === null
  return typeof v === type
}

const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v))
const where = (path: Key[]) => (path.length ? ` in ${path.join(".")}` : "")
const nameOf = (path: Key[]) => {
  const last = path.at(-1)
  return typeof last === "number" ? `item ${last + 1} of ${path.at(-2) ?? "the list"}` : (last ?? "the config")
}

/**
 * What the schema refuses in a value. An empty value (`key:` with nothing
 * after it yet) is let be, as it is mostly one being written.
 */
export function validate(schema: Schema, v: unknown, path: Key[] = []): SchemaProblem[] {
  if (v === null || v === undefined) return []
  const alternatives = schema.anyOf ?? schema.oneOf
  if (alternatives) {
    const tried = alternatives.map((a) => validate(a, v, path))
    if (tried.some((t) => !t.length)) return []
    // The alternative of the value's type it comes closest to says best what is wrong in it.
    const ofType = tried.filter((_, i) => typesOf(alternatives[i]).some((t) => fits(t, v)))
    if (ofType.length) return ofType.reduce((a, b) => (b.length < a.length ? b : a))
    const types = [...new Set(alternatives.flatMap(spread).flatMap(typesOf))]
    return [{ path, at: "value", message: `${nameOf(path)} should be ${types.join(" or ") || "something else"}` }]
  }
  const name = nameOf(path)
  if (schema.const !== undefined && v !== schema.const) return [{ path, at: "value", message: `${name} should be ${shown(schema.const)}` }]
  if (schema.enum && !schema.enum.includes(v)) return [{ path, at: "value", message: `${name} should be one of ${schema.enum.map(shown).join(", ")}` }]
  const types = typesOf(schema)
  if (types.length && !types.some((t) => fits(t, v))) return [{ path, at: "value", message: `${name} should be ${types.join(" or ")}` }]
  const out: SchemaProblem[] = []
  if (isObject(v)) {
    for (const [key, value] of Object.entries(v)) {
      const sub = schema.properties?.[key] ?? schema.additionalProperties
      if (sub === false) out.push({ path: [...path, key], at: "key", message: `unknown key ${key}${where(path)}` })
      else if (typeof sub === "object") out.push(...validate(sub, value, [...path, key]))
    }
  }
  if (Array.isArray(v) && schema.items) v.forEach((item, i) => out.push(...validate(schema.items!, item, [...path, i])))
  return out
}

interface Range {
  from: number
  to: number
}

/** A key, or an item of a list, on a line of a YAML file. */
export interface YamlEntry {
  path: Key[]
  key: Range
  value: Range
}

interface Frame {
  indent: number
  path: Key[]
  item: boolean
  items: number
}

/** The open key or item a line at this indent belongs to; a dash may start a list at its key's own indent. */
function parentOf(stack: Frame[], indent: number, dash: boolean): Frame {
  while (stack.length > 1) {
    const top = stack[stack.length - 1]
    if (top.indent > indent || (top.indent === indent && (!dash || top.item))) stack.pop()
    else break
  }
  return stack[stack.length - 1]
}

const KEY = /^("([^"]*)"|'([^']*)'|[^\s#'"{[\-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?=\s|$)/

/** The end of a value, before a comment and trailing spaces. */
function valueEnd(text: string, from: number): number {
  const comment = text.slice(from).search(/(^|\s)#/)
  const end = comment < 0 ? text.length : from + comment
  return from + text.slice(from, end).trimEnd().length
}

/**
 * Walk a block-style YAML file line by line, as a path tracker: each key and
 * list item with where it is. Shortcut: flow collections spread over several
 * lines and keys with `:` inside quotes are not followed; datme configs are
 * written in block style.
 */
function walk(text: string): { entries: YamlEntry[]; stack: Frame[]; last: { start: number; text: string } } {
  const entries: YamlEntry[] = []
  const stack: Frame[] = [{ indent: -1, path: [], item: false, items: 0 }]
  let block = -1
  let start = 0
  const lines = text.split("\n")
  lines.forEach((raw, n) => {
    const lineStart = start
    start += raw.length + 1
    if (n === lines.length - 1) return
    const line = raw.replace(/\r$/, "")
    if (/^\s*(#.*)?$/.test(line)) return
    const indent = line.search(/\S/)
    if (block >= 0 && indent > block) return
    block = -1
    if (indent === 0 && /^(---|\.\.\.)\s*$/.test(line)) return
    let col = indent
    while (line.startsWith("-", col) && /^-(\s|$)/.test(line.slice(col))) {
      const parent = parentOf(stack, col, true)
      const path = [...parent.path, parent.items++]
      stack.push({ indent: col, path, item: true, items: 0 })
      const dash = col
      const gap = line.slice(col + 1).search(/\S/)
      col = gap < 0 ? line.length : col + 1 + gap
      const to = valueEnd(line, col)
      // The item itself, its value running to the end of the line when it holds a map or a list.
      entries.push({ path, key: { from: lineStart + dash, to: lineStart + dash + 1 }, value: { from: lineStart + Math.min(col, to), to: lineStart + to } })
      if (col >= line.length || !(/^-(\s|$)/.test(line.slice(col)) || KEY.test(line.slice(col)))) {
        if (/^[|>][-+0-9]*$/.test(line.slice(col, to))) block = dash
        return
      }
    }
    const m = KEY.exec(line.slice(col))
    if (!m) return
    const key = m[2] ?? m[3] ?? m[1]
    const parent = parentOf(stack, col, false)
    const path = [...parent.path, key]
    stack.push({ indent: col, path, item: false, items: 0 })
    const after = col + m[0].length
    const from = after + Math.max(line.slice(after).search(/\S/), 0)
    const to = Math.max(from, valueEnd(line, from))
    entries.push({ path, key: { from: lineStart + col, to: lineStart + col + m[1].length }, value: { from: lineStart + from, to: lineStart + to } })
    if (/^[|>][-+0-9]*$/.test(line.slice(from, to))) block = col
  })
  return { entries, stack, last: { start: start - lines[lines.length - 1].length - 1, text: lines[lines.length - 1] } }
}

/** Each key and list item of a YAML file, with where its key and value are. */
export function yamlOutline(text: string): YamlEntry[] {
  return walk(text + "\n").entries
}

export type YamlPlace = { kind: "key"; path: Key[]; from: number } | { kind: "value"; path: Key[]; from: number }

/**
 * What the cursor is writing, from the text before it: a key of the object
 * at `path`, or the value of the key at `path`; `from` is where it starts.
 */
export function yamlPlace(before: string): YamlPlace | undefined {
  const { stack, last } = walk(before)
  const line = last.text
  let col = line.search(/\S/)
  if (col < 0) return { kind: "key", path: parentOf(stack, line.length, false).path, from: last.start + line.length }
  let parent: Frame | undefined
  while (/^-\s/.test(line.slice(col))) {
    const list = parentOf(stack, col, true)
    const frame = { indent: col, path: [...list.path, list.items++], item: true, items: 0 }
    stack.push(frame)
    parent = frame
    col += 1 + line.slice(col + 1).search(/\S|$/)
  }
  const rest = line.slice(col)
  const m = KEY.exec(rest)
  if (m) {
    const key = m[2] ?? m[3] ?? m[1]
    const value = rest.slice(m[0].length)
    if (/^\s*$/.test(value) && !/\s$/.test(rest)) return undefined
    const quote = /^\s*["']/.exec(value)
    const from = last.start + col + m[0].length + (value.length - value.trimStart().length) + (quote ? 1 : 0)
    return { kind: "value", path: [...parentOf(stack, col, false).path, key], from }
  }
  if (!/^[^\s:#'"{[]*$/.test(rest)) return undefined
  return { kind: "key", path: (parent ?? parentOf(stack, col, false)).path, from: last.start + col }
}

/** The schema's problems with a parsed config, on the key or value of the file they are about. */
export function configProblems(schema: Schema, text: string, config: unknown): { from: number; to: number; message: string }[] {
  const entries = yamlOutline(text)
  const same = (a: Key[], b: Key[]) => a.length === b.length && a.every((k, i) => k === b[i])
  return validate(schema, config).map((p) => {
    const exact = entries.find((e) => same(e.path, p.path))
    // A value inside a flow list or map is shown on the nearest key that holds it.
    let range: Range = { from: 0, to: 0 }
    if (exact) range = p.at === "key" || exact.value.from === exact.value.to ? exact.key : exact.value
    else {
      for (let n = p.path.length - 1; n > 0; n--) {
        const holder = entries.find((e) => same(e.path, p.path.slice(0, n)))
        if (holder) {
          range = holder.value.from === holder.value.to ? holder.key : holder.value
          break
        }
      }
    }
    return { ...range, message: p.message }
  })
}

/** The 0-based line of a YAML parse error, from the `yaml` package's linePos or js-yaml's mark. */
export function yamlErrorLine(e: unknown): number | undefined {
  const err = e as { linePos?: { line: number }[]; mark?: { line: number } }
  if (err?.linePos?.[0]?.line) return err.linePos[0].line - 1
  if (typeof err?.mark?.line === "number") return err.mark.line
  return undefined
}
