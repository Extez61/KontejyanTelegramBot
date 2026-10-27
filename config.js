'use strict';
const path=require('node:path');
const fs=require('node:fs');
function loadConfig(root=__dirname,env=process.env) {
  const integer=(name,fallback,min=1)=>{const v=Number(env[name]??fallback);if(!Number.isSafeInteger(v)||v<min)throw new Error(`${name} geçerli pozitif sayı olmalı.`);return v;};
  const useProxy=(env.USE_PROXY??'1')==='1';
  const file=env.PROXY_FILE??'proxies.txt';
  const config={root,token:env.BOT_TOKEN||'',interval:integer('CHECK_INTERVAL',120),
    concurrency:integer('MAX_CONCURRENCY',4),maxSubs:integer('MAX_SUBS_PER_USER',15),
    groupTimeout:integer('GROUP_TIMEOUT',90),listTimeout:integer('LIST_TIMEOUT',120),
    useProxy,proxyFile:file?path.resolve(root,file):null,proxyUrl:env.PROXY_LIST_URL||'',
    proxyScheme:env.PROXY_SCHEME||'http',direct:env.DIRECT_FALLBACK==='1',directFirst:env.DIRECT_FIRST==='1',
    dbFile:path.resolve(root,env.DB_PATH||'eokul_bot.db')};
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(config.token)||config.token.includes('BURAYA'))throw new Error('.env içindeki BOT_TOKEN alanını doldurun.');
  if(!['http','https','socks4','socks5','socks5h'].includes(config.proxyScheme))throw new Error('Geçersiz PROXY_SCHEME.');
  if(useProxy&&config.proxyFile&&!fs.existsSync(config.proxyFile))throw new Error('proxies.txt bulunamadı. Proxy dosyanı oluştur veya PROXY_FILE alanını boşaltıp PROXY_LIST_URL kullan.');
  if(useProxy&&!config.proxyFile&&!config.proxyUrl.startsWith('https://'))throw new Error('HTTPS PROXY_LIST_URL veya PROXY_FILE gerekli.');
  return config;
}
module.exports={loadConfig};
