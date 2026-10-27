'use strict';
const log=require('./logger');
if(Number(process.versions.node.split('.')[0])<24) {
  log.error('startup.node_version',log.wrap('Node.js 24 veya üzeri gerekli',undefined,{code:'NODE_VERSION'}),{node_version:process.version});process.exit(1);
}
const path=require('node:path');
const {Store,now}=require('./db');
const {ProxyPool}=require('./proxies');
const sourceDefault=require('./eokul');
const {provinceOptions,districtOptions}=require('./locations');
const {TelegramAPI}=require('./telegram');
const {loadConfig}=require('./config');
const {sleep,esc,norm,cleanSchool,classText,modeText,timeText,quota,splitText,Semaphore,toggleClass,matchingChanges}=require('./utils');
const BUTTON=(text,callback_data)=>({text,callback_data});
const CANCEL=[BUTTON('✖️ İptal','cancel')];
const ERR='Şu an MEB sitesine ulaşamadım. Birkaç dakika sonra tekrar dene.';
const LISTS={il:{size:24,cols:3,title:'📍 İl seç. İl adı veya plaka (34, 06) yazarak arayabilirsin.'},
  ilce:{size:20,cols:2,title:'🏘 İlçe seç. İlçe adını yazarak arayabilirsin.'},
  okul:{size:8,cols:1,title:'🏫 Okul seç. Okul adını yazarak arayabilirsin.'}};
