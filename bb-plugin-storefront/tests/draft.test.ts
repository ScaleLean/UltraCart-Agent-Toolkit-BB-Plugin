import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { DraftService, draftHash, draftChanges, containerPath, editDraftContent, parseDraftValidation, type DraftToolkit } from '../draft-service.ts';
import { draftRpcMethods } from '../draft-contract.ts';
import type { Selection } from '../connection-contract.ts';

const selection: Selection = { profileId: 'example-profile', merchantId: 'TEST', storefront: { id: 12, host: 'store.example', themeId: 34 }, verifiedAt: '2026-01-01T00:00:00Z' };
const scope = { selection, path: '/about/', slot: 'body' };
const body = JSON.stringify({ type: 'container', id: 'root', config: {}, childWidgets: [{ type: 'text', id: 'copy', config: { text: 'Original', 'slash/key': 'Escaped' } }] });
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE storefront_drafts (scope_key TEXT PRIMARY KEY, record TEXT NOT NULL)');
  const calls: string[][] = [];
  let remoteBody = body;
  const toolkit: DraftToolkit = {
    verify: async s => { assert.deepEqual(s, selection); },
    run: async args => {
      calls.push(args);
      assert.equal(args[5], 'pull');
      const file = args[args.indexOf('--out') + 1];
      const baseline = { version: 1, merchant: selection.merchantId, storefront: selection.storefront.id, to: '/about/body.cjson', hash: draftHash(remoteBody), content: remoteBody };
      await writeFile(file, remoteBody); await writeFile(file + '.sf.json', JSON.stringify(baseline));
      return JSON.stringify({ file, baseline: file + '.sf.json', hash: baseline.hash });
    },
    validateLocal: async file => {
      calls.push(['validate', file]);
      const text = await readFile(file, 'utf8');
      assert.equal(JSON.parse(text).childWidgets[0].config.text, 'Updated');
      return JSON.stringify({ valid: true, errors: 0, warnings: 1, diagnostics: [{ severity: 'warning', code: 'example', path: '/', message: 'Example warning' }], diagnosticsOmitted: 0 });
    },
  };
  const drafts = new DraftService(db as any, toolkit);
  return { db, drafts, calls, changeRemote: () => { remoteBody = remoteBody.replace('Original', 'Live changed'); } };
}
test('body destination is confined to the selected page and slot', () => {
  assert.equal(containerPath('/', 'body'), '/body.cjson');
  assert.equal(containerPath('/about/', 'hero'), '/about/hero.cjson');
  for (const path of ['//evil/', '/a/../b/', '/%2e%2e/', '/%252e%252e/', '/themes/Shared/', '/about?x=1', '/a\\b']) assert.throws(() => containerPath(path, 'body'));
  for (const slot of ['../body', '/body', '--live', 'x.cjson', '']) assert.throws(() => containerPath('/about/', slot));
});
test('text patch preserves tree and widget IDs and produces a baseline diff', () => {
  const next = editDraftContent(body, [{ pointer: '/childWidgets/0/config/text', value: 'Updated' }, { pointer: '/childWidgets/0/config/slash~1key', value: 'Other' }]);
  const parsed = JSON.parse(next);
  assert.equal(parsed.id, 'root'); assert.equal(parsed.childWidgets[0].id, 'copy');
  assert.equal(draftChanges(body, next).length, 2);
  assert.deepEqual(draftChanges(body, next)[0], { pointer: '/childWidgets/0/config/text', widget: 'text #copy', key: 'text', before: 'Original', value: 'Updated' });
  for (const pointer of ['/id', '/childWidgets/0/type', '/config/__proto__', '/childWidgets/0/config/new', '/childWidgets/0/config/../../id']) assert.throws(() => editDraftContent(body, [{ pointer, value: 'x' }]));
  assert.throws(() => editDraftContent(body, [{ pointer: '/childWidgets/0/config/text', value: 'x'.repeat(16385) }]));
});
test('pull persists immutable baseline, resumes local draft, saves with CAS and reviews without live mutations', async () => {
  const { db, drafts, calls, changeRemote } = setup();
  try {
    assert.equal(drafts.read(scope), null);
    const pulled = await drafts.pull(scope);
    assert.equal(pulled.revision, 1); assert.equal(pulled.changedFields, 0);
    assert.equal((await drafts.pull(scope)).id, pulled.id); assert.equal(calls.length, 1);
    const saved = await drafts.update({ ...scope, id: pulled.id, revision: 1, edits: [{ pointer: '/childWidgets/0/config/text', value: 'Updated' }] });
    assert.equal(saved.revision, 2); assert.equal(saved.changedFields, 1);
    assert.equal(drafts.read(scope)?.fields[0].before, 'Original');
    await assert.rejects(drafts.update({ ...scope, id: pulled.id, revision: 1, edits: [] }), /changed in another window/);
    await assert.rejects(drafts.update({ ...scope, path: '/other/', id: pulled.id, revision: 2, edits: [] }), /does not belong/);
    await assert.rejects(drafts.update({ ...scope, selection: { ...selection, merchantId: 'OTHER' }, id: pulled.id, revision: 2, edits: [] }), /does not belong/);
    const reviewed = await drafts.review({ ...scope, id: saved.id, revision: 2 });
    assert.equal(reviewed.remoteChanged, false); assert.equal(reviewed.validation.valid, true); assert.equal(reviewed.validation.warnings, 1); assert.equal(reviewed.changes.length, 1);
    changeRemote();
    assert.equal((await drafts.review({ ...scope, id: saved.id, revision: 2 })).remoteChanged, true);
    assert.equal(drafts.read(scope)?.baselineHash, draftHash(body));
    assert(calls.every(args => args[0] === 'validate' || (args.includes('pull') && !args.includes('push') && !args.includes('--live') && !args.includes('preview'))));
    const temp = calls.find(args => args[0] === 'validate')![1];
    await assert.rejects(readFile(temp));
    await assert.rejects(drafts.review({ ...scope, id: saved.id, revision: 1 }), /changed/);
  } finally { db.close(); }
});
test('validation diagnostics and strict RPC bounds fail closed', () => {
  const report = parseDraftValidation(JSON.stringify({ valid: false, errors: 1, warnings: 0, diagnostics: [{ severity: 'error', code: 'tree', path: '/', message: 'Missing ID' }] }));
  assert.equal(report.valid, false); assert.equal(report.errors, 1);
  assert.throws(() => parseDraftValidation('{}'));
  assert.equal(draftRpcMethods.pullDraft.input.safeParse({ ...scope, file: '/tmp/arbitrary' }).success, false);
  assert.equal(draftRpcMethods.saveDraft.input.safeParse({ ...scope, id: 'bad', revision: 1, edits: [] }).success, false);
  assert.equal(draftRpcMethods.saveDraft.input.safeParse({ ...scope, id: '00000000-0000-4000-8000-000000000000', revision: 1, edits: [{ pointer: '/config/text', value: 'x'.repeat(16385) }] }).success, false);
});

test('translated and responsive config strings remain editable without replacing wrappers', () => {
  const original = JSON.stringify({ id: 'copy', type: 'textblock', config: { richText: { en: '<p>Hello</p>', es: '<p>Hola</p>' }, color: { small: 'blue', large: 'red' } } });
  const changed = editDraftContent(original, [{ pointer: '/config/richText/en', value: '<p>Welcome</p>' }]);
  const config = JSON.parse(changed).config;
  assert.equal(config.richText.en, '<p>Welcome</p>'); assert.equal(config.richText.es, '<p>Hola</p>');
  assert.equal(config.color.large, 'red'); assert.equal(draftChanges(original, changed).length, 1);
});
