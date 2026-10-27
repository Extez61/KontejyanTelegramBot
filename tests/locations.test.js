'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {provinceOptions,districtOptions}=require('../locations');
const {fetchSchoolOptions,matchPlace}=require('../eokul');
const {Store}=require('../db');
const {EokulBot}=require('../bot');
test('Ready dataset contains 81 unique provinces and 973 districts',()=>{
 const provinces=provinceOptions();assert.equal(provinces.length,81);assert.equal(new Set(provinces.map(([id])=>id)).size,81);
 assert.equal(provinces.reduce((n,[id])=>n+districtOptions(id).length,0),973);
 assert.ok(districtOptions('34').some(([,name])=>name==='KADIKÖY'));
 assert.deepEqual(districtOptions('missing'),[]);
});
test('MEB mapping uses names instead of assuming static numeric IDs',async()=>{
 let selectedProvince,selectedDistrict,closed=0;
 const result=await fetchSchoolOptions('22','İstanbul','Kadıköy',{makeClient:()=>({
  selectType:async()=>{},selectProvince:async id=>{selectedProvince=id;},selectDistrict:async id=>{selectedDistrict=id;},
  options:id=>id==='ddlIl'?[['MEB-PROVINCE','İSTANBUL']]:id==='ddlIlce'?[['MEB-DISTRICT','KADIKÖY']]:[['S','Okul']],close:()=>closed++
 })});
 assert.equal(selectedProvince,'MEB-PROVINCE');assert.equal(selectedDistrict,'MEB-DISTRICT');
 assert.deepEqual(result,{il:'MEB-PROVINCE',ilce:'MEB-DISTRICT',items:[['S','Okul']]});assert.equal(closed,1);
});
test('MEB province aliases are accepted; missing or ambiguous district fails closed',()=>{
 assert.equal(matchPlace([['A','İÇEL']],'Mersin','province'),'A');
 assert.throws(()=>matchPlace([['A','MERKEZ'],['B','MERKEZ']],'Merkez','district'));
 assert.throws(()=>matchPlace([['A','BEŞİKTAŞ']],'Kadıköy','district'));
});
function cachedFixture(t){const db=new Store(':memory:');t.after(()=>db.close());return{db,bot:new EokulBot({store:db,api:{safe:async()=>({message_id:1}),stop(){}},config:{concurrency:2}})};}
test('Stale list returns immediately while refresh is still blocked',async t=>{
 const {db,bot}=cachedFixture(t);db.putList('stale',[['old','Eski']]);db.run('UPDATE lists SET updated_at=1 WHERE key=?','stale');
 let resolve;const blocked=new Promise(r=>resolve=r);
 const start=Date.now();const result=await bot.cachedList('stale',()=>blocked,60);
 assert.deepEqual(result,[['old','Eski']]);assert.ok(Date.now()-start<1000);
 resolve([['new','Yeni']]);await Promise.all(bot.tasks);assert.deepEqual(bot.peekList('stale').data,[['new','Yeni']]);
});
test('Repeated fresh list access is served from memory, not SQLite',async t=>{
 const {db,bot}=cachedFixture(t);db.putList('fresh',[['1','Okul']]);
 await bot.cachedList('fresh',async()=>{throw new Error('Network not allowed');},60);
 let reads=0;const old=db.getList.bind(db);db.getList=(...args)=>{reads++;return old(...args);};
 await bot.cachedList('fresh',async()=>[],60);assert.equal(reads,0);
});
test('School payload preserves verified MEB IDs in persistent cache',async t=>{
 const {db,bot}=cachedFixture(t);const value={il:'MEB-P',ilce:'MEB-D',items:[['S','Okul']]};
 assert.deepEqual(await bot.cachedList('schools',async()=>value,86400),value);
 assert.deepEqual(db.getList('schools').data,value);
});
test('All city/district menu labels use Turkish uppercase',()=>{
 for(const [id,name] of provinceOptions()){
  assert.equal(name,name.toLocaleUpperCase('tr-TR'));
  for(const [,district] of districtOptions(id))assert.equal(district,district.toLocaleUpperCase('tr-TR'));
 }
 assert.ok(provinceOptions().some(([,name])=>name==='İSTANBUL (34)'));
 assert.ok(districtOptions('34').some(([,name])=>name==='ŞİŞLİ'));
});