function classKeyboard(selected=[]) {
  const rows=[['9','10'],['11','12']].map(pair=>pair.map(c=>BUTTON(`${selected.includes(c)?'✅ ':''}${c}. sınıf`,`s:${c}`)));
  return [...rows,[BUTTON(`${selected.includes('all')?'✅ ':''}Hepsi`,'s:all')],[BUTTON('Devam ➡️','s:done')],CANCEL];
}
function optionKeyboard(kind,items,page=0) {
  const cfg=LISTS[kind],pages=Math.max(1,Math.ceil(items.length/cfg.size));page=Math.max(0,Math.min(page,pages-1));
  const rows=[];let row=[];
  for(const [v,label] of items.slice(page*cfg.size,(page+1)*cfg.size)) {
    row.push(BUTTON((kind==='okul'?cleanSchool(label):label).slice(0,38),`x:${kind}:${v}`));
    if(row.length===cfg.cols){rows.push(row);row=[];}
  }
  if(row.length)rows.push(row);
  if(pages>1){const nav=[];if(page>0)nav.push(BUTTON('◀️',`p:${page-1}`));nav.push(BUTTON(`${page+1}/${pages}`,'noop'));if(page<pages-1)nav.push(BUTTON('▶️',`p:${page+1}`));rows.push(nav);}
  return [...rows,CANCEL];
}
class EokulBot {
  constructor({store,api,config,pool=null,source=sourceDefault}) {
    Object.assign(this,{db:store,api,config,pool,source});
    this.sessions=new Map();this.epochs=new Map();this.priorityQueues=new Map();this.userQueues=new Map();this.tasks=new Set();this.districtTasks=new Map();
    this.memoryLists=new Map();this.listFlights=new Map();
    // En az bir etkileşimli sorgu yuvası ayır; uzun takip grupları menüleri bekletmesin.
    const slots=Math.max(1,Number(config.concurrency)||1);
    const schoolSlots=slots>=3?2:1;
    this.sem=new Semaphore(Math.max(1,slots-schoolSlots));
    this.menuSem=slots>1?new Semaphore(1):this.sem;
    this.schoolDirectory=typeof source.SchoolDirectory==='function'?new source.SchoolDirectory(this.connection(),{width:schoolSlots}):null;
    this.checking=false;this.stopping=false;
  }
  connection(extra={}) {return {pool:this.pool,direct:this.config.direct,directFirst:this.config.directFirst,...extra};}
  clear(ctx) {
    ctx.epoch=(this.epochs.get(ctx.key)||0)+1;this.epochs.set(ctx.key,ctx.epoch);
    ctx.state={};this.sessions.set(ctx.key,ctx.state);
  }
  current(ctx) {return ctx.epoch===undefined||ctx.epoch===(this.epochs.get(ctx.key)||0);}
  async discardLateMessage(ctx,msg) {
    if(!msg||ctx.chat.type!=='private')return;
    try{await this.api.safe('deleteMessages',{chat_id:ctx.chat.id,message_ids:[msg.message_id]});this.db.forget(ctx.chat.id,[msg.message_id]);}catch{}
  }
  typeKeyboard() {return [...Object.entries(this.source.TYPES).map(([v,label])=>[BUTTON(label,`t:${v}`)]),CANCEL];}
  background(fn) {
    const task=Promise.resolve().then(fn).catch(error=>{if(error.code==='REQUEST_CANCELLED')log.debug('background.cancelled','İşlem iptal edildi');else log.error('background.failed',error);});
    this.tasks.add(task);task.then(()=>this.tasks.delete(task));return task;
  }
  async send(chat,user,text,keyboard=null,html=true) {
    try {
      const params={chat_id:chat,text};if(html)params.parse_mode='HTML';if(keyboard)params.reply_markup={inline_keyboard:keyboard};
      const msg=await this.api.safe('sendMessage',params);this.db.remember(chat,msg.message_id,user||chat);return msg;
    } catch(e) {
      if(e.code===403||(e.code===400&&/chat not found/i.test(e.message)))this.db.deleteChat(chat);
      log.warn('telegram.send_failed',e,{chat_id:chat,method:'sendMessage'});
      return null;
    }
  }
  async reply(ctx,text,kb=null,html=true) {
    if(!this.current(ctx))return null;
    const msg=await this.send(ctx.chat.id,ctx.user.id,text,kb,html);
    if(!this.current(ctx)){await this.discardLateMessage(ctx,msg);return null;}
    if(msg&&kb)ctx.state.menu=msg.message_id;return msg;
  }
  async edit(ctx,text,kb=null) {
    if(!this.current(ctx))return;
    const id=ctx.callback?.message?.message_id||ctx.state.menu;
    try {
      await this.api.safe('editMessageText',{chat_id:ctx.chat.id,message_id:id,text,parse_mode:'HTML',reply_markup:{inline_keyboard:kb||[]}});
      this.db.remember(ctx.chat.id,id,ctx.user.id);if(kb)ctx.state.menu=id;
    } catch(e) {
      if(e.code===400&&/not modified/i.test(e.message))return;
      if(e.code===400){log.warn('telegram.edit_fallback',e,{message_id:id,chat_id:ctx.chat.id});return this.reply(ctx,text,kb);}
      throw e;
    }
  }
  async plainReport(chat,user,text,owner=null) {
    const chunks=splitText(text);
    for(let i=0;i<chunks.length;i++){
      if(owner&&!this.current(owner))return;
      const msg=await this.send(chat,user,`📋 Liste (${i+1}/${chunks.length})\n${chunks[i]}`,null,false);
      if(owner&&!this.current(owner)){await this.discardLateMessage(owner,msg);return;}
    }
  }
  async cleanup(ctx) {
    if(ctx.chat.type!=='private')return {attempted:0,failed:0};
    const ids=this.db.messages(ctx.chat.id,ctx.user.id);
    const batches=[];for(let i=0;i<ids.length;i+=100)batches.push(ids.slice(i,i+100));
    let failed=0;
    // Tek tek mesaj silmek yerine 100'lük paketler, en fazla 2 eşzamanlı istek.
    // api.safe, Telegram 429 yanıtında gerekli süreyi bekler.
    for(let i=0;i<batches.length;i+=2){
      if(!this.current(ctx))break;
      await Promise.all(batches.slice(i,i+2).map(async batch=>{
        try{await this.api.safe('deleteMessages',{chat_id:ctx.chat.id,message_ids:batch});this.db.forget(ctx.chat.id,batch);}
        catch(error){failed+=batch.length;log.warn('telegram.cleanup_failed',error,{chat_id:ctx.chat.id,batch_count:batch.length,method:'deleteMessages'});}
      }));
    }
    return {attempted:ids.length,failed};
  }
  async clearChat(ctx) {
    this.clear(ctx);
    if(ctx.chat.type!=='private')return this.reply(ctx,'/clear yalnızca botla özel sohbette kullanılabilir. Grup mesajları silinmedi.');
    const result=await this.cleanup(ctx);
    if(!this.current(ctx))return;
    // Başarılıysa ek onay mesajı bırakma: sohbet boş kalsın, fazladan API isteği olmasın.
    if(result.failed)await this.reply(ctx,'⚠️ Bazı mesajlar Telegram izinleri veya süre sınırı nedeniyle silinemedi. Takiplerin devam ediyor.');
  }
  peekList(key) {
    let row=this.memoryLists.get(key);
    if(!row){row=this.db.getList(key);if(row)this.memoryLists.set(key,row);}
    return row;
  }
  async refreshList(key,fetch) {
    if(this.listFlights.has(key))return this.listFlights.get(key);
    const flight=(async()=>{
      const value=await this.menuSem.run(fetch);
      const valid=Array.isArray(value)?value.length>0:Array.isArray(value?.items)&&value.il&&value.ilce;
      if(valid){this.db.putList(key,value);this.memoryLists.set(key,{data:value,updated_at:now()});}
      return value;
    })();
    this.listFlights.set(key,flight);
    try{return await flight;}finally{if(this.listFlights.get(key)===flight)this.listFlights.delete(key);}
  }
  async cachedList(key,fetch,ttl) {
    const row=this.peekList(key);
    if(row){
      // Süresi geçmiş okul listesini de hemen göster; yenileme menüyü bekletmez.
      if(now()-row.updated_at>=ttl)this.background(()=>this.refreshList(key,fetch));
      return row.data;
    }
    try{return await this.refreshList(key,fetch);}catch(error){throw log.wrap(ERR,error,{stage:'school.cache_load'});}
  }
  setOptions(ctx,kind,items) {ctx.state.opts={kind,all:items,items,page:0};}
  async startFlow(ctx,action) {
    if(action==='list'&&this.districtTasks.has(ctx.key))return this.reply(ctx,'⏳ Önceki ilçe listen hazırlanıyor.');
    this.clear(ctx);ctx.state.action=action;ctx.state.f={};
    if(action==='list'){ctx.state.stage='class';ctx.state.f.selected=[];return this.reply(ctx,'📚 Önce sınıf(lar) veya Hepsi’ni seç, ardından Devam’a bas.',classKeyboard());}
    ctx.state.stage='type';return this.reply(ctx,'Hangi okul türünü takip etmek istiyorsun?',this.typeKeyboard());
  }
  async pickType(ctx,tur) {
    if(!Object.hasOwn(this.source.TYPES,tur)||!['track','list'].includes(ctx.state.action))return;
    const f=ctx.state.f;if(ctx.state.action==='list'&&!f.sinif)return;
    f.tur=tur;ctx.state.stage='location';delete ctx.state.opts;
    const items=provinceOptions();
    this.setOptions(ctx,'il',items);
    await this.edit(ctx,LISTS.il.title,optionKeyboard('il',items));
  }
  async pickOption(ctx,kind,val) {
    const opts=ctx.state.opts,f=ctx.state.f;if(!opts||!f||opts.kind!==kind)return;
    const item=opts.all.find(([v])=>v===val);if(!item)return;const label=item[1],tur=f.tur;
    if(kind==='il') {
      Object.assign(f,{local_il:val,il_ad:label});
      const items=districtOptions(val);
      this.setOptions(ctx,'ilce',items);
      if(this.schoolDirectory)this.background(()=>this.menuSem.run(()=>this.current(ctx)?this.schoolDirectory.warm(tur,label):null));
      await this.edit(ctx,LISTS.ilce.title,optionKeyboard('ilce',items));
    }else if(kind==='ilce') {
      Object.assign(f,{local_ilce:val,ilce_ad:label});
      const key=`schools-local:v1:${tur}:${f.local_il}:${val}`;
      const cached=this.peekList(key);
      try {
        // Telegram bekleme mesajı ile MEB sorgusu aynı anda başlasın.
        const work=this.cachedList(key,()=>this.schoolDirectory
          ?this.schoolDirectory.list(tur,f.il_ad,f.ilce_ad)
          :this.source.fetchSchoolOptions(tur,f.il_ad,f.ilce_ad,this.connection()),86400);
        const [schoolList]=await Promise.all([work,cached?Promise.resolve():this.edit(ctx,'⏳ Okul listesi hazırlanıyor...')]);
        if(!this.current(ctx))return;
        if(!schoolList||!Array.isArray(schoolList.items)||!schoolList.il||!schoolList.ilce)throw new Error('Okul eşlemesi eksik');
        const {items}=schoolList;
        // Takipler ve canlı sorgular daima doğrulanmış MEB kimliklerini kullanır.
        Object.assign(f,{il:schoolList.il,ilce:schoolList.ilce});
        if(!items.length){this.clear(ctx);return this.edit(ctx,'Bu seçimde listelenecek okul bulunamadı.');}
        if(ctx.state.action==='list') {
          const details={...f};this.clear(ctx);
          await this.edit(ctx,`⏳ ${esc(details.il_ad)} / ${esc(label)}: ${items.length} okulun kontenjanı hazırlanıyor.`);
          const task=this.background(()=>this.districtReport(ctx.chat.id,ctx.user.id,details,items,{key:ctx.key,epoch:ctx.epoch,chat:ctx.chat}));
          this.districtTasks.set(ctx.key,task);task.then(()=>this.districtTasks.delete(ctx.key));return;
        }
        this.setOptions(ctx,'okul',items);await this.edit(ctx,LISTS.okul.title,optionKeyboard('okul',items));
      }catch(error){log.error('school.selection_failed',error,{province:f.il_ad,district:label});await this.edit(ctx,ERR);}
    }else if(kind==='okul') {
      Object.assign(f,{okul:val,okul_ad:cleanSchool(label),selected:[]});delete ctx.state.opts;ctx.state.stage='class';
      await this.edit(ctx,`🏫 <b>${esc(f.okul_ad)}</b>\nSınıfları seç, ardından Devam’a bas.`,classKeyboard());
    }
  }
  async pickClass(ctx,value) {
    const f=ctx.state.f;if(!f||ctx.state.stage!=='class'||!['9','10','11','12','all','done'].includes(value))return;
    if(value!=='done') {f.selected=toggleClass(f.selected||[],value);return this.edit(ctx,'📚 Sınıfları seç, ardından Devam’a bas.',classKeyboard(f.selected));}
    if(!f.selected?.length)return this.edit(ctx,'⚠️ En az bir sınıf veya Hepsi’ni seç.',classKeyboard());
    f.sinif=f.selected.includes('all')?'all':[...f.selected].sort((a,b)=>Number(a)-Number(b)).join(',');
    if(ctx.state.action==='list'){ctx.state.stage='type';return this.edit(ctx,`📚 ${classText(f.sinif)}\nOkul türü seç.`,this.typeKeyboard());}
    ctx.state.stage='mode';await this.edit(ctx,`${esc(f.okul_ad)} — ${classText(f.sinif)}\nNe zaman haber vereyim?`,[
      [BUTTON('📈 Sadece artınca','m:up')],[BUTTON('📉 Sadece azalınca','m:down')],[BUTTON('🔔 İkisi de','m:both')],CANCEL]);
  }
  async pickMode(ctx,mode) {
    const f=ctx.state.f;if(!f?.okul||!f.sinif||ctx.state.stage!=='mode'||!['up','down','both'].includes(mode))return;
    const result=this.db.saveSchoolSub({chat_id:ctx.chat.id,okul_id:f.okul,sinif:f.sinif,mode,tur:f.tur,il:f.il,ilce:f.ilce,
      okul_ad:f.okul_ad,il_ad:f.il_ad,user_id:ctx.user.id,user_name:[ctx.user.first_name,ctx.user.last_name].filter(Boolean).join(' ')||ctx.user.username||'Kullanıcı'},this.config.maxSubs);
    if(result.action==='limit')return this.edit(ctx,`En fazla ${this.config.maxSubs} takip ekleyebilirsin.`);
    f.sinif=result.sinif;
    const head={already:'ℹ️ <b>Zaten ekli</b>',updated:'🔄 <b>Güncellendi</b>',added:'✅ <b>Takip başladı</b>'}[result.action];
    const text=`${head}\n🏫 ${esc(f.okul_ad)}\n📚 ${classText(f.sinif)} · 🔔 kontenjan ${modeText(mode)}`+
      (result.action!=='already'&&!this.db.getSnap(f.okul)?'\nİlk veri arka planda alınacak; sonraki değişiklikler bildirilecek.':'');
    this.clear(ctx);await this.cleanup(ctx);
    if(ctx.chat.type==='private')await this.reply(ctx,text);else await this.edit(ctx,text);
    // Aynı kayıt tekrar seçildiyse gereksiz MEB kontrolü başlatma.
    if(result.action!=='already')this.background(()=>this.check());
  }
  async showSubs(ctx,edit=false) {
    const subs=this.db.listSubs(ctx.chat.id);if(!subs.length)return edit?this.edit(ctx,'Henüz takip yok. /takip_et ile ekleyebilirsin.'):this.reply(ctx,'Henüz takip yok. /takip_et ile ekleyebilirsin.');
    // Tek sayfada en fazla MAX_SUBS_PER_USER; HTML sınırı için uzun okul adları kısaltılır.
    const text='<b>Takiplerin</b>\n'+subs.map((s,i)=>`${i+1}. ${esc(s.okul_ad.slice(0,90))} — ${classText(s.sinif)}, ${modeText(s.mode)}`).join('\n');
    const kb=subs.map((s,i)=>[BUTTON(`❌ ${i+1}. ${s.okul_ad.slice(0,25)} · ${s.sinif}`,`d:${s.okul_id}:${s.sinif}`)]);
    return edit?this.edit(ctx,text,kb):this.reply(ctx,text,kb);
  }
  async status(ctx) {
    const subs=this.db.listSubs(ctx.chat.id);if(!subs.length)return this.reply(ctx,'Henüz takip yok. /takip_et ile ekleyebilirsin.');
    const seen=new Set(),blocks=[];
    for(const s of subs) {
      if(seen.has(s.okul_id))continue;seen.add(s.okul_id);
      const mine=subs.filter(x=>x.okul_id===s.okul_id).map(x=>x.sinif),grade=mine.includes('all')?'all':[...new Set(mine.flatMap(x=>x.split(',')))].join(',');
      const snap=this.db.getSnap(s.okul_id);
      blocks.push(`🏫 ${s.okul_ad}\n${snap?quota(snap.data,grade,false)+'\n🕐 Son kontrol: '+timeText(snap.checked_at):'Henüz veri alınmadı.'}`);
    }
    await this.plainReport(ctx.chat.id,ctx.user.id,blocks.join('\n\n'));
  }
  async districtReport(chat,user,f,items,owner=null) {
    try {
      const key=`quota:${f.tur}:${f.il}:${f.ilce}`,cached=this.db.getList(key);let result,stamp,label;
      if(cached&&now()-cached.updated_at<60){result=Object.fromEntries(cached.data);stamp=cached.updated_at;label='Önbellek (en fazla 60 sn)';}
      else {
        result=await this.sem.run(()=>this.source.checkGroup(f.tur,f.il,items.map(([id])=>[id,f.ilce]),this.connection({deadline:Date.now()+this.config.listTimeout*1000})));
        stamp=now();label='Yeni sorgu';if(items.every(([id])=>result[id]!=null))this.db.putList(key,Object.entries(result));
      }
      const lines=[`📍 ${f.il_ad} / ${f.ilce_ad}`,this.source.TYPES[f.tur],`📚 ${classText(f.sinif)} · ${items.length} okul`,`🕐 ${timeText(stamp)} · ${label}`,''];let failed=0;
      items.forEach(([id,name],i)=>{lines.push(`${i+1}. ${cleanSchool(name)}`);if(result[id]==null){failed++;lines.push('⚠️ Veri alınamadı (sıfır kontenjan anlamına gelmez).');}else lines.push(quota(result[id],f.sinif,false));lines.push('');});
      if(failed)lines.push(`⚠️ ${failed} okul sorgulanamadı veya süre sınırına takıldı. Yeniden deneyebilirsin.`);
      await this.plainReport(chat,user,lines.join('\n'),owner);
    }catch(error){log.error('district.report_failed',error,{chat_id:chat,province_id:f.il,district_id:f.ilce});if(!owner||this.current(owner))await this.send(chat,user,ERR);}
  }
  async notify(id,changes) {
    for(const sub of this.db.subsForSchool(id)) {
      const matched=matchingChanges(sub,changes);if(!matched.length)continue;
      const user=sub.user_id||(sub.chat_id>0?sub.chat_id:null);
      const tag=user?`<a href="tg://user?id=${user}">${esc(sub.user_name||'Kullanıcı')}</a>\n`:'';
      const head=tag+`🏫 <b>${esc(sub.okul_ad.slice(0,180))}</b>\n`;let chunk=head;
      for(const [key,grade,a,b] of matched) {
        const line=`${b>a?'📈':'📉'} ${grade}. sınıf${key==='Genel'?'':` (${esc(key.slice(0,160))})`}: ${a} → <b>${b}</b>\n`;
        if(chunk.length+line.length>3600){await this.send(sub.chat_id,user,chunk);chunk=head;}chunk+=line;
      }
      await this.send(sub.chat_id,user,chunk+`🕐 ${timeText(now())}`);
    }
  }
  async check() {
    if(this.checking||this.stopping){log.debug('tracking.skipped','Önceki kontrol sürüyor veya bot duruyor');return;}this.checking=true;
    const started=Date.now();let checked=0,failed=0,changed=0;
    try {
      await Promise.all(this.db.groups().map(group=>this.sem.run(async()=>{
        let result={};try{result=await this.source.checkGroup(group.tur,group.il,group.schools,this.connection({deadline:Date.now()+this.config.groupTimeout*1000}));}catch(error){log.error('tracking.group_failed',error,{province_id:group.il,type:group.tur,school_count:group.schools.length});}
        for(const [id] of group.schools) {
          // Kontrol sırasında tüm takipler silindiyse eski sonucu geri yazma.
          if(!this.db.subsForSchool(id).length)continue;
          const data=result[id];if(data==null){failed++;this.db.bumpFail(id);continue;}checked++;
          const old=this.db.getSnap(id),changes=old?this.source.diff(old.data,data):[];
          this.db.saveSnap(id,data,changes.length>0);if(changes.length){changed++;await this.notify(id,changes);}
        }
      })));
    }finally{this.checking=false;log.info('tracking.finished','Kontrol turu tamamlandı',{duration_ms:Date.now()-started,checked,failed,changed});}
  }
  async showWelcome(ctx) {
    return this.reply(ctx,'<b>Lise kontenjan takip botu</b>\n'+
      '/start — açılış menüsünü göster\n/clear — kayıtlı özel sohbet mesajlarını temizle\n'+
      '/takip_et — okul takibi ekle\n/takiplerim — takipleri gör / sil\n/durum — son bilinen kontenjan\n/kontejyanlistesi — sınıf → okul türü → il → ilçe listesi\n\n'+
      `Birden fazla sınıfı işaretleyip Devam’a basabilirsin. En fazla ${this.config.maxSubs} takip. Kontrol aralığı ${this.config.interval} saniye.\n`+
      'İl/ilçe menüleri hazır listeden açılır. /clear takiplerini silmez; Telegram’ın izin verdiği kayıtlı mesajları temizler.');
  }
  async command(ctx,cmd) {
    if(cmd==='clear')return this.clearChat(ctx);
    if(cmd==='start'){this.clear(ctx);return this.showWelcome(ctx);}
    if(['takip_et','ekle'].includes(cmd))return this.startFlow(ctx,'track');
    if(['kontejyanlistesi','kontenjanlistesi'].includes(cmd))return this.startFlow(ctx,'list');
    if(['takiplerim','birak'].includes(cmd))return this.showSubs(ctx);
    if(cmd==='durum')return this.status(ctx);
    return this.showWelcome(ctx);
  }
  async callback(ctx) {
    const [cmd,a,...rest]=(ctx.callback.data||'').split(':');if(cmd==='noop')return;
    if(['cancel','t','x','p','s','m'].includes(cmd)&&ctx.state.menu!==ctx.callback.message.message_id)return;
    if(cmd==='cancel'){this.clear(ctx);return this.edit(ctx,'İptal edildi.');}
    if(cmd==='t')return this.pickType(ctx,a);
    if(cmd==='x')return this.pickOption(ctx,a,rest.join(':'));
    if(cmd==='s')return this.pickClass(ctx,a);
    if(cmd==='m')return this.pickMode(ctx,a);
    if(cmd==='p') {
      const o=ctx.state.opts;if(!o)return;const page=Number(a);if(!Number.isInteger(page)||page<0)return;
      o.page=page;return this.edit(ctx,LISTS[o.kind].title,optionKeyboard(o.kind,o.items,page));
    }
    if(cmd==='d') {this.db.deleteSub(ctx.chat.id,a,rest.join(':'));return this.showSubs(ctx,true);}
  }
  async process(update) {
    const callback=update.callback_query,msg=callback?.message||update.message,user=callback?.from||msg?.from;
    if(!msg?.chat||!user||user.is_bot)return;
    const key=`${msg.chat.id}:${user.id}`;let state=this.sessions.get(key);
    if(!state){state={};this.sessions.set(key,state);}
    const ctx={key,chat:msg.chat,user,state,callback,epoch:this.epochs.get(key)||0};
    this.db.remember(msg.chat.id,msg.message_id,user.id);
    if(callback)return this.callback(ctx);
    const text=msg.text?.trim();if(!text)return;
    const cmd=text.match(/^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i);
    if(cmd)return this.command(ctx,cmd[1].toLowerCase());
    const opts=ctx.state.opts;if(!opts)return this.reply(ctx,'Takip için /takip_et, liste için /kontejyanlistesi yaz.');
    const needle=norm(text),plate=opts.kind==='il'&&/^\d{1,2}$/.test(needle)?Number(needle):null;
    if(plate===null&&needle.length<2)return this.reply(ctx,'Arama için en az 2 harf veya il plakası yaz.');
    const items=plate!==null?opts.all.filter(([id])=>Number(id)===plate):opts.all.filter(([,label])=>norm(label).includes(needle));if(!items.length)return this.reply(ctx,'Eşleşme bulunamadı.');
    opts.items=items;opts.page=0;return this.reply(ctx,`${LISTS[opts.kind].title}\n🔎 ${esc(text)}: ${items.length} sonuç`,optionKeyboard(opts.kind,items));
  }
  dispatch(update) {
    const q=update.callback_query,user=q?.from||update.message?.from,chat=q?.message?.chat||update.message?.chat;
    if(!user||!chat)return Promise.resolve();
    // Buton cevabı uzun MEB sorgusunun arkasında beklemez.
    if(q)this.api.safe('answerCallbackQuery',{callback_query_id:q.id}).catch(error=>log.debug('telegram.callback_ack_failed',error.message,{chat_id:chat.id,code:error.code}));
    const key=`${chat.id}:${user.id}`;
    const priority=!q&&/^\/(?:clear|start)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(update.message?.text?.trim()||'');
    const previous=(priority?this.priorityQueues.get(key):this.userQueues.get(key))||Promise.resolve();
    const epoch=this.epochs.get(key)||0;
    // /clear ve /start uzun MEB sorgusunun arkasında beklemez.
    // İptal edilen eski işlemler sonradan menü/ilçe listesi gönderemez.
    const action=q?'callback:'+String(q.data||'').split(':')[0]:(update.message?.text?.match(/^\/([a-z_]+)/i)?.[1]||'search');
    const task=previous.then(()=>log.withContext({trace_id:log.newTrace(),update_id:update.update_id,chat_id:chat.id,user_id:user.id,action},async()=>{
      if(!priority&&epoch!==(this.epochs.get(key)||0))return;
      const started=Date.now();
      try{await this.process(update);log.debug('update.finished','İşlem tamamlandı',{duration_ms:Date.now()-started});}
      catch(error){log.error('update.failed',error,{duration_ms:Date.now()-started});}
    })).catch(error=>log.error('update.queue_failed',error,{chat_id:chat.id}));
    this.tasks.add(task);this.userQueues.set(key,task);
    if(priority)this.priorityQueues.set(key,task);
    task.then(()=>{
      this.tasks.delete(task);
      if(this.userQueues.get(key)===task)this.userQueues.delete(key);
      if(this.priorityQueues.get(key)===task)this.priorityQueues.delete(key);
    });return task;
  }

