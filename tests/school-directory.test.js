'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SchoolDirectory,matchPlace}=require('../eokul');
const {provinceOptions}=require('../locations');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fakeConfig({failFirst=false}={}) {
 const counts={clients:0,type:0,province:0,district:0,closed:0,active:0,max:0};
 return {counts,config:{makeClient:()=>{
   const number=++counts.clients;let district='';
   return {
    selectType:async()=>{counts.type++;await wait(2);},selectProvince:async()=>{counts.province++;},
    options:id=>id==='ddlIl'?[['P','İSTANBUL'],['P2','ANKARA'],['P3','İZMİR']]:id==='ddlIlce'?[['D1','KADIKÖY'],['D2','BEŞİKTAŞ']]:[[`S-${district}`,`Okul ${district}`]],
    selectDistrict:async id=>{counts.district++;district=id;counts.max=Math.max(counts.max,++counts.active);try{await wait(2);if(failFirst&&number===1)throw new Error('SESSION_EXPIRED');}finally{counts.active--;}},
    close(){counts.closed++;}
   };
 }}};
}
test('Province labels include two-digit plates and still match MEB names',()=>{
 const options=provinceOptions();assert.ok(options.some(([id,label])=>id==='6'&&label==='ANKARA (06)'));
 assert.ok(options.some(([id,label])=>id==='34'&&label==='İSTANBUL (34)'));
 assert.equal(matchPlace([['P','ANKARA']],'ANKARA (06)','province'),'P');
});
test('Warm session performs type/province once; district list needs only district selection',async()=>{
 const {counts,config}=fakeConfig(),d=new SchoolDirectory(config);
 await d.warm('22','İSTANBUL (34)');assert.equal(counts.type,1);assert.equal(counts.province,1);assert.equal(counts.district,0);
 const a=await d.list('22','İSTANBUL (34)','KADIKÖY');const b=await d.list('22','İstanbul','BEŞİKTAŞ');
 assert.equal(a.il,'P');assert.equal(a.ilce,'D1');assert.equal(b.ilce,'D2');
 assert.equal(counts.clients,1);assert.equal(counts.type,1);assert.equal(counts.province,1);assert.equal(counts.district,2);d.close();assert.equal(counts.closed,1);
});
test('Concurrent warm requests reuse one in-flight preparation',async()=>{
 const {counts,config}=fakeConfig(),d=new SchoolDirectory(config);
 await Promise.all([d.warm('22','İSTANBUL (34)'),d.warm('22','İstanbul')]);assert.equal(counts.clients,1);d.close();
});
test('Mutable ASP.NET session is serialized across district queries',async()=>{
 const {counts,config}=fakeConfig(),d=new SchoolDirectory(config);
 const [a,b]=await Promise.all([d.list('22','İstanbul','Kadıköy'),d.list('22','İstanbul','Beşiktaş')]);
 assert.equal(counts.max,1);assert.equal(a.items[0][0],'S-D1');assert.equal(b.items[0][0],'S-D2');d.close();
});
test('Expired idle sessions close before being replaced',async()=>{
 const {counts,config}=fakeConfig(),d=new SchoolDirectory(config);await d.warm('22','İstanbul');
 [...d.entries.values()][0].expires=Date.now()-1;await d.warm('22','İstanbul');assert.equal(counts.clients,2);assert.equal(counts.closed,1);d.close();
});
test('Invalid prepared session reconnects once within request budget',async()=>{
 const {counts,config}=fakeConfig({failFirst:true}),d=new SchoolDirectory(config);
 const result=await d.list('22','İstanbul','Kadıköy');assert.equal(result.ilce,'D1');assert.equal(counts.clients,2);d.close();
});
test('Proxy-only warm never silently creates direct client',async()=>{
 let created=0;const d=new SchoolDirectory({pool:{pick:async()=>null},direct:false,makeClient:()=>{created++;}});
 await assert.rejects(d.warm('22','İstanbul'));assert.equal(created,0);d.close();
});
test('Prepared sessions are bounded and idle LRU clients are closed',async()=>{
 const {counts,config}=fakeConfig(),d=new SchoolDirectory(config,{max:2});
 await d.warm('22','İstanbul');await d.warm('22','Ankara');await d.warm('22','İzmir');
 assert.equal(d.entries.size,2);assert.equal(counts.closed,1);d.close();assert.equal(counts.closed,3);
});
test('Closing directory during warm closes the arriving client',async()=>{
 let finish,closed=0;const d=new SchoolDirectory({makeClient:()=>({selectType:()=>new Promise(r=>finish=r),selectProvince:async()=>{},options:id=>id==='ddlIl'?[['P','İSTANBUL']]:[],close:()=>closed++})});
 const pending=d.warm('22','İstanbul');d.close();finish();await assert.rejects(pending);assert.equal(closed,1);
});
