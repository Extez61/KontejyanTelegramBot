'use strict';
const path=require('node:path');
const {AsyncLocalStorage}=require('node:async_hooks');
const {randomUUID}=require('node:crypto');
const scope=new AsyncLocalStorage(),secrets=new Set(),ROOT=__dirname;
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function timestamp(){const p=Object.fromEntries(clock.formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}+03:00`;}
function registerSecret(v){if(typeof v==='string'&&v.length>=4)secrets.add(v);}
function registerProxy(v){try{const u=new URL(v);for(const x of [u.username,u.password]){registerSecret(x);registerSecret(decodeURIComponent(x));}}catch{}}
function redact(input){
 let text=String(input??'');
 for(const [k,v] of Object.entries(process.env))if(/(?:token|password|passwd|secret|api_?key|proxy_list_url)$/i.test(k))registerSecret(v);
 for(const v of [...secrets].sort((a,b)=>b.length-a.length))text=text.split(v).join('[REDACTED]');
 text=text.replace(/https?:\/\/[^\s<>"'`]+/gi,raw=>{try{const u=new URL(raw);u.username='';u.password='';if(u.hostname==='eokulyd.meb.gov.tr')return u.origin+u.pathname;if(u.hostname==='api.telegram.org')return u.origin+'/bot[REDACTED]/[METHOD]';return u.origin+(u.pathname==='/'&&!u.search?'':'/[REDACTED]');}catch{return '[REDACTED_URL]';}});
 text=text.replace(/socks(?:4|5h?):\/\/[^\s<>"'`]+/gi,raw=>{try{const u=new URL(raw);return `${u.protocol}//${u.host}`;}catch{return '[REDACTED_PROXY]';}});
 text=text.replace(/\b\d{6,}:[A-Za-z0-9_-]{15,}\b/g,'[REDACTED_TOKEN]');
 text=text.replace(/\b([A-Za-z0-9.-]+:\d{2,5}):[^:\s]+:[^\s]+/g,'$1:[REDACTED_AUTH]');
 text=text.replace(/\b((?:proxy-)?authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,'$1=[REDACTED]');
 return text.replace(/\b(password|passwd|token|secret|api_?key|username)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[REDACTED]');
}
function inspectErrors(error){
 const result=[],seen=new Set();
 function visit(e,depth=0){
  if(!e||depth>5||result.length>=8||seen.has(e))return;seen.add(e);
  if(typeof e!=='object'){result.push({name:'Error',message:redact(e)});return;}
  const frames=typeof e.stack==='string'?e.stack.split('\n').filter(l=>/^\s*at\s/.test(l)).slice(0,6).map(l=>redact(l.trim())):[];
  const item={name:redact(e.name||'Error').replace(/[\r\n]+/g,' ').slice(0,120),message:redact(e.message||'Bilinmeyen hata').replace(/[\r\n]+/g,' ').slice(0,1200),frames};
  if(e.code!==undefined)item.code=redact(e.code).replace(/[\r\n]+/g,' ').slice(0,120);
  const status=e.response?.status??e.status;if(Number.isInteger(Number(status))&&Number(status)>0)item.http_status=Number(status);
  if(e.stage)item.stage=redact(e.stage).replace(/[\r\n]+/g,' ').slice(0,160);
  result.push(item);visit(e.cause,depth+1);
  if(Array.isArray(e.errors))for(const child of e.errors.slice(0,2))visit(child,depth+1);
 }
 visit(error);return result;
}
function hintFor(errors){
 const codes=errors.map(e=>e.code),messages=errors.map(e=>e.message).join(' '),statuses=errors.map(e=>e.http_status);
 if(codes.includes('401')||statuses.includes(401))return 'BOT_TOKEN değerini BotFather ile doğrula; gerçek tokenı paylaşma.';
 if(codes.includes('409')||statuses.includes(409))return 'Aynı token ile çalışan diğer bot sürecini durdur.';
 if(statuses.includes(407))return 'Proxy kullanıcı adı/şifresini ve sağlayıcı yetkilendirmesini kontrol et.';
 if(codes.includes('429')||statuses.includes(429))return 'İstek sınırı: belirtilen bekleme süresine uy; eşzamanlılığı artırma.';
 if(codes.some(c=>['ENOTFOUND','EAI_AGAIN'].includes(c)))return 'DNS çözümlemesi başarısız; sunucu DNS ve internet bağlantısını kontrol et.';
 if(codes.some(c=>['ECONNREFUSED','ECONNRESET','EPIPE','ENETUNREACH','EHOSTUNREACH'].includes(c)))return 'Proxy/hedef bağlantısını, portu ve ağ erişimini kontrol et.';
 if(codes.some(c=>['ETIMEDOUT','ECONNABORTED','TIMEOUT','UND_ERR_CONNECT_TIMEOUT'].includes(c))||errors.some(e=>e.name==='TimeoutError'))return 'İstek süresi doldu; proxy/MEB yavaş olabilir. Daha fazla paralellik her zaman çözmez.';
 if(codes.includes('MEB_FORM_MISSING')||codes.includes('MEB_QUOTA_PARSE'))return 'Beklenen MEB sayfa yapısı yok; bakım/erişim sayfası veya HTML değişikliği olabilir.';
 if(codes.includes('MEB_LOCATION_MATCH'))return 'Yerel il/ilçe adı MEB listesiyle eşleşmedi; kaynak listelerini kontrol et.';
 if(codes.includes('NO_PROXY'))return 'Kullanılabilir proxy yok; proxy dosyası, erişim ve geçici bekleme durumunu kontrol et.';
 if(codes.includes('ENOENT'))return 'Dosya veya dizin yok; yol ve çalışma dizinini kontrol et.';
 if(codes.some(c=>['EACCES','EPERM','ERR_SQLITE_ERROR','ERR_SQLITE_BUSY'].includes(c)))return 'Dosya izinleri, disk ve SQLite kilidini kontrol et; veritabanını silme.';
 if(/BOT_TOKEN/.test(messages))return '.env içindeki BOT_TOKEN alanını doldur; tokenı paylaşma.';
 if(/PROXY_FILE|proxies\.txt.*bulunamad|HTTPS PROXY_LIST_URL/i.test(messages))return 'Proxy dosyasını oluştur veya .env proxy kaynağı ayarını düzelt.';
 if(statuses.includes(403)||codes.includes('403'))return 'Erişim reddedildi. Telegram ise bot engeli/yetkileri; MEB ise erişim kısıtını kontrol et.';
}
function cleanFields(fields){
 const out={};for(const [k,v] of Object.entries(fields||{})){
  if(v===undefined)continue;
  if(/token|password|passwd|secret|authorization|cookie|proxy_list_url/i.test(k)){out[k]='[REDACTED]';continue;}
  if(typeof v==='string')out[k]=redact(v).replace(/[\r\n]+/g,' ').slice(0,800);
  else if(typeof v==='number'||typeof v==='boolean'||v===null)out[k]=v;
 }return out;
}
function wrap(message,cause,{code,stage}={}){const e=new Error(message,cause?{cause}:undefined);if(code!==undefined)e.code=code;else if(cause?.code!==undefined)e.code=cause.code;if(stage)e.stage=stage;return e;}
function createLogger({level,sink}={}){
 const ranks={debug:10,info:20,warn:30,error:40};
 function emit(kind,event,message,fields,error){
  if(ranks[kind]<(ranks[level||process.env.LOG_LEVEL||'info']??20))return;
  const context=cleanFields({...scope.getStore(),...fields}),errors=error?inspectErrors(error):[];
  const frame=errors.flatMap(e=>e.frames||[]).find(f=>f.includes(ROOT+path.sep)&&!f.includes('/node_modules/')&&!f.includes('/logger.js:'));
  if(frame)context.where=frame.replaceAll(ROOT+path.sep,'');const hint=hintFor(errors);if(hint)context.hint=hint;
  const suffix=Object.entries(context).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join(' ');
  let line=`${timestamp()} ${kind.toUpperCase()} [${event}] ${redact(message).replace(/[\r\n]+/g,' ')}${suffix?' | '+suffix:''}`;
  for(const [i,e] of errors.entries()){
   line+=`\n  ${i?'cause':'error'}[${i}]: ${e.name}${e.code!==undefined?` code=${e.code}`:''}${e.http_status?` HTTP=${e.http_status}`:''}${e.stage?` stage=${e.stage}`:''}: ${e.message}`;
   for(const f of e.frames||[])line+='\n    '+f.replaceAll(ROOT+path.sep,'');
  }
  line+='\n';if(sink)sink(line,kind);else(kind==='error'||kind==='warn'?process.stderr:process.stdout).write(line);
 }
 return {debug:(e,m,f)=>emit('debug',e,m,f),info:(e,m,f)=>emit('info',e,m,f),warn:(e,x,f)=>emit('warn',e,x?.message||String(x),f,x),error:(e,x,f)=>emit('error',e,x?.message||String(x),f,x),withContext:(f,fn)=>scope.run({...scope.getStore(),...f},fn)};
}
module.exports={...createLogger(),wrap,redact,registerSecret,registerProxy,inspectErrors,createLogger,newTrace:()=>randomUUID().slice(0,8)};
