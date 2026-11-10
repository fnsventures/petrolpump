#!/usr/bin/env node
// Canonical SQL function sources: supabase/functions-sql/<name>.sql holds the current
// definition of each public function (plus its comment / grant / revoke statements).
// Edit that file, then `emit` it into a new migration instead of copying from an old one.
//
//   node scripts/sql-functions.mjs check               # files == schema.sql == newest migration definition
//   node scripts/sql-functions.mjs emit <name>... [--to <migration.sql>]
//        append each file to the migration (default: newest in supabase/migrations/) and
//        replace that function's definition in supabase/schema.sql
//   node scripts/sql-functions.mjs extract [<name>...] # (re)write files from schema.sql
//
// The Supabase CLI does not run psql meta-commands, so migrations cannot `\i` these files;
// `emit` copies the text in. No database is touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN_DIR = path.join(ROOT, 'supabase/functions-sql');
const MIG_DIR = path.join(ROOT, 'supabase/migrations');
const SCHEMA = path.join(ROOT, 'supabase/schema.sql');

const CREATE_RE = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)\s*\(/gi;
const RELATED_RE = /(?:^|\n)[ \t]*((?:comment\s+on|grant|revoke)\b[^;']*?\bfunction\s+public\.([a-z_0-9]+)\s*\()/gi;

/** End index (exclusive) of the statement starting at `from`: first `;` outside quotes. */
function statementEnd(sql, from) {
  let i = from;
  while (i < sql.length) {
    const c = sql[i];
    if (c === ';') return i + 1;
    if (c === "'") {
      i = sql.indexOf("'", i + 1);
      while (i >= 0 && sql[i + 1] === "'") i = sql.indexOf("'", i + 2);
      if (i < 0) return sql.length;
      i++;
      continue;
    }
    if (c === '$') {
      const tag = /^\$[a-z_0-9]*\$/i.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) return sql.length;
        i = close + tag[0].length;
        continue;
      }
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    i++;
  }
  return sql.length;
}

/** @returns {{name: string, start: number, end: number, text: string}[]} */
export function parseDefinitions(sql) {
  const out = [];
  CREATE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_RE.exec(sql))) {
    const end = statementEnd(sql, CREATE_RE.lastIndex);
    out.push({ name: m[1].toLowerCase(), start: m.index, end, text: sql.slice(m.index, end) });
    CREATE_RE.lastIndex = end;
  }
  return out;
}

/** comment on / grant / revoke statements naming a public function, keyed by function name. */
export function parseRelated(sql) {
  const out = new Map();
  RELATED_RE.lastIndex = 0;
  let m;
  while ((m = RELATED_RE.exec(sql))) {
    const start = m.index + m[0].indexOf(m[1]);
    const end = statementEnd(sql, start);
    const name = m[2].toLowerCase();
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(sql.slice(start, end));
    RELATED_RE.lastIndex = end;
  }
  return out;
}

/** Comparison form: no comments, collapsed whitespace, `create function` == `create or replace function`. */
export function normalize(text) {
  return text
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^create (or replace )?function/, 'create or replace function');
}

const read = (f) => fs.readFileSync(f, 'utf8');
const fnFile = (name) => path.join(FN_DIR, `${name}.sql`);
const migrations = () => fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

function schemaDefinitions() {
  const sql = read(SCHEMA);
  const defs = parseDefinitions(sql);
  const seen = new Map();
  for (const d of defs) {
    if (seen.has(d.name)) {
      throw new Error(`schema.sql defines public.${d.name} twice (overload). One file per name assumes no overloads.`);
    }
    seen.set(d.name, d);
  }
  return { sql, defs: seen, related: parseRelated(sql) };
}

function fileBody(def, related) {
  const header = `-- Canonical definition of public.${def.name}. Edit here, then:\n--   node scripts/sql-functions.mjs emit ${def.name}\n`;
  return [header + def.text.replace(/^create\s+function/i, 'create or replace function'), ...(related || [])].join('\n\n') + '\n';
}

/** Definition text from a functions-sql file (throws unless it holds exactly one, for `name`). */
function readFileDefinition(name) {
  const file = fnFile(name);
  if (!fs.existsSync(file)) throw new Error(`No ${path.relative(ROOT, file)} (run: node scripts/sql-functions.mjs extract ${name})`);
  const sql = read(file);
  const defs = parseDefinitions(sql);
  if (defs.length !== 1 || defs[0].name !== name) {
    throw new Error(`${path.relative(ROOT, file)} must contain exactly one definition, of public.${name}`);
  }
  return { sql, def: defs[0] };
}

