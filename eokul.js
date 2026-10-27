'use strict';
const axios=require('axios');
const cheerio=require('cheerio');
const iconv=require('iconv-lite');
const {CookieJar}=require('tough-cookie');
const {proxyAgent}=require('./proxies');
const {sleep,Semaphore}=require('./utils');
const log=require('./logger');
const BASE='https://eokulyd.meb.gov.tr';
const URL_MEB=BASE+'/ortaogretim/okl/ook06006.aspx';
const TYPES={21:'Fen ve Sosyal Bilimler Liseleri',22:'Anadolu Liseleri',23:'Güzel Sanatlar ve Spor Liseleri',6:'Anadolu İmam Hatip Liseleri',552:'Mesleki ve Teknik Anadolu Liseleri'};
const lower=s=>s.replaceAll('İ','i').replaceAll('I','ı').toLowerCase();
class EokulClient {
  constructor(proxy=null,deadline=Date.now()+90000) {
    this.stage='open';this.controller=new AbortController();this.proxy=proxy;this.deadline=deadline;this.$=null;this.jar=new CookieJar();this.agent=proxy?proxyAgent(proxy):undefined;
    this.ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  close() { this.controller.abort();this.agent?.destroy(); }
  parse(html) {
    const $=cheerio.load(html);
    if(!$('#Form1').length) throw log.wrap('Beklenen MEB formu bulunamadı',undefined,{code:'MEB_FORM_MISSING',stage:this.stage});
    this.$=$;
  }
  async request(method,data=null,url=URL_MEB,redirects=0) {
    const started=Date.now();
    try{const result=await this._request(method,data,url,redirects);log.debug('meb.request_done','MEB isteği tamamlandı',{stage:this.stage,method,duration_ms:Date.now()-started,proxy:this.proxy||'direct'});return result;}
    catch(error){throw log.wrap(`MEB ${this.stage} isteği başarısız`,error,{stage:this.stage});}
  }
  async _request(method,data=null,url=URL_MEB,redirects=0) {
    const remaining=this.deadline-Date.now();
    if(remaining<=0) throw log.wrap('Sorgu süresi doldu',undefined,{code:'TIMEOUT',stage:this.stage});
    const headers={'User-Agent':this.ua,'Accept-Language':'tr-TR,tr;q=0.9','Accept':'text/html,application/xhtml+xml'};
    const cookie=await this.jar.getCookieString(url);if(cookie) headers.Cookie=cookie;
    if(method==='POST') Object.assign(headers,{'Content-Type':'application/x-www-form-urlencoded',Origin:BASE,Referer:URL_MEB});
    const timeout=Math.max(1,Math.min(12000,remaining));
    const res=await axios.request({method,url,data:data?new URLSearchParams(data).toString():undefined,
      headers,proxy:false,httpsAgent:this.agent,timeout,signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(timeout)]),
      maxRedirects:0,responseType:'arraybuffer',maxContentLength:5*1024*1024,
      validateStatus:s=>s>=200&&s<400});
    for(const c of res.headers['set-cookie']||[]) await this.jar.setCookie(c,url);
    if(res.status>=300) {
      const next=new URL(res.headers.location,url);
      if(redirects>=3||next.origin!==BASE) throw new Error('Beklenmeyen MEB yönlendirmesi');
      // ASP.NET yönlendirmeleri: 307/308 aynı yöntem; diğerleri GET.
      const retain=[307,308].includes(res.status);
      return this.request(retain?method:'GET',retain?data:null,next.href,redirects+1);
    }
    const charset=String(res.headers['content-type']||'').match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1]||'utf-8';
    this.parse(iconv.decode(Buffer.from(res.data),iconv.encodingExists(charset)?charset:'utf-8'));
  }
  fields() {
    if(!this.$) throw new Error('Form açılmadı');
    const $=this.$,data={};
    $('#Form1 input').each((_,el)=>{
      const x=$(el),name=x.attr('name'),type=(x.attr('type')||'text').toLowerCase();
      if(name&&!['submit','button','image'].includes(type)) data[name]=x.attr('value')||'';
    });
    $('#Form1 select').each((_,el)=>{
      const x=$(el),name=x.attr('name');if(!name) return;
      const selected=x.find('option[selected]').first();
      data[name]=(selected.length?selected:x.find('option').first()).attr('value')||'';
    });
    return data;
  }
  async post(data) { await sleep(50+Math.random()*100);await this.request('POST',data); }
  async postback(target,values) { await this.post({...this.fields(),...values,__EVENTTARGET:target,__EVENTARGUMENT:''}); }
  options(id) {
    const out=[],$=this.$;
    $(`#${id} option`).each((_,el)=>{ const v=$(el).attr('value'),label=$(el).text().trim();if(v&&v!=='-1'&&label) out.push([v,label]); });
    return out;
  }
  hasOption(id,v) { return this.options(id).some(([id])=>id===v); }
  async selectType(tur) { this.stage='type';if(!this.$) await this.request('GET');await this.postback('ddlTercihTuru',{ddlTercihTuru:tur}); }
  async selectProvince(il) { this.stage='province';await this.postback('ddlIl',{ddlIl:il}); }
  async selectDistrict(ilce) { this.stage='district';await this.postback('ddlIlce',{ddlIlce:ilce}); }
  async listSchool(id) {
    this.stage='quota';await this.post({...this.fields(),ddlOkul:id,btnGiris:'Listele',hdnKontrol:'evet',__EVENTTARGET:'',__EVENTARGUMENT:''});
    return this.result();
  }
  result() {
    const $=this.$,tables=[],messages=[];
    $('table.frmList').each((_,table)=>{
      const rows=[];
      $(table).find('tr').each((_,tr)=>{
        const cells=$(tr).children('td,th').map((_,c)=>$(c).text().replace(/\s+/g,' ').trim()).get();
        if(cells.some(Boolean)) rows.push(cells);
      });if(rows.length) tables.push(rows);
    });
    $('#pnlUyari,.ook-mesaj,.ook-kayit,.alert').each((_,el)=>{const t=$(el).text().trim();if(t)messages.push(t);});
    return {tables,messages};
  }
}
function parseQuota({tables,messages}) {
  const rows={};let found=false;
  for(const table of tables) {
    const header=table[0],cols=[];
    header.forEach((h,i)=>{const text=lower(h),match=text.match(/(\d{1,2})\s*\.?\s*s[ıi]n[ıi]f/);if(text.includes('kontenjan')&&match) cols.push([i,match[1]]);});
    if(!cols.length) continue;found=true;
    const keys=header.map((_,i)=>i).filter(i=>!cols.some(([c])=>c===i));
    for(const r of table.slice(1)) {
      if(r.length<header.length) continue;
      let key=keys.map(i=>r[i]).filter(Boolean).join(' / ')||'Genel',base=key,n=2;
      while(Object.hasOwn(rows,key)) key=`${base} #${n++}`;
      const values={};for(const [i,grade] of cols) values[grade]=Number(r[i].match(/\d+/)?.[0]||0);
      // defineProperty also handles unusual row labels like __proto__ safely.
      Object.defineProperty(rows,key,{value:values,enumerable:true,writable:true,configurable:true});
    }
  }
  if(found) return rows;
  const text=lower(messages.join(' '));
  if(/kay[ıi]t.*(bulunamad|yok|mevcut de[ğg]il)|kontenjan.*bulunamad/.test(text)) return {};
  throw log.wrap('Kontenjan tablosu veya açık kayıt-yok mesajı bulunamadı',undefined,{code:'MEB_QUOTA_PARSE',stage:'quota.parse'});
}
function diff(oldData,newData) {
  const changes=[];
  for(const key of [...new Set([...Object.keys(oldData),...Object.keys(newData)])].sort()) {
    const o=oldData[key]||{},n=newData[key]||{};
    for(const s of [...new Set([...Object.keys(o),...Object.keys(n)])].sort((a,b)=>Number(a)-Number(b))) {
      const a=o[s]||0,b=n[s]||0;if(a!==b) changes.push([key,s,a,b]);
    }
  }return changes;
}
async function retry(work,{pool=null,direct=false,directFirst=false,tries=2,deadline=Date.now()+30000,makeClient=(p,d)=>new EokulClient(p,d)}={}) {
  let lastError;
  async function attempt(proxy=null) {
    if(Date.now()>=deadline) throw log.wrap('Sorgu süresi doldu',undefined,{code:'TIMEOUT',stage:'chain'});
    const c=makeClient(proxy,deadline);
    try { const value=await work(c);if(value!==c)c.close();return value; }
    catch(error) {c.close();throw log.wrap('MEB bağlantısı başarısız',error,{stage:c.stage||'chain'});}
  }
  if(!pool||(direct&&directFirst)) {try{return await attempt();}catch(error){lastError=error;log.warn('meb.direct_attempt_failed',error,{stage:'chain'});}}
  if(pool) for(let i=0;i<tries&&Date.now()<deadline;i++) {
    const proxy=await pool.pick();if(!proxy)break;
    try{return await attempt(proxy);}catch(error){lastError=error;pool.markBad(proxy);log.warn('meb.proxy_attempt_failed',error,{attempt:i+1,proxy});}
  }
  if(pool&&direct&&!directFirst&&Date.now()<deadline) {try{return await attempt();}catch(error){lastError=error;}}
  throw log.wrap('MEB bağlantısı kurulamadı; proxy/URL/kimlik bilgileri gizlendi.',lastError||pool?.lastError,{code:'MEB_CHAIN_FAILED',stage:'chain'});
}
// Yerel id'lerin MEB id'leriyle aynı olduğu varsayılmaz.
function placeKey(name) {
  return String(name).replace(/\s*\(\d+\)\s*$/,'').trim()
    .replace(/[İIıÖöÜüÇçŞşĞğ]/g,c=>({'İ':'i',I:'i','ı':'i','Ö':'o','ö':'o','Ü':'u','ü':'u','Ç':'c','ç':'c','Ş':'s','ş':'s','Ğ':'g','ğ':'g'}[c]))
    .toLowerCase().replace(/[^a-z0-9]/g,'');
}
function matchPlace(options,name,kind) {
  const aliases={afyonkarahisar:'afyon',kahramanmaras:'kmaras',sanliurfa:'urfa',mersin:'icel'};
  const key=placeKey(name),keys=new Set([key]);
  if(kind==='province'){
    if(aliases[key])keys.add(aliases[key]);
    for(const [full,short] of Object.entries(aliases))if(short===key)keys.add(full);
  }
  const matches=options.filter(([,label])=>keys.has(placeKey(label)));
  if(matches.length!==1)throw log.wrap('Yerel yer adı MEB listesiyle tekil eşleştirilemedi.',undefined,{code:'MEB_LOCATION_MATCH',stage:kind});
  return matches[0][0];
}
async function fetchSchoolOptions(tur,provinceName,districtName,config={}) {
  return retry(async c=>{
    await c.selectType(tur);
    const il=matchPlace(c.options('ddlIl'),provinceName,'province');
    await c.selectProvince(il);
    const ilce=matchPlace(c.options('ddlIlce'),districtName,'district');
    await c.selectDistrict(ilce);
    return {il,ilce,items:c.options('ddlOkul')};
  },{...config,deadline:Math.min(config.deadline||Infinity,Date.now()+30000)});
}
// İlk BAŞARILI sonuç kazanır. Hata veren ilk istek diğerini iptal etmez.
// İkinci iş yalnızca ilk iş gecikirse/hata verirse başlar; en fazla iki iş çalışır.
function firstSuccessful(tasks,{delay=750,deadline=Date.now()+30000,signal}={}) {
  return new Promise((resolve,reject)=>{
    let done=false,started=0,running=0,delayTimer,deadlineTimer;
    const controls=[],errors=[];
    const cleanup=()=>{clearTimeout(delayTimer);clearTimeout(deadlineTimer);signal?.removeEventListener('abort',abort);};
    function cancelOthers(winner=-1){controls.forEach((c,i)=>{if(i!==winner)c.cancel();});}
    function fail(){if(done)return;done=true;cleanup();cancelOthers();reject(log.wrap('Paralel okul sorgusu tamamlanamadı; hassas bilgiler gizlendi.',errors.length?new AggregateError(errors,'Denemelerin hata nedenleri'):undefined,{code:signal?.aborted?'REQUEST_CANCELLED':Date.now()>=deadline?'TIMEOUT':'SCHOOL_RACE_FAILED',stage:'school.race'}));}
    function abort(){fail();}
    function launch(){
      if(done||started>=Math.min(tasks.length,2))return;
      const index=started++;running++;
      const control={cancelled:false,handlers:[],onCancel(fn){if(this.cancelled)fn();else this.handlers.push(fn);},cancel(){if(this.cancelled)return;this.cancelled=true;for(const fn of this.handlers){try{fn();}catch{}}}};
      controls[index]=control;
      Promise.resolve().then(()=>tasks[index](control)).then(value=>{
        running--;if(done){control.cancel();return;}
        done=true;cleanup();cancelOthers(index);resolve(value);
      },error=>{
        running--;if(done)return;errors.push(error);
        if(started<Math.min(tasks.length,2)){clearTimeout(delayTimer);launch();}
        else if(running===0)fail();
      });
    }
    if(!tasks.length||signal?.aborted||Date.now()>=deadline)return fail();
    signal?.addEventListener('abort',abort,{once:true});
    deadlineTimer=setTimeout(fail,Math.max(1,deadline-Date.now()));
    launch();
    if(tasks.length>1)delayTimer=setTimeout(launch,delay);
  });
}
async function differentProxy(pool,exclude=[]) {
  // Eski havuz uygulamaları exclude parametresini yok saysa da aynı proxyyi iki kez yarıştırma.
  for(let i=0;i<3;i++){const p=await pool.pick(exclude);if(!p)return null;if(!exclude.includes(p))return p;}
  return null;
}

