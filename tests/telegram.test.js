'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TelegramAPI,TelegramError}=require('../telegram');
test('Telegram call sends JSON and returns result',async t=>{
 t.mock.method(globalThis,'fetch',async(_url,config)=>{assert.equal(config.method,'POST');assert.ok(config.signal);assert.equal(JSON.parse(config.body).chat_id,1);return{json:async()=>({ok:true,result:{message_id:5}})};});
 const api=new TelegramAPI('123:TEST');assert.deepEqual(await api.call('sendMessage',{chat_id:1,text:'Test'}),{message_id:5});api.stop();
});
test('Transport errors hide bot token and request URL',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('SECRET-TOKEN-IN-ORIGINAL-ERROR');});
 const api=new TelegramAPI('123:SECRET');await assert.rejects(api.call('getMe'),e=>e.code===0&&!e.message.includes('SECRET'));api.stop();
});
test('Telegram errors retain status code and retry information',async t=>{
 t.mock.method(globalThis,'fetch',async()=>({json:async()=>({ok:false,error_code:429,description:'Too Many Requests',parameters:{retry_after:5}})}));
 const api=new TelegramAPI('123:TEST');await assert.rejects(api.call('sendMessage'),e=>e instanceof TelegramError&&e.code===429&&e.parameters.retry_after===5);api.stop();
});
test('Webshare download source supports authenticated returned entries',async t=>{
 const {ProxyPool}=require('../proxies');let requested;
 t.mock.method(globalThis,'fetch',async(url,opts)=>{requested=url;assert.ok(opts.signal);return{ok:true,text:async()=>'192.0.2.1:8080:u:p'};});
 const pool=new ProxyPool({url:'https://example.invalid/private-test'});assert.equal(await pool.pick(),'http://u:p@192.0.2.1:8080');assert.equal(requested,'https://example.invalid/private-test');
});
