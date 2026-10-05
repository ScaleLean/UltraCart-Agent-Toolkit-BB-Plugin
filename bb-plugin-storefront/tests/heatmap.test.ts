import test from 'node:test';
import assert from 'node:assert/strict';
import {createHeatmapFeature,heatmapQuery,parseHeatmapReceipt,parseHeatmapRows,validateHeatmapFilters} from '../heatmap-service.ts';
const selection={profileId:'profile-test',merchantId:'TEST',storefront:{id:123,host:'shop.example',themeId:456},verifiedAt:'2026-10-02T00:00:00Z'};
const filters={from:'2026-09-01',to:'2026-09-07',device:'mobile' as const};
const summary={elements:[{selector:'#button-42 > a',clicks:'12',movements:'3'}],total_clicks:'16',total_movements:'5',heatmap_rows:'10',scroll_p25:'25',scroll_median:'40',scroll_p75:'80'};
function receipt(executed:boolean){return JSON.stringify({action:'warehouse.query',project:'ultracart-dw-test',estimatedBytes:1000,maxBytes:1024**3,referencedTables:['ultracart-dw-test.ultracart_dw_streaming.heatmap'],executed,...(executed?{rows:[summary]}:{})});}
test('heatmap queries bind device, merchant host and exact page plus both date filters',()=>{
 const q=heatmapQuery(selection,'/offer/',filters);
 assert.match(q.sql,/h\.partition_date BETWEEN DATE_SUB/);assert.match(q.sql,/DATE\(h\.heatmap_date\) BETWEEN/);assert.match(q.sql,/LOWER\(NET.HOST\(h.url\)\) = @host/);assert.match(q.sql,/LIMIT 40/);assert.equal(q.sql.includes(';'),false);
 assert.deepEqual(q.parameters,['from:DATE:2026-09-01','to:DATE:2026-09-07','device:STRING:mobile','host:STRING:shop.example','path:STRING:/offer/']);
 assert.throws(()=>heatmapQuery(selection,'//other.example',filters));
 assert.throws(()=>validateHeatmapFilters({...filters,from:'2026-02-30'}));assert.throws(()=>validateHeatmapFilters({...filters,to:'2026-08-31'}));assert.throws(()=>validateHeatmapFilters({...filters,to:'2026-11-01'}));
});
test('receipt validation rejects another merchant, extra dataset and invalid costs',()=>{
 assert.equal(parseHeatmapReceipt(receipt(false),'TEST',false).receipt.project,'ultracart-dw-test');
 const data=JSON.parse(receipt(false));for(const changed of [{project:'ultracart-dw-other'},{referencedTables:['ultracart-dw-other.ultracart_dw.x']},{referencedTables:['ultracart-dw-test.private.x']},{estimatedBytes:1024**3+1},{executed:true}])assert.throws(()=>parseHeatmapReceipt(JSON.stringify({...data,...changed}),'TEST',false));
});
test('summary distinguishes total events from top element list and preserves empty quartiles',()=>{
 const data=parseHeatmapRows([summary]);assert.equal(data.rows[0].clicks,12);assert.equal(data.clicks,16);assert.equal(data.scroll.median,40);
 assert.deepEqual(parseHeatmapRows([{elements:[],total_clicks:0,total_movements:0,heatmap_rows:0,scroll_p25:null,scroll_median:null,scroll_p75:null}]).scroll,{p25:null,median:null,p75:null});
 assert.throws(()=>parseHeatmapRows([{...summary,scroll_median:101}]));assert.throws(()=>parseHeatmapRows([{...summary,total_clicks:'-1'}]));assert.throws(()=>parseHeatmapRows([]));
});
test('preview never executes; tickets bind exact scope, expire and are single use',async()=>{
 const calls:string[][]=[];const service={verify:async()=>{},run:async(args:string[])=>{calls.push(args);return receipt(!args.includes('--dry-run'));}};
 const feature=createHeatmapFeature({service,selected:async s=>s});const preview=await feature.previewHeatmap({selection,path:'/offer/',filters});
 assert.equal(calls.length,1);assert.ok(calls[0].includes('--dry-run'));assert.ok(calls[0].includes('--profile'));assert.ok(calls[0].includes('profile-test'));assert.ok(calls[0].includes('--merchant'));assert.ok(calls[0].includes('TEST'));
 await assert.rejects(feature.runHeatmap({selection,path:'/other/',ticket:preview.ticket}),/Preview/);
 await assert.rejects(feature.runHeatmap({selection:{...selection,verifiedAt:'changed'},path:'/offer/',ticket:preview.ticket}),/Preview/);
 const result=await feature.runHeatmap({selection,path:'/offer/',ticket:preview.ticket});assert.equal(result.clicks,16);assert.equal(calls.length,2);assert.equal(calls[1].includes('--dry-run'),false);
 await assert.rejects(feature.runHeatmap({selection,path:'/offer/',ticket:preview.ticket}),/Preview/);
 const stale=await feature.previewHeatmap({selection,path:'/offer/',filters});const now=Date.now;Date.now=()=>now()+6*60000;try{await assert.rejects(feature.runHeatmap({selection,path:'/offer/',ticket:stale.ticket}),/Preview/);}finally{Date.now=now;}
});
test('lookup permits documented nonmatching exit response and rejects foreign scope',async()=>{
 let options:unknown;const report={action:'sf.locate',storefrontOid:123,page:'/offer/',results:[{input:'#button-42',status:'not_found',reason:'No current widget',matches:[]}],warnings:[],notFollowed:[]};
 const feature=createHeatmapFeature({selected:async s=>s,service:{verify:async()=>{},run:async(_args,opts)=>{options=opts;return JSON.stringify(report);}}});
 assert.equal((await feature.locateHeatmap({selection,path:'/offer/',selector:'#button-42'})).status,'not_found');assert.deepEqual(options,{acceptedExitCodes:[0,1]});
 report.storefrontOid=999;await assert.rejects(feature.locateHeatmap({selection,path:'/offer/',selector:'#button-42'}),/scope/);
 await assert.rejects(feature.locateHeatmap({selection,path:'/offer/',selector:'--live'}),/valid selector/);
});
