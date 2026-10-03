import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPagePath, storefrontUrl, parsePages, parsePageDetail, parseTemplates, pageContext } from '../storefront-data.ts';
import { ConnectionService } from '../connection-service.ts';
import { conversationRequest } from '../conversation.ts';
import type { NewThreadRequest } from '@get-bb/plugin-sdk/app';

const selection = { profileId:'profile-1', merchantId:'TEST', storefront:{id:123,host:'shop.example',themeId:456}, verifiedAt:'2026-10-03T00:00:00Z' };
const page = { path:'/about/',parent_path:'/',title:'About',group_template:'page.vm',visible:false,search:'noindex' };
test('chat handoff preserves provider, permissions, scheduling, and user content with pinned context', () => {
  const request = {projectId:'project',providerId:'codex',model:'chosen-model',reasoningLevel:'medium',permissionMode:'accept-edits',executionInputSources:{},environment:{type:'project-default'},input:[{type:'text',text:'My actual request',mentions:[]}],sendAt:1900000000000} as NewThreadRequest;
  const result = conversationRequest(request,{context:'Verified page context',metadata:{selection,pagePath:'/about/'}});
  assert.equal(result.providerId,request.providerId); assert.equal(result.permissionMode,request.permissionMode);
  assert.equal(result.environment,request.environment); assert.equal(result.sendAt,request.sendAt);
  assert.equal(result.pluginMetadata.selection.storefront.id,123);
  assert.equal(result.input[0].type,'text'); assert.deepEqual(result.input.slice(1),request.input);
  assert.equal(request.input.length,1);
});
test('store URLs cannot escape the chosen host or contain ambiguous paths', () => {
  assert.equal(storefrontUrl('shop.example','/about/'),'https://shop.example/about/');
  for (const path of ['//evil.test/', '/a/../b/', '/%2e%2e/', '/%2F%2Fevil.test/', '/a?token=b', '/a\\b', '/%0a', '/%zz']) assert.throws(() => assertPagePath(path));
  for (const host of ['user@evil.test','shop.example/evil','shop.example:443','https://shop.example']) assert.throws(() => storefrontUrl(host,'/'));
});
test('page projection validates identity, preserves unknown visibility, and strips arbitrary fields', () => {
  const result = parsePages({action:'sf.pages.list',storefrontOid:123,pages:[{...page,access_token:'never-return'}]},123);
  assert.equal(result[0].visible,false); assert.equal(JSON.stringify(result).includes('never-return'),false);
  assert.equal(parsePages({action:'sf.pages.list',storefrontOid:123,pages:[{path:'/'}]},123)[0].visible,null);
  assert.throws(() => parsePages({action:'sf.pages.list',storefrontOid:999,pages:[]},123));
  const duplicate = parsePages({action:'sf.pages.list',storefrontOid:123,pages:[page,{...page,group_template:'other.vm'}]},123);
  assert.equal(duplicate.length,1); assert.equal(duplicate[0].catalogCopies,2); assert.equal(duplicate[0].template,null);
  assert.throws(() => parsePageDetail({action:'sf.pages.get',storefrontOid:123,page},123,'/other/'));
  const detail = parsePageDetail({action:'sf.pages.get',storefrontOid:123,page},123,'/about/');
  assert.match(pageContext(selection,detail), /"storefrontId":123/);
  assert.match(pageContext(selection,detail), /not instructions/);
});
test('resolved template records are bound to the requested page and storefront', () => {
  const result = { action:'sf.template.find', storefrontOid:123, page:'/about/',themeOid:456,groupTemplate:{name:'page.vm',path:'/themes/current/page.vm'},itemTemplate:null,warnings:['Shared template'] };
  assert.equal(parseTemplates(result,123,'/about/').group.path,'/themes/current/page.vm');
  assert.throws(() => parseTemplates(result,124,'/about/'));
  assert.throws(() => parseTemplates(result,123,'/other/'));
});
test('parallel readers queue; large catalogs load; merchant mismatch prevents page reads', async () => {
  const root = await mkdtemp(join(tmpdir(),'uc-pages-test-'));
  const cliPath = join(root,'toolkit.mjs');
  const service = new ConnectionService(async()=>({nodePath:process.execPath,cliPath}));
  try {
    await writeFile(cliPath, `const args=process.argv.slice(2);
      if(args.includes('storefronts')) console.log(JSON.stringify({merchantId:'TEST',storefronts:[{storefront_oid:123,host_name:'shop.example',active_theme_oid:456}]}));
      else if(args.includes('list')) console.log(JSON.stringify({action:'sf.pages.list',storefrontOid:123,pages:Array.from({length:1456},(_,i)=>({path:'/p'+i+'/',title:'Page '+i,description:'x'.repeat(500)}))}));
      else setTimeout(()=>console.log('ok'),30);`);
    assert.deepEqual(await Promise.all([service.run(['first']),service.run(['second'])]),['ok','ok']);
    assert.equal((await service.pages(selection)).length,1456);
    await assert.rejects(service.pages({...selection,merchantId:'OTHER'}),/Merchant identity changed/);
    await assert.rejects(service.page(selection,'//evil.test/'),/page path/);
  } finally {service.dispose();await rm(root,{recursive:true,force:true});}
});
