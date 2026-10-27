'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {retry}=require('./eokul');
const {ProxyPool}=require('./proxies');
const log=require('./logger');
const SOURCE='https://eokulyd.meb.gov.tr/ortaogretim/okl/ook06006.aspx';
function validateOptions(items,label){
 if(!Array.isArray(items)||!items.length)throw new Error(`${label} listesi boş; mevcut dosya değiştirilmedi.`);
 const ids=new Set();
 for(const [id,name] of items){if(!id||!name||ids.has(String(id)))throw new Error(`${label} listesi geçersiz; mevcut dosya değiştirilmedi.`);ids.add(String(id));}
 return items.map(([id,name])=>({id:String(id),name:String(name).toLocaleUpperCase('tr-TR')}));
}
async function collectLocations(config={}){
 const deadline=config.deadline||Date.now()+600000;let client;
 const open=()=>retry(async c=>{await c.selectType('22');return c;},{...config,deadline});
 try{
  client=await open();
  // BAKANLIK (999) bir il değildir ve plaka ile aranamaz.
  const options=client.options('ddlIl').filter(([id])=>/^\d+$/.test(id)&&Number(id)>=1&&Number(id)<=81);
  const provinces=validateOptions(options,'İl');
  if(provinces.length!==81)throw new Error('MEB il listesi 81 il içermiyor; mevcut dosya değiştirilmedi.');
  for(const province of provinces){
   let lastError;
   for(let attempt=0;attempt<2;attempt++){
    try{
     if(!client)client=await open();
     await client.selectProvince(province.id);
     province.districts=validateOptions(client.options('ddlIlce'),`${province.name} ilçe`);
     lastError=null;break;
    }catch(error){lastError=error;client?.close();client=null;log.warn('locations.province_retry',error,{province_id:province.id,attempt:attempt+1});}
   }
   if(lastError)throw log.wrap(`${province.name} ilçeleri alınamadı; mevcut dosya değiştirilmedi.`,lastError,{stage:'locations.collect'});
  }
  return{version:2,source:SOURCE,retrievedAt:new Date().toISOString(),note:'İl ve ilçe seçenekleri sorgunun yapıldığı MEB sayfasından alınmıştır. İl kimlikleri plaka kodudur. MEB oturumunda kimlikler adla yeniden doğrulanır. BAKANLIK (999) il olmadığı için dahil edilmez.',provinces};
 }finally{client?.close();}
}
async function saveLocations(data,file=path.join(__dirname,'locations.json')){
 const tmp=`${file}.${process.pid}.tmp`;
 try{await fs.writeFile(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx'});await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function main(){
 require('dotenv').config({path:path.join(__dirname,'.env'),quiet:true});
 const useProxy=(process.env.USE_PROXY??'1')==='1',file=process.env.PROXY_FILE??'proxies.txt';
 const pool=useProxy?new ProxyPool({file:file?path.resolve(__dirname,file):null,url:process.env.PROXY_LIST_URL||'',scheme:process.env.PROXY_SCHEME||'http'}):null;
 const started=Date.now();
 const data=await collectLocations({pool,direct:process.env.DIRECT_FALLBACK==='1',directFirst:process.env.DIRECT_FIRST==='1'});
 await saveLocations(data);
 log.info('locations.updated','MEB il/ilçe listesi kaydedildi',{province_count:data.provinces.length,district_count:data.provinces.reduce((n,p)=>n+p.districts.length,0),duration_ms:Date.now()-started});
}
if(require.main===module)main().catch(error=>{log.error('locations.failed',error);process.exitCode=1;});
module.exports={SOURCE,validateOptions,collectLocations,saveLocations};
