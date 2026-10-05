import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
const selection={profileId:'test-profile',merchantId:'TEST',storefront:{id:123,host:'shop.example',themeId:null},verifiedAt:'current'};
test('traffic RPC reads cache without queries, coalesces refresh, preserves cache on failure and rejects stale scope',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uc-traffic-test-'));
 const cliPath=join(root,'cli.mjs'),log=join(root,'calls.jsonl'),fail=join(root,'fail');
 await writeFile(cliPath,`import {appendFileSync,existsSync} from 'node:fs';
 const a=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
 if(a.includes('storefronts')) console.log(JSON.stringify({merchantId:'TEST',storefronts:[{storefront_oid:123,host_name:'shop.example'}]}));
 else if(existsSync(${JSON.stringify(fail)})){process.stderr.write('gcloud auth login');process.exitCode=1;}
 else console.log(JSON.stringify({action:'warehouse.query',project:'ultracart-dw-test',estimatedBytes:100,maxBytes:1073741824,referencedTables:['ultracart-dw-test.ultracart_dw_streaming.sessions'],executed:!a.includes('--dry-run'),rows:a.includes('--dry-run')?undefined:[{pages:[{id:'1',parent_id:null,path:'/',title:'Home',visible:true,sessions:'3',catalog_copies:'1'},{id:'2',parent_id:'1',path:'/about/',title:'About',visible:null,sessions:'0',catalog_copies:'1'}],total_pages:'2',host_sessions:'3',unmatched_paths:'1'}]}));`);
 const {bb,harness}=createFakePluginHost({pluginId:'storefront',settings:{nodePath:process.execPath,cliPath}});
 let activeHarness=harness;
 try {
  plugin(bb);await bb.storage.kv.set('connection',selection);
  assert.equal(await harness.behavior.callRpc('readPageTraffic',{selection}),null);
  const [a,b]=await Promise.all([harness.behavior.callRpc('refreshPageTraffic',{selection}),harness.behavior.callRpc('refreshPageTraffic',{selection})]);
  assert.deepEqual(a,b);assert.equal(a.pages.length,2);assert.equal(a.pages[1].sessions,0);
  const commands=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(commands.filter(c=>c.includes('warehouse')&&!c.includes('--dry-run')).length,1);
  assert.equal(commands.filter(c=>c.includes('--dry-run')).length,2);
  assert.deepEqual(await harness.behavior.callRpc('readPageTraffic',{selection}),a);
  assert.equal((await readFile(log,'utf8')).trim().split('\n').length,commands.length);
  await writeFile(fail,'1');
  await assert.rejects(harness.behavior.callRpc('refreshPageTraffic',{selection}),/Google Cloud/);
  assert.deepEqual(await harness.behavior.callRpc('readPageTraffic',{selection}),a);
  await assert.rejects(harness.behavior.callRpc('refreshPageTraffic',{selection:{...selection,verifiedAt:'stale'}}),/selected store changed/);
  const reloaded=await harness.lifecycle.reload(plugin);
  activeHarness=reloaded.harness;
  assert.deepEqual(await activeHarness.behavior.callRpc('readPageTraffic',{selection}),a);
 } finally {await activeHarness.lifecycle.dispose();await rm(root,{recursive:true,force:true});}
});
