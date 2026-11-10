import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDefinitions, parseRelated, normalize } from '../scripts/sql-functions.mjs';

const SQL = `
create or replace function public.a(p text)
returns text language plpgsql as $fn$
begin
  -- a ; inside a comment
  return 'x;y' || $$;$$;
end;
$fn$;

comment on function public.a(text) is 'it''s; fine';
grant execute on function public.a(text) to authenticated;

create function public.b() returns int language sql as $$ select 1; $$;
`;

test('parseDefinitions finds each function and ends at its real semicolon', () => {
  const defs = parseDefinitions(SQL);
  assert.deepEqual(defs.map((d) => d.name), ['a', 'b']);
  assert.ok(defs[0].text.endsWith('$fn$;'));
  assert.ok(defs[1].text.endsWith('$$;'));
});

test('parseRelated collects comment/grant statements with quoted semicolons', () => {
  const rel = parseRelated(SQL).get('a');
  assert.equal(rel.length, 2);
  assert.ok(rel[0].endsWith("'it''s; fine';"));
});

test('normalize treats create and create or replace as equal', () => {
  const [, b] = parseDefinitions(SQL);
  assert.equal(normalize(b.text), normalize(b.text.replace('create function', 'create or replace  function')));
});
