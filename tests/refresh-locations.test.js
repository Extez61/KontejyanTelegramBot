'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {SOURCE,validateOptions,collectLocations,saveLocations}=require('../refresh-locations');
function fixture({incomplete=false,failOnce=false,alwaysFail=false}={}){
 let clients=0,closed=0,failed=false;
 return{get closed(){return closed;},get clients(){return clients;},config:{makeClient:()=>{
  clients++;let province='';return{
   async selectType(type){assert.equal(type,'22');},
   async selectProvince(id){province=id;if(alwaysFail||(failOnce&&!failed)){failed=true;throw new Error('fixture MEB failed');}},
   options(id){if(id==='ddlIl')return [...Array.from({length:incomplete?80:81},(_,i)=>[String(i+1),'İL '+(i+1)]),['999','BAKANLIK']];return [['MEB-D1','merkez'],['MEB-D2','ilçe']];},
   close(){closed++;}
  };
 }}};
}
test('Collector reads 81 provinces and districts from MEB forms, excluding BAKANLIK',async()=>{
 const f=fixture(),data=await collectLocations(f.config);assert.equal(data.source,SOURCE);assert.equal(data.version,2);assert.equal(data.provinces.length,81);assert.ok(!data.provinces.some(p=>p.id==='999'));assert.deepEqual(data.provinces[0].districts,[{id:'MEB-D1',name:'MERKEZ'},{id:'MEB-D2',name:'İLÇE'}]);assert.equal(f.clients,1);assert.equal(f.closed,1);
});
test('Collector rejects incomplete province list',async()=>{
 const f=fixture({incomplete:true});await assert.rejects(collectLocations(f.config),/81 il/);assert.equal(f.closed,1);
});
test('Collector reopens independent MEB session after a failed province POST',async()=>{
 const f=fixture({failOnce:true}),data=await collectLocations(f.config);assert.equal(data.provinces.length,81);assert.equal(f.clients,2);assert.equal(f.closed,2);
});
test('Failed download leaves existing dataset unchanged',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meb-data-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'locations.json');await fs.writeFile(file,'old-data');const f=fixture({alwaysFail:true});await assert.rejects((async()=>saveLocations(await collectLocations(f.config),file))());assert.equal(await fs.readFile(file,'utf8'),'old-data');
});
test('Successful dataset save replaces file atomically with no temporary remainder',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meb-data-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'locations.json'),data={source:SOURCE,provinces:[]};await fs.writeFile(file,'old-data');await saveLocations(data,file);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),data);assert.deepEqual(await fs.readdir(dir),['locations.json']);
});
test('Empty or duplicate MEB options cannot replace a valid dataset',()=>{
 assert.throws(()=>validateOptions([],'İlçe'),/boş/);assert.throws(()=>validateOptions([['1','A'],['1','B']],'İlçe'),/geçersiz/);
});
