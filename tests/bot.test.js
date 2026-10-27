'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../db');
const {EokulBot}=require('../bot');
const {diff}=require('../eokul');
const {districtOptions}=require('../locations');
const DISTRICT=districtOptions('34').find(([,name])=>name==='KADIKÖY')[0];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t) {
 const db=new Store(':memory:');t.after(()=>db.close());let id=100;
 const calls=[];const api={calls,stop(){},async safe(method,params){calls.push({method,params});return{message_id:++id,chat:{id:1,type:'private'}};}};
 const config={concurrency:2,maxSubs:15,interval:120,groupTimeout:90,listTimeout:120,direct:false,directFirst:false};
 const source={TYPES:{22:'Anadolu Liseleri'},diff,
   async fetchOptions(tur,il,ilce){return il==null?[['34','İstanbul']]:ilce==null?[['1','Kadıköy']]:[['S','Örnek Lisesi']];},
   async fetchSchoolOptions(){return {il:'34',ilce:'1',items:[['S','Örnek Lisesi']]};},
   async checkGroup(tur,il,schools){return Object.fromEntries(schools.map(([id])=>[id,{Genel:{9:2,10:3,11:4}}]));}};
 const bot=new EokulBot({store:db,api,config,source});
 const user={id:7,first_name:'Ali & Veli'},chat={id:1,type:'private'};
 const msg=text=>({message:{message_id:++id,chat,from:user,text}});
 const state=()=>bot.sessions.get('1:7');
 const click=async(data,menu=state()?.menu)=>bot.dispatch({callback_query:{id:'q'+id,from:user,data,message:{message_id:menu,chat}}});
 const sent=()=>calls.filter(c=>c.method==='sendMessage');
 return{db,api,bot,config,source,msg,state,click,sent};
}
test('Full follow flow supports two classes, cleanup, and immediate start',async t=>{
 const f=fixture(t);let checks=0;f.bot.check=async()=>{checks++;};await f.bot.dispatch(f.msg('/takip_et'));
 for(const data of ['t:22','x:il:34',`x:ilce:${DISTRICT}`,'x:okul:S','s:9','s:10','s:done','m:both'])await f.click(data);
 await Promise.all(f.bot.tasks);assert.equal(f.db.listSubs(1)[0].sinif,'9,10');assert.equal(f.db.listSubs(1)[0].user_id,7);assert.ok(f.sent().at(-1).params.text.includes('Takip başladı'));assert.ok(f.api.calls.some(c=>c.method==='deleteMessages'));assert.equal(f.db.messages(1,7).length,1);assert.equal(checks,1);
});
test('Class selection cannot continue while empty',async t=>{const f=fixture(t);await f.bot.dispatch(f.msg('/kontejyanlistesi'));await f.click('s:done');assert.equal(f.state().stage,'class');assert.equal(f.state().f.sinif,undefined);});
test('Stale menu callback does not change current selection',async t=>{const f=fixture(t);await f.bot.dispatch(f.msg('/kontejyanlistesi'));const old=f.state().menu;await f.bot.dispatch(f.msg('/kontejyanlistesi'));await f.click('s:9',old);assert.deepEqual(f.state().f.selected,[]);});
test('District flow starts with class and lists every school without school selection',async t=>{const f=fixture(t);await f.bot.dispatch(f.msg('/kontejyanlistesi'));assert.equal(f.state().stage,'class');for(const data of ['s:all','s:done','t:22','x:il:34',`x:ilce:${DISTRICT}`])await f.click(data);await Promise.all(f.bot.tasks);const text=f.sent().at(-1).params.text;assert.ok(text.includes('Örnek Lisesi'));assert.ok(text.includes('11. sınıf'));assert.equal(f.db.countSubs(1),0);});
test('Province and district menus make zero MEB requests',async t=>{
 const f=fixture(t);let count=0;
 f.source.fetchOptions=f.source.fetchSchoolOptions=async()=>{count++;throw new Error('Network must not be called');};
 await f.bot.dispatch(f.msg('/takip_et'));await f.click('t:22');
 assert.equal(f.state().opts.all.length,81);
 await f.click('x:il:34');assert.ok(f.state().opts.all.length>20);assert.equal(count,0);
 const edits=f.api.calls.filter(c=>c.method==='editMessageText');
 assert.equal(edits.length,2);assert.ok(edits.every(c=>!c.params.text.includes('alınıyor')));
});
test('Duplicate list requests use one in-flight cache query',async t=>{const f=fixture(t);let count=0;const fetch=async()=>{count++;await pause(5);return[['1','A']];};const [a,b]=await Promise.all([f.bot.cachedList('key',fetch,60),f.bot.cachedList('key',fetch,60)]);assert.deepEqual(a,b);assert.equal(count,1);});
const details={tur:'22',il:'34',ilce:'1',il_ad:'İstanbul',ilce_ad:'Kadıköy',sinif:'9,10'};
test('District cache does not overwrite tracked snapshots',async t=>{const f=fixture(t);f.db.saveSnap('S',{Genel:{9:1}});let count=0;const original=f.source.checkGroup;f.source.checkGroup=async(...args)=>{count++;return original(...args);};await f.bot.districtReport(1,7,details,[['S','Okul']]);await f.bot.districtReport(1,7,details,[['S','Okul']]);assert.equal(count,1);assert.equal(f.db.getSnap('S').data.Genel[9],1);assert.ok(f.sent().at(-1).params.text.includes('Önbellek'));});
test('Partial long district report is split, not cached, and unknown is not zero',async t=>{const f=fixture(t);const items=Array.from({length:90},(_,i)=>['S'+i,'OKUL-'+i+' Uzun isim'.repeat(12)]);f.source.checkGroup=async()=>Object.fromEntries(items.map(([id],i)=>[id,i===0?null:{Genel:{9:2,10:3}}]));await f.bot.districtReport(1,7,details,items);const messages=f.sent().map(c=>c.params.text),text=messages.join('\n');assert.ok(messages.length>1);assert.ok(messages.every(m=>m.length<=4096));for(const [,label] of items)assert.ok(text.includes(label));assert.ok(text.includes('sıfır kontenjan anlamına gelmez'));assert.equal(f.db.getList('quota:22:34:1'),null);});
function add(db,extra={}){db.addSub({chat_id:1,okul_id:'S',sinif:'9,10',mode:'both',tur:'22',il:'34',ilce:'1',okul_ad:'Okul',il_ad:'İstanbul',user_id:7,user_name:'Ali & Veli',...extra});}
test('Change notification mentions owner and filters selected classes',async t=>{const f=fixture(t);add(f.db);await f.bot.notify('S',[['Genel','9',0,2],['Genel','10',3,1],['Genel','11',0,8]]);const text=f.sent()[0].params.text;assert.ok(text.includes('tg://user?id=7'));assert.ok(text.includes('Ali &amp; Veli'));assert.ok(text.includes('9. sınıf'));assert.ok(!text.includes('11. sınıf'));});
test('Legacy private subscription mentions chat owner',async t=>{const f=fixture(t);add(f.db,{user_id:null,user_name:null});await f.bot.notify('S',[['Genel','9',0,1]]);assert.ok(f.sent()[0].params.text.includes('tg://user?id=1'));});
test('First snapshot is baseline, later change sends notification',async t=>{const f=fixture(t);add(f.db);await f.bot.check();assert.equal(f.sent().length,0);f.source.checkGroup=async()=>({S:{Genel:{9:5,10:3,11:4}}});await f.bot.check();assert.equal(f.sent().length,1);assert.equal(f.db.getSnap('S').data.Genel[9],5);});
test('Failed query leaves old quota unchanged and increases failure count',async t=>{const f=fixture(t);add(f.db);f.db.saveSnap('S',{Genel:{9:2}});f.source.checkGroup=async()=>({S:null});await f.bot.check();assert.equal(f.db.getSnap('S').data.Genel[9],2);assert.equal(f.db.getSnap('S').fail_count,1);assert.equal(f.sent().length,0);});
test('Fast group notifies before slow group completes',async t=>{const f=fixture(t);add(f.db);add(f.db,{okul_id:'Slow',il:'35'});f.db.saveSnap('S',{Genel:{9:0}});f.db.saveSnap('Slow',{Genel:{9:0}});let slowDone=false,fastBefore=false;f.source.checkGroup=async(_t,il,schools)=>{if(il==='35'){await pause(30);slowDone=true;}return Object.fromEntries(schools.map(([id])=>[id,{Genel:{9:1}}]));};f.bot.notify=async(id)=>{if(id==='S')fastBefore=!slowDone;};await f.bot.check();assert.ok(fastBefore);});
test('Overlapping checks are skipped',async t=>{const f=fixture(t);add(f.db);let count=0;f.source.checkGroup=async()=>{count++;await pause(10);return{S:{Genel:{9:1}}};};await Promise.all([f.bot.check(),f.bot.check()]);assert.equal(count,1);});
test('Groups are never cleaned wholesale',async t=>{const f=fixture(t);f.db.remember(-100,5,7);await f.bot.cleanup({chat:{id:-100,type:'supergroup'},user:{id:7}});assert.ok(!f.api.calls.some(c=>c.method==='deleteMessages'));});
test('Status merges multi-class subscriptions',async t=>{const f=fixture(t);add(f.db);f.db.saveSnap('S',{Genel:{9:1,10:2,11:8}});await f.bot.dispatch(f.msg('/durum'));const text=f.sent().at(-1).params.text;assert.ok(text.includes('10. sınıf'));assert.ok(!text.includes('11. sınıf'));});
test('Deleting a multi-class follow removes the correct row',async t=>{const f=fixture(t);add(f.db);await f.bot.dispatch(f.msg('/takiplerim'));await f.click('d:S:9,10');assert.equal(f.db.countSubs(1),0);});
test('Text search produces new active menu',async t=>{const f=fixture(t);await f.bot.dispatch(f.msg('/takip_et'));await f.click('t:22');const old=f.state().menu;await f.bot.dispatch(f.msg('istan'));assert.notEqual(f.state().menu,old);assert.equal(f.state().opts.items.length,1);});
test('Forbidden send removes abandoned chat subscriptions',async t=>{const f=fixture(t);add(f.db);f.api.safe=async()=>{const e=new Error('Forbidden');e.code=403;throw e;};await f.bot.send(1,7,'Test');assert.equal(f.db.countSubs(1),0);});
test('Shutdown shares one promise and waits for active tasks',async t=>{const f=fixture(t);let completed=false;f.bot.background(async()=>{await pause(10);completed=true;});const a=f.bot.stop(),b=f.bot.stop();assert.equal(a,b);await a;assert.ok(completed);assert.ok(f.bot.stopping);});
test('/start explicitly resets the menu and preserves subscriptions',async t=>{
 const f=fixture(t);add(f.db);await f.bot.dispatch(f.msg('/takip_et'));const old=f.state().menu;
 await f.bot.dispatch(f.msg('/start'));assert.equal(f.state().action,undefined);
 const text=f.sent().at(-1).params.text;assert.ok(text.includes('/start'));assert.ok(text.includes('/clear'));
 assert.equal(f.db.countSubs(1),1);await f.click('t:22',old);assert.equal(f.state().opts,undefined);
 assert.equal(f.api.calls.filter(c=>c.method==='deleteMessages').length,0);
});
test('/clear batches known IDs by 100, max two requests, and keeps subscriptions',async t=>{
 const f=fixture(t);add(f.db);for(let i=0;i<250;i++)f.db.remember(1,5000+i,7);
 let active=0,max=0;const original=f.api.safe.bind(f.api);
 f.api.safe=async(method,params)=>{if(method==='deleteMessages'){max=Math.max(max,++active);try{await pause(5);return await original(method,params);}finally{active--;}}return original(method,params);};
 const update=f.msg('/clear');await f.bot.dispatch(update);
 const batches=f.api.calls.filter(c=>c.method==='deleteMessages').map(c=>c.params.message_ids);
 assert.deepEqual(batches.map(b=>b.length),[100,100,51]);assert.equal(max,2);
 assert.deepEqual(batches.flat().sort((a,b)=>a-b),[update.message.message_id,...Array.from({length:250},(_,i)=>5000+i)].sort((a,b)=>a-b));
 assert.equal(f.db.countSubs(1),1);assert.equal(f.db.messages(1,7).length,0);
 assert.equal(f.sent().length,0);
});
test('/clear in group does not delete other messages',async t=>{
 const f=fixture(t),update=f.msg('/clear');update.message.chat={id:-100,type:'supergroup'};
 await f.bot.dispatch(update);assert.ok(!f.api.calls.some(c=>c.method==='deleteMessages'));
 assert.ok(f.sent().at(-1).params.text.includes('özel sohbette'));
});
test('/clear reports partial failure and does not forget failed IDs',async t=>{
 const f=fixture(t);f.db.remember(1,500,7);const original=f.api.safe.bind(f.api);
 f.api.safe=async(method,params)=>{if(method==='deleteMessages'){const e=new Error('not allowed');e.code=400;throw e;}return original(method,params);};
 await f.bot.dispatch(f.msg('/clear'));assert.ok(f.db.messages(1,7).includes(500));assert.ok(f.sent().at(-1).params.text.includes('silinemedi'));
});
test('/clear bypasses blocked school query and prevents stale menu resurrection',async t=>{
 const f=fixture(t);let finish,enter;const started=new Promise(r=>enter=r);
 f.source.fetchSchoolOptions=()=>{enter();return new Promise(r=>finish=r);};
 await f.bot.dispatch(f.msg('/takip_et'));await f.click('t:22');await f.click('x:il:34');
 const old=f.click(`x:ilce:${DISTRICT}`);await started;
 const clearing=f.bot.dispatch(f.msg('/clear'));
 await Promise.race([clearing,pause(1000).then(()=>{throw new Error('clear blocked on MEB');})]);
 const edits=f.api.calls.filter(c=>c.method==='editMessageText').length;
 finish({il:'34',ilce:'1',items:[['S','Old result']]});await old;
 assert.equal(f.api.calls.filter(c=>c.method==='editMessageText').length,edits);
 assert.equal(f.state().opts,undefined);assert.equal(f.db.messages(1,7).length,0);
});
test('/start bypasses blocked school query without deleting history',async t=>{
 const f=fixture(t);let finish,enter;const started=new Promise(r=>enter=r);
 f.source.fetchSchoolOptions=()=>{enter();return new Promise(r=>finish=r);};
 await f.bot.dispatch(f.msg('/takip_et'));await f.click('t:22');await f.click('x:il:34');
 const old=f.click(`x:ilce:${DISTRICT}`);await started;await f.bot.dispatch(f.msg('/start'));
 finish({il:'34',ilce:'1',items:[['S','Old result']]});await old;
 assert.ok(f.sent().at(-1).params.text.includes('/clear'));
 assert.ok(!f.api.calls.some(c=>c.method==='deleteMessages'));assert.equal(f.state().opts,undefined);
});
test('District report already fetching cannot repopulate cleared chat',async t=>{
 const f=fixture(t);let finish,enter;const started=new Promise(r=>enter=r);
 f.source.checkGroup=()=>{enter();return new Promise(r=>finish=r);};
 await f.bot.dispatch(f.msg('/kontejyanlistesi'));
 for(const data of ['s:all','s:done','t:22','x:il:34',`x:ilce:${DISTRICT}`])await f.click(data);
 await started;await f.bot.dispatch(f.msg('/clear'));
 const messages=f.sent().length;finish({S:{Genel:{9:1}}});await Promise.all(f.bot.tasks);
 assert.equal(f.sent().length,messages);assert.equal(f.db.messages(1,7).length,0);
});
test('Late outgoing reply is deleted after concurrent /clear',async t=>{
 const f=fixture(t);let finish,enter;const started=new Promise(r=>enter=r),original=f.api.safe.bind(f.api);let block=true;
 f.api.safe=async(method,params)=>{if(method==='sendMessage'&&block){block=false;enter();return new Promise(r=>finish=r);}return original(method,params);};
 const old=f.bot.dispatch(f.msg('/yardim'));await started;await f.bot.dispatch(f.msg('/clear'));
 finish({message_id:9000});await old;
 assert.ok(f.api.calls.some(c=>c.method==='deleteMessages'&&c.params.message_ids.includes(9000)));
 assert.ok(!f.db.messages(1,7).includes(9000));
});
test('Province search accepts 34, 06, and single-digit plate 6',async t=>{
 const f=fixture(t);await f.bot.dispatch(f.msg('/takip_et'));await f.click('t:22');
 await f.bot.dispatch(f.msg('34'));assert.deepEqual(f.state().opts.items,[['34','İSTANBUL (34)']]);
 await f.bot.dispatch(f.msg('06'));assert.deepEqual(f.state().opts.items,[['6','ANKARA (06)']]);
 await f.bot.dispatch(f.msg('6'));assert.deepEqual(f.state().opts.items,[['6','ANKARA (06)']]);
 await f.bot.dispatch(f.msg('istan'));assert.equal(f.state().opts.items[0][0],'34');
});
test('School query has reserved slot while background check slot is busy',async t=>{
 const f=fixture(t);let release;const busy=f.bot.sem.run(()=>new Promise(r=>release=r));
 const result=await f.bot.cachedList('interactive',async()=>[['S','Okul']],60);
 assert.deepEqual(result,[['S','Okul']]);release();await busy;
});
test('Selecting province starts preparation without delaying local district menu',async t=>{
 const f=fixture(t);let finish,started=0;f.bot.schoolDirectory={warm:()=>{started++;return new Promise(r=>finish=r);},close(){}};
 await f.bot.dispatch(f.msg('/takip_et'));await f.click('t:22');await f.click('x:il:34');
 assert.equal(f.state().opts.kind,'ilce');assert.equal(started,1);finish();await Promise.all(f.bot.tasks);
});
test('Blocked loading-message edit does not postpone actual school fetch',async t=>{
 const f=fixture(t);await f.bot.dispatch(f.msg('/takip_et'));await f.click('t:22');await f.click('x:il:34');
 let finish,entered;const called=new Promise(r=>entered=r),original=f.api.safe.bind(f.api);
 f.api.safe=async(method,params)=>{if(method==='editMessageText'&&params.text.includes('hazırlanıyor'))return new Promise(r=>finish=r);return original(method,params);};
 f.source.fetchSchoolOptions=async()=>{entered();return{il:'34',ilce:'1',items:[['S','Okul']]};};
 const selecting=f.click(`x:ilce:${DISTRICT}`);await called;finish({});await selecting;assert.equal(f.state().opts.kind,'okul');
});
async function chooseFollow(f,grades=['9','10'],mode='both'){
 await f.bot.dispatch(f.msg('/takip_et'));
 for(const data of ['t:22','x:il:34',`x:ilce:${DISTRICT}`,'x:okul:S',...grades.map(g=>'s:'+g),'s:done','m:'+mode])await f.click(data);
 await Promise.all(f.bot.tasks);
}
test('Duplicate follow shows Zaten ekli and starts no extra MEB check',async t=>{
 const f=fixture(t);add(f.db);let checks=0;f.bot.check=async()=>{checks++;};
 await chooseFollow(f);assert.ok(f.sent().at(-1).params.text.includes('Zaten ekli'));assert.equal(f.db.countSubs(1),1);assert.equal(checks,0);
});
test('Changing rise-only to both shows Güncellendi with one follow',async t=>{
 const f=fixture(t);add(f.db,{mode:'up'});f.bot.check=async()=>{};
 await chooseFollow(f,['9','10'],'both');const text=f.sent().at(-1).params.text;
 assert.ok(text.includes('Güncellendi'));assert.ok(!text.includes('Takip başladı'));assert.equal(f.db.countSubs(1),1);assert.equal(f.db.listSubs(1)[0].mode,'both');
});
test('Changing selected classes replaces old follow and shows Güncellendi',async t=>{
 const f=fixture(t);add(f.db);f.bot.check=async()=>{};
 await chooseFollow(f,['11'],'down');assert.ok(f.sent().at(-1).params.text.includes('Güncellendi'));assert.equal(f.db.countSubs(1),1);assert.equal(f.db.listSubs(1)[0].sinif,'11');assert.equal(f.db.listSubs(1)[0].mode,'down');
});
test('Preference updates still work at follow limit and preserve baseline',async t=>{
 const f=fixture(t);f.config.maxSubs=1;add(f.db);f.db.saveSnap('S',{Genel:{9:2}},true);const baseline=f.db.getSnap('S');f.bot.check=async()=>{};
 await chooseFollow(f,['all'],'up');assert.ok(f.sent().at(-1).params.text.includes('Güncellendi'));assert.deepEqual(f.db.getSnap('S'),baseline);assert.equal(f.db.countSubs(1),1);
});