function extract(names) {
  const { defs, related } = schemaDefinitions();
  fs.mkdirSync(FN_DIR, { recursive: true });
  const targets = names.length ? names : [...defs.keys()];
  for (const name of targets) {
    const def = defs.get(name);
    if (!def) throw new Error(`schema.sql has no public.${name}`);
    fs.writeFileSync(fnFile(name), fileBody(def, related.get(name)));
  }
  console.log(`Wrote ${targets.length} file(s) to ${path.relative(ROOT, FN_DIR)}/`);
}

function emit(names, to) {
  if (!names.length) throw new Error('emit: name at least one function');
  const target = to ? path.resolve(to) : path.join(MIG_DIR, migrations().at(-1));
  if (!target.startsWith(MIG_DIR + path.sep)) throw new Error(`--to must be a file in ${path.relative(ROOT, MIG_DIR)}/`);
  let schema = read(SCHEMA);
  let migration = fs.existsSync(target) ? read(target) : '';
  for (const name of names) {
    const { sql, def } = readFileDefinition(name);
    const body = sql.replace(/^(--[^\n]*\n)+/, '').trimEnd();
    migration = `${migration.trimEnd()}${migration.trim() ? '\n\n' : ''}-- From supabase/functions-sql/${name}.sql\n${body}\n`;
    const current = parseDefinitions(schema).find((d) => d.name === name);
    if (current) {
      schema = schema.slice(0, current.start) + def.text + schema.slice(current.end);
    } else {
      console.warn(`public.${name} is new: add it (and its grants) to supabase/schema.sql by hand.`);
    }
    // Comments/grants in the file that schema.sql lacks must be added by hand; check reports them.
  }
  fs.writeFileSync(target, migration);
  fs.writeFileSync(SCHEMA, schema);
  console.log(`Appended ${names.join(', ')} to ${path.relative(ROOT, target)} and updated supabase/schema.sql.`);
  console.log('Signature changed? Add `drop function if exists public.<name>(<old arg types>);` above it in the migration.');
}

function check() {
  const errors = [];
  const { defs, related } = schemaDefinitions();
  const relatedNorm = new Set([...related.values()].flat().map(normalize));

  const newest = new Map();
  for (const f of migrations()) {
    for (const d of parseDefinitions(read(path.join(MIG_DIR, f)))) newest.set(d.name, { ...d, file: f });
  }

  const files = fs.existsSync(FN_DIR)
    ? fs.readdirSync(FN_DIR).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4))
    : [];
  for (const name of files) {
    if (!defs.has(name)) errors.push(`functions-sql/${name}.sql: schema.sql has no public.${name} (dropped? delete the file)`);
  }
  for (const [name, def] of defs) {
    let parsed;
    try {
      parsed = readFileDefinition(name);
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    const want = normalize(parsed.def.text);
    if (normalize(def.text) !== want) {
      errors.push(`functions-sql/${name}.sql differs from supabase/schema.sql (run: node scripts/sql-functions.mjs emit ${name})`);
    }
    const mig = newest.get(name);
    if (!mig) {
      errors.push(`public.${name}: no migration defines it (emit it into a migration)`);
    } else if (normalize(mig.text) !== want) {
      errors.push(`functions-sql/${name}.sql differs from its newest migration ${mig.file} (emit it into a new migration)`);
    }
    for (const stmt of parseRelated(parsed.sql).get(name) || []) {
      if (!relatedNorm.has(normalize(stmt))) errors.push(`functions-sql/${name}.sql: not in schema.sql: ${stmt.split('\n')[0]}`);
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(`SQL functions OK: ${defs.size} files match schema.sql and their newest migration.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const toIdx = rest.indexOf('--to');
  const to = toIdx >= 0 ? rest.splice(toIdx, 2)[1] : undefined;
  try {
    if (cmd === 'check') check();
    else if (cmd === 'extract') extract(rest);
    else if (cmd === 'emit') emit(rest, to);
    else {
      console.error('Usage: node scripts/sql-functions.mjs check | extract [name...] | emit <name...> [--to <migration.sql>]');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
