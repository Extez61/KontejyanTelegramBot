'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {firstSuccessful,SchoolDirectory,EokulClient}=require('../eokul');
const {ProxyPool}=require('../proxies');
const axios=require('axios');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('Fast primary avoids starting duplicate request',async()=>{
 let backup=0,cancelled=0;
 const value=await firstSuccessful([async c=>{c.onCancel(()=>cancelled++);return'primary';},async()=>{backup++;return'backup';}],{delay:10});
 await wait(15);assert.equal(value,'primary');assert.equal(backup,0);assert.equal(cancelled,0);
});
test('Slow primary is cancelled when backup succeeds',async()=>{
 let cancelled=0;
 const value=await firstSuccessful([c=>{c.onCancel(()=>cancelled++);return new Promise(()=>{});},async()=> 'backup'],{delay:3});
 assert.equal(value,'backup');assert.equal(cancelled,1);
});
test('Primary failure launches fallback immediately rather than waiting hedge timer',async()=>{
 let called=false;const value=await firstSuccessful([async()=>{throw new Error('SECRET');},async()=>{called=true;return'ok';}],{delay:10000});assert.equal(value,'ok');assert.ok(called);
});
test('Backup failure does not cancel still-running primary',async()=>{
 let cancelled=false;const value=await firstSuccessful([async c=>{c.onCancel(()=>cancelled=true);await wait(12);return'primary';},async()=>{throw new Error('failed');}],{delay:2});assert.equal(value,'primary');assert.equal(cancelled,false);
});
test('Both failures expose neither credentials nor underlying error',async()=>{
 await assert.rejects(firstSuccessful([async()=>{throw new Error('PASSWORD1');},async()=>{throw new Error('PASSWORD2');}],{delay:1}),e=>!e.message.includes('PASSWORD'));
});
test('Abort cancels both started contenders',async()=>{
 const abort=new AbortController();let n=0,enter;const started=new Promise(r=>enter=r);
 const job=c=>{c.onCancel(()=>n++);return new Promise(()=>{});};
 let launches=0;const wrapped=c=>{launches++;if(launches===2)enter();return job(c);};
 const pending=firstSuccessful([wrapped,wrapped],{delay:1,signal:abort.signal});const rejected=assert.rejects(pending);await started;abort.abort();await rejected;assert.equal(n,2);
});
test('Deadline cancels outstanding requests',async()=>{
 let cancelled=0;const job=c=>{c.onCancel(()=>cancelled++);return new Promise(()=>{});};
 await assert.rejects(firstSuccessful([job,job],{delay:1,deadline:Date.now()+20}));assert.equal(cancelled,2);
});
test('No more than two contenders are launched',async()=>{
 let third=0;await assert.rejects(firstSuccessful([async()=>{throw new Error();},async()=>{throw new Error();},async()=>third++],{delay:1}));assert.equal(third,0);
});
test('Proxy selection exclusion guarantees a different address',async()=>{
 const pool=new ProxyPool();pool.nextRefresh=Infinity;pool.items=['http://u:p@192.0.2.1:80','http://u:p@192.0.2.2:80'];
 const first=pool.items[0];assert.equal(await pool.pick([first]),pool.items[1]);assert.equal(await pool.pick(pool.items),null);
});
test('Closing real client aborts an in-flight HTTP request, not just agent sockets',async t=>{
 let enter;const entered=new Promise(r=>enter=r);
 t.mock.method(axios,'request',config=>new Promise((resolve,reject)=>{enter();config.signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true});}));
 const client=new EokulClient();const pending=client.request('GET');const rejected=assert.rejects(pending);await entered;client.close();await rejected;assert.ok(client.controller.signal.aborted);
});
const P1='http://u:p@192.0.2.1:80',P2='http://u:p@192.0.2.2:80';
function poolFixture({warmSlow=false,districtSlow=false,failAll=false,single=false}={}){
 const bad=new Set(),clients=[],counts={active:0,max:0};
 const pool={async pick(excluded=[]){return (single?[P1]:[P1,P2]).find(p=>!bad.has(p)&&!excluded.includes(p))||null;},markBad:p=>bad.add(p)};
 function makeClient(proxy){
  const controller=new AbortController();let district='';
  const client={proxy,controller,closed:false,
   async step(ms){
    if(controller.signal.aborted)throw new Error('closed');counts.max=Math.max(counts.max,++counts.active);
    try{await new Promise((resolve,reject)=>{const aborted=()=>{clearTimeout(timer);reject(new Error('closed'));};const timer=setTimeout(()=>{controller.signal.removeEventListener('abort',aborted);resolve();},ms);controller.signal.addEventListener('abort',aborted,{once:true});});}finally{counts.active--;}
   },
   async selectType(){await this.step(warmSlow&&proxy===P1?100:1);if(failAll)throw new Error('PRIVATE_CREDENTIALS');},
   async selectProvince(){await this.step(1);},
   async selectDistrict(id){district=id;await this.step(districtSlow&&proxy===P1?100:1);},
   options:id=>id==='ddlIl'?[['P','İSTANBUL']]:id==='ddlIlce'?[['D1','KADIKÖY'],['D2','BEŞİKTAŞ']]:[[`${proxy===P1?'FIRST':'SECOND'}-${district}`,'Okul']],
   close(){if(this.closed)return;this.closed=true;controller.abort();}
  };clients.push(client);return client;
 }
 const directory=new SchoolDirectory({pool,direct:false,makeClient},{width:2,hedgeMs:4});
 return{directory,pool,clients,bad,counts};
}
test('Slow warm proxy loses to independent faster proxy with separate session',async()=>{
 const f=poolFixture({warmSlow:true});const ready=await f.directory.warm('22','İstanbul (34)');
 assert.equal(ready.client.proxy,P2);assert.equal(f.clients.length,2);assert.ok(f.clients[0].closed);assert.ok(!f.bad.has(P1));assert.ok(f.counts.max<=2);f.directory.close();
});
test('Prepared slow district POST loses to a fresh independent proxy chain',async()=>{
 const f=poolFixture({districtSlow:true});await f.directory.warm('22','İstanbul');assert.equal(f.clients.length,1);
 const result=await f.directory.list('22','İstanbul','Kadıköy');assert.equal(result.items[0][0],'SECOND-D1');
 assert.ok(f.clients[0].closed);assert.ok(!f.bad.has(P1));assert.ok(f.counts.max<=2);
 const next=await f.directory.list('22','İstanbul','Beşiktaş');assert.equal(next.items[0][0],'SECOND-D2');assert.equal(f.clients.length,2);f.directory.close();
});
test('Fast warm and fast district query do not create extra client',async()=>{
 const f=poolFixture();f.directory.hedgeMs=1000;await f.directory.warm('22','İstanbul');await f.directory.list('22','İstanbul','Kadıköy');assert.equal(f.clients.length,1);f.directory.close();
});
test('Single proxy is never raced against itself',async()=>{
 const f=poolFixture({single:true,districtSlow:true});const result=await f.directory.list('22','İstanbul','Kadıköy');assert.equal(result.items[0][0],'FIRST-D1');assert.equal(f.clients.length,1);f.directory.close();
});
test('Both failed proxies cannot cause unauthorized direct connection',async()=>{
 const f=poolFixture({failAll:true});await assert.rejects(f.directory.warm('22','İstanbul'));assert.ok(f.clients.every(c=>c.proxy));assert.equal(f.clients.length,2);f.directory.close();
});
test('Explicit one-slot mode disables parallel clients',async()=>{
 const f=poolFixture({districtSlow:true});f.directory.width=1;await f.directory.list('22','İstanbul','Kadıköy');assert.equal(f.clients.length,1);assert.equal(f.counts.max,1);f.directory.close();
});
test('Stopping a directory cancels both running warm proxy requests',async()=>{
 const f=poolFixture({warmSlow:true});
 // Keep both contenders slow enough to be in progress when close is invoked.
 const original=f.directory.makeClient.bind(f.directory);
 f.directory.makeClient=(...args)=>{const c=original(...args);c.selectType=()=>c.step(100);return c;};
 const pending=f.directory.warm('22','İstanbul');const rejected=assert.rejects(pending);while(f.clients.length<2)await wait(1);f.directory.close();await rejected;assert.ok(f.clients.every(c=>c.closed));
});
test('HTTP and SOCKS agents reuse one session connection instead of rebuilding every POST',()=>{
 const {proxyAgent}=require('../proxies');
 for(const url of [P1,'socks5://u:p@192.0.2.1:1080']){
  const agent=proxyAgent(url);assert.equal(agent.keepAlive,true);assert.equal(agent.maxSockets,1);assert.equal(agent.maxFreeSockets,1);agent.destroy();
 }
});
test('Default four-slot configuration reserves two for foreground racing and two for tracking',()=>{
 const {Store}=require('../db'),{EokulBot}=require('../bot');let width;
 const db=new Store(':memory:');
 const source={SchoolDirectory:class{constructor(_config,options){width=options.width;}},TYPES:{22:'Anadolu'}};
 const bot=new EokulBot({store:db,api:{},source,config:{concurrency:4}});
 assert.equal(width,2);assert.equal(bot.sem.max,2);assert.equal(bot.menuSem.max,1);db.close();
});