  async run() {
    await this.api.safe('deleteWebhook',{drop_pending_updates:false});
    await this.api.safe('setMyCommands',{commands:[['start','Açılış menüsü'],['clear','Özel sohbeti temizle'],['takip_et','Yeni okul takibi'],['takiplerim','Takipleri gör / sil'],['durum','Son bilinen kontenjan'],['kontejyanlistesi','İlçedeki okulların kontenjanı'],['yardim','Yardım']].map(([command,description])=>({command,description}))});
    this.timer=setInterval(()=>this.background(()=>this.check()),this.config.interval*1000);
    this.first=setTimeout(()=>this.background(()=>this.check()),1000);
    let offset=0;log.info('bot.started','Bot başlatıldı',{node_version:process.version,interval_s:this.config.interval,proxy_enabled:!!this.pool,concurrency:this.config.concurrency});
    while(!this.stopping) {
      try {
        const updates=await this.api.call('getUpdates',{offset,timeout:30,limit:100,allowed_updates:['message','callback_query']},40000);
        for(const update of updates){this.dispatch(update);offset=Math.max(offset,update.update_id+1);}
        // Anormal trafik birikimini sınırla; normalde diğer kullanıcılar birbirini beklemez.
        if(this.userQueues.size>64)await Promise.race(this.userQueues.values());
      }catch(e){if(this.stopping)break;if(e.code===409||e.code===401){log.error('telegram.polling_fatal',e,{method:'getUpdates'});await this.stop();throw log.wrap('Telegram yapılandırma hatası',e,{stage:'telegram.polling'});}log.warn('telegram.polling_retry',e,{method:'getUpdates'});await sleep(e.code===429?((e.parameters?.retry_after||5)*1000):3000);}
    }
  }
  stop() {
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;clearInterval(this.timer);clearTimeout(this.first);this.api.stop();this.schoolDirectory?.close();
    this.stopPromise=(async()=>{
      let timer;
      try {await Promise.race([Promise.allSettled([...this.tasks,...this.userQueues.values()]),
        new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}
      finally{clearTimeout(timer);}
    })();
    return this.stopPromise;
  }
}
async function main() {
  require('dotenv').config({path:path.join(__dirname,'.env'),quiet:true});
  const config=loadConfig(),store=new Store(config.dbFile),api=new TelegramAPI(config.token);
  const pool=config.useProxy?new ProxyPool({file:config.proxyFile,url:config.proxyUrl,scheme:config.proxyScheme}):null;
  const bot=new EokulBot({store,api,config,pool});
  const shutdown=async()=>{await bot.stop();store.close();process.exit(0);};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  try{await bot.run();}finally{await bot.stop();store.close();}
}
if(require.main===module)main().catch(error=>{log.error('startup.failed',error);process.exitCode=1;});
module.exports={EokulBot,classKeyboard,optionKeyboard};
