'use strict';
const fs=require('node:fs/promises');
const log=require('./logger');
const {HttpsProxyAgent}=require('https-proxy-agent');
const {SocksProxyAgent}=require('socks-proxy-agent');
const SCHEMES=new Set(['http','https','socks4','socks5','socks5h']);
function parseProxies(text,scheme='http') {
  if(!SCHEMES.has(scheme)) throw new Error('Geçersiz PROXY_SCHEME');
  const found=[];
  for(let line of text.split(/<br\s*\/?>|[\r\n]+/i)) {
    line=line.replace(/^\uFEFF/,'').trim().replaceAll('\\:',':');
    if(!line||line.startsWith('#')) continue;
    try {
      if(!line.includes('://')) {
        const match=line.match(/^([^:]+):(\d+):([^:]+):(.+)$/);
        if(match) line=`${scheme}://${encodeURIComponent(match[3])}:${encodeURIComponent(match[4])}@${match[1]}:${match[2]}`;
        else if(/^[A-Za-z0-9.-]+:\d+$/.test(line)) line=`${scheme}://${line}`;
        else continue;
      }
      // URL normalizes :80/:443 away; preserve explicit/default usable ports.
      const u=new URL(line),protocol=u.protocol.slice(0,-1);
      if(!SCHEMES.has(protocol)||!u.hostname||!/^[A-Za-z0-9.-]+$/.test(u.hostname)||!['','/'].includes(u.pathname)||u.search||u.hash) continue;
      const port=u.port || (protocol==='http'?'80':protocol==='https'?'443':'');
      if(!port || Number(port)<1 || Number(port)>65535) continue;
      let auth='';
      if(u.username||u.password) {
        if(!u.username||!u.password) continue;
        auth=`${encodeURIComponent(decodeURIComponent(u.username))}:${encodeURIComponent(decodeURIComponent(u.password))}@`;
      }
      const normalized=`${protocol}://${auth}${u.hostname}:${port}`;log.registerProxy(normalized);found.push(normalized);
    } catch { /* Satır veya kimlik bilgisi loglanmaz. */ }
  }
  return [...new Set(found)];
}
function proxyAgent(url) {
  if(url.startsWith('socks')) return new SocksProxyAgent(url.replace(/^socks5:/,'socks5h:'),{keepAlive:true,maxSockets:1,maxFreeSockets:1});
  return new HttpsProxyAgent(url,{keepAlive:true,maxSockets:1,maxFreeSockets:1});
}
class ProxyPool {
  constructor({file=null,url='',scheme='http',refreshMs=300000,badMs=600000}={}) {
    if(!SCHEMES.has(scheme)) throw new Error('Geçersiz PROXY_SCHEME');
    log.registerSecret(url);Object.assign(this,{file,url,scheme,refreshMs,badMs});
    this.items=[];this.bad=new Map();this.nextRefresh=0;this.loading=null;
  }
  async refresh() {
    if(this.loading) return this.loading;
    if(Date.now()<this.nextRefresh) return;
    const started=Date.now();
    this.loading=(async()=>{
      try {
        let text;
        if(this.file) text=await fs.readFile(this.file,'utf8');
        else {
          if(!this.url.startsWith('https://')) throw new Error('HTTPS gerekli');
          const r=await fetch(this.url,{signal:AbortSignal.timeout(12000),redirect:'error'});
          if(!r.ok){const error=log.wrap('Proxy liste HTTP hatası',undefined,{code:'PROXY_DOWNLOAD_HTTP',stage:'proxy.download'});error.status=r.status;throw error;}
          text=await r.text();
        }
        const items=parseProxies(text,this.scheme);
        if(!items.length) throw log.wrap('Proxy kaynağında geçerli satır bulunamadı (IP:PORT:USERNAME:PASSWORD biçimini kontrol et)',undefined,{code:'PROXY_LIST_EMPTY',stage:'proxy.parse'});
        this.items=items;this.nextRefresh=Date.now()+this.refreshMs;this.lastError=null;log.info('proxy.loaded','Proxy kaynağı okundu',{source:this.file?'file':'download',count:items.length,duration_ms:Date.now()-started});
      } catch(error) { this.lastError=error;this.nextRefresh=Date.now()+60000;log.warn('proxy.load_failed',error,{source:this.file?'file':'download',file:this.file||undefined,duration_ms:Date.now()-started}); }
    })();
    try { await this.loading; } finally { this.loading=null; }
  }
  async pick(exclude=[]) {
    await this.refresh();
    for(const [p,until] of this.bad) if(until<=Date.now()) this.bad.delete(p);
    const excluded=new Set(exclude);
    const options=this.items.filter(p=>!this.bad.has(p)&&!excluded.has(p));
    return options.length?options[Math.floor(Math.random()*options.length)]:null;
  }
  markBad(p) { this.bad.set(p,Date.now()+this.badMs); }
}
module.exports={parseProxies,proxyAgent,ProxyPool};
