import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionService, parseChallenge, parseStorefronts, assertProfile, safeFailure } from '../connection-service.ts';

const challenge = '\nTo authenticate, open this URL in your browser:\n  https://secure.ultracart.com/oauth/device?code=DEMO\n\nEnter code: ABCD-EFGH\n';
test('accepts official challenge, rejects redirected credential URLs', () => {
  assert.equal(parseChallenge('partial output'), null);
  assert.equal(parseChallenge(challenge)?.code, 'ABCD-EFGH');
  for (const origin of ['https://secure.ultracart.com.evil.test', 'https://evil.test', 'https://name:password@secure.ultracart.com']) {
    assert.throws(() => parseChallenge(challenge.replace('https://secure.ultracart.com', origin)));
  }
});
test('profile inputs cannot become command options or shell fragments', () => {
  for (const name of ['my-store', 'merchant_2', 'abc.def']) assert.doesNotThrow(() => assertProfile(name));
  for (const name of ['', '--help', 'a b', 'a;ls', '$(id)', 'a/b', 'x'.repeat(65)]) assert.throws(() => assertProfile(name));
});
test('projects only storefront identity fields and rejects malformed identities', () => {
  assert.deepEqual(parseStorefronts({ merchantId:'TEST', storefronts:[{storefront_oid:1,host_name:'store.example',active_theme_oid:2,token:'never-return'}] }), {merchantId:'TEST',storefronts:[{id:1,host:'store.example',themeId:2}]});
  assert.throws(() => parseStorefronts({merchantId:'TEST',storefronts:[{storefront_oid:'1',host_name:'bad'}]}));
  assert.throws(() => parseStorefronts({storefronts:[]}));
  assert.equal(safeFailure('secret=do-not-expose').includes('do-not-expose'), false);
});
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'uc-connection-test-'));
  const cliPath = join(root, 'toolkit.mjs');
  await writeFile(cliPath, source);
  const service = new ConnectionService(async () => ({nodePath:process.execPath,cliPath}));
  return {service, cleanup:async () => {service.dispose(); await rm(root,{recursive:true,force:true});}};
}
async function waitUntil(check: () => boolean) {
  for (let i=0;i<150;i++) { if(check()) return; await new Promise(r=>setTimeout(r,20)); }
  assert.fail('state transition timed out');
}
test('device flow stays in memory, rejects concurrent commands, and cancels cleanly', async () => {
  const f = await fixture(`process.stderr.write(${JSON.stringify(challenge)}); setInterval(()=>{},1000);`);
  try {
    const state=await f.service.begin('test-store');
    await waitUntil(()=>f.service.loginStatus(state.id).phase==='waiting');
    await assert.rejects(f.service.storefronts('test-store'), /in progress/);
    const cancelled=f.service.cancel(state.id);
    assert.equal(cancelled.phase,'cancelled'); assert.equal(cancelled.code,null); assert.equal(cancelled.url,null);
    assert.throws(()=>f.service.loginStatus('unknown'), /no longer active/);
  } finally {await f.cleanup();}
});
test('success requires a valid CLI result and clears the authorization challenge', async () => {
  const f=await fixture(`process.stderr.write(${JSON.stringify(challenge)}); setTimeout(()=>{console.log(JSON.stringify({action:'auth.login',identity:{merchantId:'TEST'},accessToken:'not-forwarded'}));},80);`);
  try {
    const initial=await f.service.begin('test-store');
    await waitUntil(()=>f.service.loginStatus(initial.id).phase==='succeeded');
    const done=f.service.loginStatus(initial.id);
    assert.equal(done.url,null); assert.equal(done.code,null);
    assert.equal(JSON.stringify(done).includes('not-forwarded'),false);
  } finally {await f.cleanup();}
});
test('process failure becomes a bounded safe UI error', async () => {
  const f=await fixture(`process.stderr.write('invalid_grant secret_token=do-not-expose');process.exitCode=1;`);
  try { await assert.rejects(f.service.storefronts('test-store'), error=>error instanceof Error && error.message.includes('needs sign-in') && !error.message.includes('do-not-expose')); }
  finally {await f.cleanup();}
});
