'use strict';
const {sleep}=require('./utils');
const log=require('./logger');
class TelegramError extends Error {
  constructor(code,description,parameters={},cause) {super(description,cause?{cause}:undefined);this.name='TelegramError';this.code=code;this.parameters=parameters;}
}
class TelegramAPI {
  constructor(token) {log.registerSecret(token);this.token=token;this.stopController=new AbortController();}
  async call(method,params={},timeout=20000) {
    let data;
    try {
      const res=await fetch(`https://api.telegram.org/bot${this.token}/${method}`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params),
        signal:AbortSignal.any([this.stopController.signal,AbortSignal.timeout(timeout)])});
      data=await res.json();
    } catch(error) {throw new TelegramError(0,'Telegram bağlantısı kesildi (token gizlendi).',{},error);}
    if(!data.ok) throw new TelegramError(data.error_code||0,String(data.description||'Telegram hatası'),data.parameters);
    return data.result;
  }
  async safe(method,params={},timeout=20000) {
    for(let i=0;i<3;i++) {
      try{return await this.call(method,params,timeout);}
      catch(e){if(e.code===429&&i<2){log.warn('telegram.rate_limit',e,{method,retry_after_s:e.parameters.retry_after||1,attempt:i+1});await sleep(((e.parameters.retry_after||1)+1)*1000);}else throw e;}
    }
  }
  stop() { this.stopController.abort(); }
}
module.exports={TelegramAPI,TelegramError};
