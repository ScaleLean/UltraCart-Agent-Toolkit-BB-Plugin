import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

const selection={profileId:'test-profile',merchantId:'TEST',storefront:{id:123,host:'shop.example',themeId:456},verifiedAt:'2026-10-03T00:00:00Z'};
test('RPC rejects stale store selection; agent tools retain their conversation scope',async()=>{
  const root=await mkdtemp(join(tmpdir(),'uc-server-test-'));
  const cliPath=join(root,'cli.mjs');
  await writeFile(cliPath,`const a=process.argv.slice(2);if(a.includes('storefronts'))console.log(JSON.stringify({merchantId:'TEST',storefronts:[{storefront_oid:123,host_name:'shop.example'}]}));else console.log(JSON.stringify({action:'sf.pages.get',storefrontOid:123,page:{path:'/about/',title:'About'}}));`);
  const {bb,harness}=createFakePluginHost({pluginId:'storefront',settings:{nodePath:process.execPath,cliPath},sdk:{threads:{getPluginMetadata:async()=>({selection,pagePath:'/about/'})}}});
  try {
    plugin(bb);
    const context={pluginMetadata:{selection,pagePath:'/about/'},thread:{id:'thread-1',title:'About',parentThreadId:null,sourceThreadId:null},project:{id:'project-1',kind:'standard',name:'Test',gitRemoteUrl:null},environment:{id:'env-1',name:null,path:null,branchName:null,workspaceProvisionType:null},host:{id:'host-1',name:'Local'},provider:{id:'codex',model:'test',capabilities:{supportsNativeUserQuestion:false}},origin:{kind:null,pluginId:'storefront'}};
    const configured=await harness.behavior.resolveAgentConfiguration(context);
    assert.equal(configured.tools.length,3);
    assert.equal((await harness.behavior.resolveAgentConfiguration({...context,pluginMetadata:{}})).tools.length,0);
    await bb.storage.kv.set('connection',selection);
    await assert.rejects(harness.behavior.callRpc('readPage',{selection:{...selection,verifiedAt:'old'},path:'/about/'}),/selected store changed/);
    const prepared=await harness.behavior.callRpc('prepareConversation',{selection,path:'/about/'});
    assert.equal(prepared.metadata.selection.storefront.id,123);
    await bb.storage.kv.set('connection',{...selection,storefront:{...selection.storefront,id:999}});
    const tool=await harness.behavior.callAgentTool('storefront_read_page',{}, {threadId:'thread-1',projectId:'project-1'});
    assert.match(JSON.stringify(tool),/About/);
    assert.doesNotMatch(JSON.stringify(tool),/999/);
  } finally {await harness.lifecycle.dispose();await rm(root,{recursive:true,force:true});}
});