// İl seçimi sırasında hazırlanan oturum: çerez, proxy ve ViewState birlikte korunur.
// Aynı oturumdaki ilçe POST'ları eşzamanlı çalıştırılmaz.
class SchoolDirectory {
  constructor(config={},options={}) {
    this.config=config;this.ttl=options.ttl??120000;this.max=options.max??24;
    this.entries=new Map();this.closed=false;this.width=Math.max(1,Math.min(2,options.width??2));this.hedgeMs=options.hedgeMs??750;
  }
  key(tur,name){return `${tur}:${placeKey(name)}`;}
  remove(key,entry){
    if(this.entries.get(key)===entry)this.entries.delete(key);
    entry.closed=true;entry.controller?.abort();entry.client?.close();
  }
  trim(){
    const idle=[...this.entries].filter(([,e])=>!e.loading&&e.mutex.active===0).sort((a,b)=>a[1].used-b[1].used);
    while(this.entries.size>=this.max&&idle.length){const [key,e]=idle.shift();this.remove(key,e);}
  }
  async warm(tur,provinceName,deadline=Date.now()+30000){
    if(this.closed)throw new Error('Okul oturum havuzu kapalı');
    const key=this.key(tur,provinceName);let entry=this.entries.get(key);
    if(entry&&!entry.closed&&(entry.loading||Date.now()<entry.expires||entry.mutex.active)){
      entry.used=Date.now();return entry.promise;
    }
    if(entry)this.remove(key,entry);this.trim();
    entry={mutex:new Semaphore(1),used:Date.now(),expires:0,loading:true,closed:false,client:null,started:Date.now(),controller:new AbortController()};
    this.entries.set(key,entry);
    entry.promise=this.prepare(tur,provinceName,deadline,entry.controller.signal).then(result=>{
      entry.loading=false;
      if(entry.closed||this.closed){result.client.close();throw log.wrap('Hazırlanan oturum iptal edildi',undefined,{code:'REQUEST_CANCELLED',stage:'school.prepare'});}
      Object.assign(entry,result);entry.expires=Date.now()+this.ttl;log.info('school.prepared','Okul oturumu hazır',{province:provinceName,proxy:result.client.proxy||'direct',duration_ms:Date.now()-entry.started});return entry;
    }).catch(error=>{
      this.remove(key,entry);throw log.wrap('Okul listesi hazırlığı başarısız; hassas bilgiler gizlendi.',error,{stage:'school.prepare'});
    });
    return entry.promise;
  }
  makeClient(proxy,deadline){return this.config.makeClient?this.config.makeClient(proxy,deadline):new EokulClient(proxy,deadline);}
  async prepareOne(tur,provinceName,proxy,deadline,control){
    if(control.cancelled)throw new Error('İptal edildi');
    const client=this.makeClient(proxy,deadline);control.onCancel(()=>client.close());
    try{
      await client.selectType(tur);if(control.cancelled)throw new Error('İptal edildi');
      const il=matchPlace(client.options('ddlIl'),provinceName,'province');
      await client.selectProvince(il);if(control.cancelled)throw new Error('İptal edildi');
      return {client,il,districts:client.options('ddlIlce')};
    }catch(error){
      client.close();if(!control.cancelled){if(proxy)this.config.pool?.markBad(proxy);log.warn('school.prepare_attempt_failed',error,{proxy,stage:client.stage||'school.prepare'});}
      throw log.wrap('Okul hazırlığı başarısız',error,{stage:'school.prepare'});
    }
  }
  async prepare(tur,provinceName,deadline,signal){
    if(this.width>1&&this.config.pool&&!(this.config.direct&&this.config.directFirst)){
      const first=await differentProxy(this.config.pool);
      if(first){
        const second=await differentProxy(this.config.pool,[first]);
        const tasks=[first,...(second?[second]:[])].map(proxy=>control=>this.prepareOne(tur,provinceName,proxy,deadline,control));
        try{return await firstSuccessful(tasks,{delay:this.hedgeMs,deadline,signal});}catch(error){
          if(!this.config.direct||signal.aborted)throw log.wrap('Proxy okul hazırlığı başarısız',error,{stage:'school.prepare'});
          log.warn('school.direct_fallback',error,{stage:'school.prepare'});
        }
      }else if(!this.config.direct)throw log.wrap('Kullanılabilir proxy yok',this.config.pool.lastError,{code:'NO_PROXY',stage:'school.prepare'});
    }
    let result;
    const client=await retry(async c=>{
      await c.selectType(tur);const il=matchPlace(c.options('ddlIl'),provinceName,'province');
      await c.selectProvince(il);result={il,districts:c.options('ddlIlce')};return c;
    },{...this.config,deadline});
    return {...result,client};
  }
  async district(entry,tur,provinceName,districtName,deadline){
    const primary=entry.client;
    const primaryTask=async control=>{
      control.onCancel(()=>primary.close());primary.deadline=deadline;
      try{
        const ilce=matchPlace(entry.districts,districtName,'district');
        await primary.selectDistrict(ilce);if(control.cancelled)throw new Error('İptal edildi');
        return {client:primary,il:entry.il,districts:entry.districts,payload:{il:entry.il,ilce,items:primary.options('ddlOkul')}};
      }catch(error){if(!control.cancelled){if(primary.proxy)this.config.pool?.markBad(primary.proxy);log.warn('school.primary_failed',error,{proxy:primary.proxy||'direct',district:districtName});}throw log.wrap('İlçe sorgusu başarısız',error,{stage:'school.district.primary'});}
    };
    const backupTask=async control=>{
      const proxy=await differentProxy(this.config.pool,primary.proxy?[primary.proxy]:[]);
      if(!proxy||control.cancelled)throw new Error('İkinci proxy yok');
      const prepared=await this.prepareOne(tur,provinceName,proxy,deadline,control);
      try{
        const ilce=matchPlace(prepared.districts,districtName,'district');
        await prepared.client.selectDistrict(ilce);if(control.cancelled)throw new Error('İptal edildi');
        return {...prepared,payload:{il:prepared.il,ilce,items:prepared.client.options('ddlOkul')}};
      }catch(error){prepared.client.close();if(!control.cancelled){this.config.pool.markBad(proxy);log.warn('school.backup_failed',error,{proxy,district:districtName});}throw log.wrap('Yedek ilçe sorgusu başarısız',error,{stage:'school.district.backup'});}
    };
    const tasks=[primaryTask];if(this.width>1&&this.config.pool)tasks.push(backupTask);
    const winner=await firstSuccessful(tasks,{delay:this.hedgeMs,deadline,signal:entry.controller.signal});
    Object.assign(entry,{client:winner.client,il:winner.il,districts:winner.districts});
    return winner.payload;
  }
  async list(tur,provinceName,districtName){
    const started=Date.now(),deadline=Date.now()+30000,key=this.key(tur,provinceName);let lastError;
    for(let attempt=0;attempt<2&&Date.now()<deadline;attempt++){
      let entry;
      try{
        entry=await this.warm(tur,provinceName,deadline);
        return await entry.mutex.run(async()=>{
          if(entry.closed||this.closed)throw new Error('Okul oturumu kapalı');
          const payload=await this.district(entry,tur,provinceName,districtName,deadline);
          entry.used=Date.now();entry.expires=entry.used+this.ttl;
          log.info('school.list_ready','Okul listesi alındı',{province:provinceName,district:districtName,school_count:payload.items.length,duration_ms:Date.now()-started});
          return payload;
        });
      }catch(error){
        lastError=error;if(!this.closed)log.warn('school.list_retry',error,{attempt:attempt+1,province:provinceName,district:districtName});
        if(entry){
          if(entry.client?.proxy)this.config.pool?.markBad(entry.client.proxy);
          this.remove(key,entry);
        }
      }
    }
    throw log.wrap('Okul listesi alınamadı; hassas bilgiler gizlendi.',lastError,{stage:'school.list'});
  }
  close(){this.closed=true;for(const [key,entry] of this.entries)this.remove(key,entry);}
}
async function fetchOptions(tur,il=null,ilce=null,config={}) {
  return retry(async c=>{
    await c.selectType(tur);
    if(il===null) {const r=c.options('ddlIl');if(!r.length)throw new Error('İl listesi boş');return r;}
    await c.selectProvince(il);
    if(ilce===null) {const r=c.options('ddlIlce');if(!r.length)throw new Error('İlçe listesi boş');return r;}
    await c.selectDistrict(ilce);return c.options('ddlOkul');
  },{...config,deadline:Math.min(config.deadline||Infinity,Date.now()+30000)});
}
async function openChain(tur,il,ilce,config) {
  return retry(async c=>{await c.selectType(tur);await c.selectProvince(il);await c.selectDistrict(ilce);return c;},config);
}
async function checkGroup(tur,il,schools,config={}) {
  const out=Object.fromEntries(schools.map(([id])=>[id,null]));
  const deadline=config.deadline||Date.now()+90000;let client=null,district=null;
  try {
    for(const [id,ownDistrict] of [...schools].sort((a,b)=>String(a[1]).localeCompare(String(b[1])))) {
      for(let attempt=0;attempt<2&&Date.now()<deadline;attempt++) {
        try {
          if(!client||district!==ownDistrict) {
            client?.close();client=null;
            client=await openChain(tur,il,ownDistrict,{...config,deadline});district=ownDistrict;
          }
          if(!client.hasOption('ddlOkul',id)){log.warn('tracking.school_missing',log.wrap('Takipteki okul MEB ilçe listesinde bulunamadı',undefined,{code:'MEB_SCHOOL_MISSING',stage:'quota.school_select'}),{school_id:id,district_id:ownDistrict});break;}
          out[id]=parseQuota(await client.listSchool(id));break;
        } catch(error) { log.warn('tracking.school_query_failed',error,{school_id:id,province_id:il,district_id:ownDistrict,attempt:attempt+1});client?.close();client=null; }
      }
    }
  } finally { client?.close(); }
  if(Date.now()>=deadline&&Object.values(out).some(v=>v===null))log.warn('tracking.deadline',log.wrap('Kontrol bütçesi doldu; bazı okullar sorgulanamadı',undefined,{code:'TIMEOUT',stage:'quota.group'}),{province_id:il,missing:Object.values(out).filter(v=>v===null).length});
  return out;
}
module.exports={TYPES,EokulClient,parseQuota,diff,retry,fetchOptions,fetchSchoolOptions,SchoolDirectory,firstSuccessful,matchPlace,checkGroup};
