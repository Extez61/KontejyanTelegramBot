'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {Store}=require('../db');
const {parseProxies,proxyAgent,ProxyPool}=require('../proxies');
const {EokulClient,parseQuota,diff,retry,checkGroup}=require('../eokul');
const {toggleClass,quota,splitText,matchingChanges,Semaphore,norm}=require('../utils');
const {loadConfig}=require('../config');
const axios=require('axios');
function sub(extra={}){return {chat_id:1,okul_id:'S',sinif:'9,10',mode:'both',tur:'22',il:'34',ilce:'1',okul_ad:'Okul',il_ad:'İstanbul',user_id:7,user_name:'Ali',...extra};}
test('SQLite subscription insert, update and deletion',()=>{
  const db=new Store(':memory:');try{db.addSub(sub());db.addSub(sub({mode:'up'}));assert.equal(db.countSubs(1),1);assert.equal(db.listSubs(1)[0].mode,'up');assert.ok(db.hasSub(1,'S','9,10'));db.deleteSub(1,'S','9,10');assert.equal(db.countSubs(1),0);}finally{db.close();}
});
test('Old Python SQLite schema migrates without deleting data',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eokul-')),file=path.join(dir,'old.db');
  const legacy=new DatabaseSync(file);legacy.exec(`CREATE TABLE subs(chat_id INTEGER,okul_id TEXT,sinif TEXT,mode TEXT,tur TEXT,il TEXT,ilce TEXT,okul_ad TEXT,il_ad TEXT,created_at INTEGER,PRIMARY KEY(chat_id,okul_id,sinif)); INSERT INTO subs VALUES(1,'S','9','both','22','34','1','Okul','İstanbul',1)`);legacy.close();
  const db=new Store(file);assert.equal(db.listSubs(1)[0].sinif,'9');assert.equal(db.listSubs(1)[0].user_id,null);db.addSub(sub());assert.equal(db.countSubs(1),2);db.close();const reopened=new Store(file);assert.equal(reopened.countSubs(1),2);reopened.close();fs.rmSync(dir,{recursive:true});
});
test('Snapshots retain changed_at on unchanged check and count failures',()=>{
  const db=new Store(':memory:');db.saveSnap('S',{Genel:{9:2}},true);const snap=db.getSnap('S');db.bumpFail('S');assert.equal(db.getSnap('S').fail_count,1);db.saveSnap('S',{Genel:{9:2}});assert.equal(db.getSnap('S').changed_at,snap.changed_at);assert.equal(db.getSnap('S').fail_count,0);db.close();
});
test('Python-compatible cached list JSON roundtrip',()=>{const db=new Store(':memory:');const data=[['S',{Genel:{9:2}}]];db.putList('quota',data);assert.deepEqual(db.getList('quota').data,data);db.close();});
test('Message IDs are scoped by user and can be forgotten',()=>{const db=new Store(':memory:');db.remember(1,10,7);db.remember(1,11,8);assert.deepEqual(db.messages(1,7),[10]);db.forget(1,[10]);assert.deepEqual(db.messages(1,7),[]);db.close();});
test('Group list deduplicates multiple class subscriptions',()=>{const db=new Store(':memory:');db.addSub(sub());db.addSub(sub({sinif:'all'}));assert.deepEqual(db.groups()[0].schools,[['S','1']]);db.close();});
test('Multi-class selection toggles and sorts',()=>{assert.deepEqual(toggleClass(toggleClass([],'10'),'9'),['9','10']);assert.deepEqual(toggleClass(['9','10'],'9'),['10']);});
test('All is exclusive and a class deselects all',()=>{assert.deepEqual(toggleClass(['9','10'],'all'),['all']);assert.deepEqual(toggleClass(['all'],'9'),['9']);assert.deepEqual(toggleClass(['all'],'all'),[]);});
test('Quota respects selected classes and HTML escaping',()=>{const q=quota({'<Alan>':{9:2,10:3,11:4}},'9,10');assert.ok(q.includes('&lt;Alan&gt;'));assert.ok(q.includes('10. sınıf'));assert.ok(!q.includes('11. sınıf'));});
test('Notification filter respects grades and direction',()=>{const changes=[['Genel','9',1,2],['Genel','10',3,1],['Genel','11',0,1]];assert.equal(matchingChanges(sub(),changes).length,2);assert.equal(matchingChanges(sub({mode:'up'}),changes).length,1);});
test('Long UTF-16 text is split without breaking emoji',()=>{const original='😀'.repeat(5000);const parts=splitText(original);assert.ok(parts.every(p=>p.length<=3800&&!/[\uD800-\uDBFF]$/.test(p)));assert.equal(parts.join(''),original);});
test('Turkish name search normalizes correctly',()=>{assert.equal(norm('İSTANBUL Şişli'),'istanbul sisli');});
test('Semaphore never exceeds configured concurrency',async()=>{const sem=new Semaphore(2);let count=0,max=0;await Promise.all(Array.from({length:8},()=>sem.run(async()=>{max=Math.max(max,++count);await new Promise(r=>setTimeout(r,5));count--;})));assert.equal(max,2);assert.equal(sem.active,0);});
test('Webshare IP:port:user:pass parsing',()=>{assert.deepEqual(parseProxies('192.0.2.1:8080:u:p'),['http://u:p@192.0.2.1:8080']);});
test('Proxy special characters are safely encoded',()=>{assert.deepEqual(parseProxies('192.0.2.1:8080:u name:p@ss:/#%'),['http://u%20name:p%40ss%3A%2F%23%25@192.0.2.1:8080']);});
test('Encoded proxy URL is not double-encoded',()=>{const url='http://u%20name:p%40ss@192.0.2.1:8080';assert.deepEqual(parseProxies(url),[url]);});
test('Pasted HTML and escaped colons are accepted, duplicates removed',()=>{assert.equal(parseProxies('192.0.2.1:8080\\:u\\:p<br/>192.0.2.1:8080:u:p').length,1);});
test('Malformed proxy entries are rejected',()=>{assert.deepEqual(parseProxies('invalid\n192.0.2.1:99999:u:p\nftp://a:80\n192.0.2.1:80:u:'),[]);});
test('HTTP default port and SOCKS protocol work',()=>{assert.equal(parseProxies('192.0.2.1:80:u:p')[0],'http://u:p@192.0.2.1:80');const agent=proxyAgent(parseProxies('192.0.2.1:1080:u:p','socks5')[0]);assert.ok(agent);agent.destroy();});
test('Local proxy file takes precedence over download URL',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-')),file=path.join(dir,'p.txt');fs.writeFileSync(file,'192.0.2.1:8080:u:p');const pool=new ProxyPool({file,url:'https://example.invalid/private'});assert.ok(await pool.pick());pool.markBad(pool.items[0]);assert.equal(await pool.pick(),null);fs.rmSync(dir,{recursive:true});});
test('Concurrent refresh waits for the same proxy load',async t=>{
 const io=require('node:fs/promises');let reads=0;
 t.mock.method(io,'readFile',async()=>{reads++;await new Promise(r=>setTimeout(r,5));return '192.0.2.1:8080:u:p';});
 const pool=new ProxyPool({file:'/not-read-from-disk'});
 const values=await Promise.all([pool.pick(),pool.pick(),pool.pick()]);
 assert.equal(reads,1);assert.ok(values.every(Boolean));
});
test('No direct fallback when proxy pool is empty',async()=>{let made=0;await assert.rejects(retry(async()=>1,{pool:{pick:async()=>null},direct:false,makeClient:()=>{made++;}}));assert.equal(made,0);});
test('Failed proxy is excluded and next one is tried without exposing secrets',async()=>{let picks=0,bad=0;const pool={pick:async()=>`http://u:p@192.0.2.${++picks}:80`,markBad:()=>bad++};let attempts=0;const result=await retry(async()=>{if(++attempts===1)throw new Error('PRIVATE_SECRET');return 2;},{pool,makeClient:()=>({close(){}})});assert.equal(result,2);assert.equal(bad,1);});
test('Proxy errors do not include underlying credentials',async()=>{await assert.rejects(retry(async()=>{throw new Error('PRIVATE_SECRET');},{makeClient:()=>({close(){}})}),e=>!e.message.includes('PRIVATE_SECRET'));});
test('Quota parser and missing-class changes',()=>{assert.deepEqual(parseQuota({tables:[[['9. Sınıf Kontenjan','10. Sınıf Kontenjan'],['3','5']]],messages:[]}),{Genel:{9:3,10:5}});assert.deepEqual(diff({Genel:{9:2}},{Genel:{10:3}}),[['Genel','9',2,0],['Genel','10',0,3]]);});
test('Unknown MEB page is not zero quota',()=>{assert.throws(()=>parseQuota({tables:[],messages:['Bir hata oluştu']}));assert.deepEqual(parseQuota({tables:[],messages:['Kayıt bulunamadı']}),{});});
const FORM=`<form id="Form1"><input name="__VIEWSTATE" value="vs1"><input type="hidden" name="__EVENTVALIDATION" value="ev1"><input type="submit" name="btnGiris"><select id="ddlIl" name="ddlIl"><option value="-1">Seç</option><option value="34" selected>İstanbul</option></select><select id="ddlOkul" name="ddlOkul"><option value="S">Okul</option></select></form>`;
test('ASP.NET hidden state and selected values are preserved',()=>{const c=new EokulClient();c.parse(FORM);assert.equal(c.fields().__VIEWSTATE,'vs1');assert.equal(c.fields().ddlIl,'34');assert.ok(!Object.hasOwn(c.fields(),'btnGiris'));assert.deepEqual(c.options('ddlIl'),[['34','İstanbul']]);c.close();});
test('MEB cookies and per-request timeout are preserved without environment proxy',async t=>{
 let calls=0;t.mock.method(axios,'request',async config=>{calls++;assert.equal(config.proxy,false);assert.ok(config.signal);if(calls===2)assert.ok(config.headers.Cookie.includes('SESSION=abc'));return {status:200,headers:{'set-cookie':['SESSION=abc; Path=/; Secure'],'content-type':'text/html;charset=utf-8'},data:Buffer.from(FORM)};});
 const c=new EokulClient();await c.request('GET');await c.request('POST',c.fields());assert.equal(calls,2);c.close();
});
test('Same district schools reuse one ASP.NET session',async()=>{let made=0,closed=0,types=0;const result=await checkGroup('22','34',[['A','1'],['B','1']],{makeClient:()=>{made++;return{selectType:async()=>types++,selectProvince:async()=>{},selectDistrict:async()=>{},hasOption:()=>true,listSchool:async()=>({tables:[[['9. Sınıf Kontenjan'],['2']]],messages:[]}),close:()=>closed++};}});assert.equal(made,1);assert.equal(types,1);assert.equal(closed,1);assert.equal(result.B.Genel[9],2);});
test('Expired query budget returns unknown without requests',async()=>{let made=0;const result=await checkGroup('22','34',[['A','1']],{deadline:Date.now()-1,makeClient:()=>made++});assert.equal(result.A,null);assert.equal(made,0);});
test('Configuration keeps existing interval and SQLite path',()=>{const c=loadConfig('/tmp',{BOT_TOKEN:'123:test',USE_PROXY:'0',CHECK_INTERVAL:'60',DB_PATH:'old.db'});assert.equal(c.interval,60);assert.equal(c.dbFile,'/tmp/old.db');assert.equal(c.direct,false);});
test('Invalid interval and missing token fail before polling',()=>{assert.throws(()=>loadConfig('/tmp',{BOT_TOKEN:'123:test',USE_PROXY:'0',CHECK_INTERVAL:'oops'}));assert.throws(()=>loadConfig('/tmp',{USE_PROXY:'0'}));});
test('Database close is safe when shutdown paths meet',()=>{const db=new Store(':memory:');db.close();db.close();});
