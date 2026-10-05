import test from 'node:test';
import assert from 'node:assert/strict';
import { completedTrafficWindow, trafficTree } from '../traffic-data.ts';
import { pageTrafficSql, parsePageTraffic } from '../traffic-service.ts';
import type { TrafficPage } from '../traffic-contract.ts';
const selection={profileId:'test-profile',merchantId:'TEST',storefront:{id:123,host:'shop.example',themeId:null},verifiedAt:'current'};
const window={from:'2026-09-04',to:'2026-10-03'};
const page=(id:number,parentId:number|null,path:string,sessions=0):TrafficPage=>({id,parentId,path,title:path,visible:true,sessions,catalogCopies:1});
const pages=[page(1,null,'/',10),page(2,1,'/category/',4),page(3,2,'/category/item/',7),page(4,1,'/about/',0)];
test('thirty completed UTC days cross month/year and exclude today',()=>{
 assert.deepEqual(completedTrafficWindow(new Date('2026-10-04T23:55:00Z')),window);
 assert.deepEqual(completedTrafficWindow(new Date('2026-01-01T00:00:00Z')),{from:'2025-12-02',to:'2025-12-31'});
});
test('hierarchy preserves direct counts, search ancestors and sibling-only traffic ordering',()=>{
 const opts={query:'',sort:'sessions' as const,onlyZero:false,expanded:new Set(pages.map(p=>p.id))};
 const full=trafficTree(pages,opts);
 assert.deepEqual(full.map(r=>[r.page.id,r.depth,r.page.sessions]),[[1,0,10],[2,1,4],[3,2,7],[4,1,0]]);
 assert.deepEqual(trafficTree(pages,{...opts,expanded:new Set()}).map(r=>r.page.id),[1]);
 const search=trafficTree(pages,{...opts,expanded:new Set(),query:'item'});
 assert.deepEqual(search.map(r=>r.page.id),[1,2,3]);assert.ok(search.every(r=>r.forcedOpen));
 assert.deepEqual(trafficTree(pages,{...opts,onlyZero:true}).map(r=>r.page.id),[1,4]);
});
test('missing parents, self references, cycles, and deep trees remain finite and visible',()=>{
 const broken=[page(1,2,'/a/'),page(2,1,'/b/'),page(3,99,'/c/'),page(4,4,'/d/')];
 const rows=trafficTree(broken,{query:'',sort:'structure',onlyZero:false,expanded:new Set([1,2,3,4])});
 assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.page.id)).size,4);assert.equal(rows.filter(r=>r.orphan).length,3);
 const deep=Array.from({length:10000},(_,i)=>page(i+1,i||null,`/p${i}/`));
 assert.equal(trafficTree(deep,{query:'',sort:'structure',onlyZero:false,expanded:new Set(deep.map(p=>p.id))}).length,10000);
});
test('query pins host, storefront, session grain, bot and two date filters with a full array result',()=>{
 const sql=pageTrafficSql(selection,window);
 for(const text of ["storefront_oid = 123","LOWER(NET.HOST(h.page_view.url)) = 'shop.example'",'COUNT(DISTINCT client_session_oid)','session_start.bot OR b.session_start.fake_bot','DATE(s.session_dts) BETWEEN','DATE_TRUNC','LEFT JOIN traffic','parent_storefront_page_oid','AS total_pages','LIMIT 10000','SELECT ARRAY'])assert.ok(sql.includes(text),text);
 assert.throws(()=>pageTrafficSql({...selection,storefront:{...selection.storefront,host:"shop.example'"}},window));
});
test('complete snapshots preserve zero counts but reject truncation, duplicate IDs and malformed results',()=>{
 const row={pages:[{id:'1',parent_id:null,path:'/',title:'Home',visible:null,sessions:'0',catalog_copies:'1'}],total_pages:'1',host_sessions:'0',unmatched_paths:'0'};
 const result=parsePageTraffic([row],selection,window,100);
 assert.equal(result.pages[0].sessions,0);assert.equal(result.pages[0].visible,null);
 assert.throws(()=>parsePageTraffic([{...row,total_pages:'2'}],selection,window,100),/incomplete/);
 assert.throws(()=>parsePageTraffic([{...row,total_pages:'10001'}],selection,window,100),/limit/);
 assert.throws(()=>parsePageTraffic([{...row,pages:[...row.pages,...row.pages],total_pages:'2'}],selection,window,100),/duplicated/);
 assert.throws(()=>parsePageTraffic([{...row,pages:[{...row.pages[0],sessions:null}]}],selection,window,100),/Invalid/);
 assert.throws(()=>parsePageTraffic([{...row,pages:[{...row.pages[0],sessions:2}]}],selection,window,100),/exceed/);
 assert.throws(()=>parsePageTraffic([],selection,window,100),/complete/);
});
