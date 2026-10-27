'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const log=require('../logger');
function capture(level='debug'){const lines=[];return{lines,logger:log.createLogger({level,sink:line=>lines.push(line)})};}
test('Logger hides registered token, proxy password and encoded credentials',()=>{
 const token='123456789:FakeTokenForTestsOnly_98765',pass='test:p@ssword';
 log.registerSecret(token);log.registerProxy(`http://testProxyUser:${encodeURIComponent(pass)}@192.0.2.1:8080`);
 const result=log.redact(`${token} testProxyUser ${pass} ${encodeURIComponent(pass)} http://testProxyUser:${encodeURIComponent(pass)}@192.0.2.1:8080`);
 for(const secret of [token,'testProxyUser',pass,encodeURIComponent(pass)])assert.ok(!result.includes(secret));
 assert.match(result,/192\.0\.2\.1/);
});
test('Logger removes private download paths, queries, raw proxy auth and headers',()=>{
 const text=log.redact('https://proxy.example.invalid/api/private-download-XYZ/?key=privateQuery https://api.telegram.org/bot123:fake/getUpdates 192.0.2.1:8080:rawuser:rawpassword\nCookie: session=privateCookie\nAuthorization: Bearer privateBearer');
 for(const secret of ['private-download-XYZ','privateQuery','rawuser','rawpassword','privateCookie','privateBearer','bot123:fake'])assert.ok(!text.includes(secret));
});
test('Logger retains code, HTTP status, stage, original cause and file line',()=>{
 const {lines,logger}=capture();
 const cause=Object.assign(new Error('Connection refused'),{code:'ECONNREFUSED',response:{status:407,data:'PRIVATE_RESPONSE'},config:{headers:{secret:'PRIVATE_CONFIG'}}});
 logger.error('school.failed',log.wrap('District failed',cause,{stage:'district'}),{chat_id:12,duration_ms:55});
 const line=lines.join('');assert.match(line,/ERROR \[school.failed\]/);assert.match(line,/stage=district/);assert.match(line,/ECONNREFUSED/);assert.match(line,/HTTP=407/);assert.match(line,/logger.test.js:\d+/);assert.match(line,/hint=/);assert.match(line,/cause\[1\]/);
 assert.ok(!line.includes('PRIVATE_RESPONSE'));assert.ok(!line.includes('PRIVATE_CONFIG'));
});
test('Logger preserves aggregate contender failures',()=>{
 const {lines,logger}=capture();logger.error('race.failed',new AggregateError([new Error('primary failed'),new Error('backup failed')],'both failed'));
 assert.match(lines[0],/primary failed/);assert.match(lines[0],/backup failed/);
});
test('Logger filters debug at info level',()=>{
 const {lines,logger}=capture('info');logger.debug('hidden','hidden');logger.info('visible','visible');assert.equal(lines.length,1);assert.match(lines[0],/INFO/);
});
test('Concurrent async log contexts do not mix users or trace IDs',async()=>{
 const {lines,logger}=capture();await Promise.all(['one','two'].map((trace,i)=>logger.withContext({trace_id:trace,chat_id:i+1},async()=>{await new Promise(r=>setTimeout(r,3-i));logger.info('done',trace);})));assert.equal(lines.length,2);
 for(const [trace,chat] of [['one',1],['two',2]]){const line=lines.find(x=>x.includes(`trace_id="${trace}"`));assert.ok(line);assert.ok(line.includes(`chat_id=${chat}`));}
});
test('Logger ignores nested arbitrary context and masks sensitive keys',()=>{
 const {lines,logger}=capture();logger.info('safe','ok',{token:'fakeTokenNotLogged',password:'fakePassNotLogged',request:{body:'privateBody'},normal:'yes\nforged'});
 assert.ok(!lines[0].includes('fakeTokenNotLogged'));assert.ok(!lines[0].includes('fakePassNotLogged'));assert.ok(!lines[0].includes('privateBody'));assert.equal(lines[0].split('\n').filter(Boolean).length,1);
});
test('Logger emits Istanbul timestamp with seconds and actionable timeout hint',()=>{
 const {lines,logger}=capture();logger.warn('request.timeout',Object.assign(new Error('Timed out'),{code:'ETIMEDOUT'}));assert.match(lines[0],/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+03:00 WARN/);assert.match(lines[0],/hint=.*süresi doldu/);
});
test('Telegram transport errors retain original cause without exposing request objects',async t=>{
 const {TelegramAPI}=require('../telegram');const original=Object.assign(new Error('network failed'),{cause:Object.assign(new Error('DNS failed'),{code:'ENOTFOUND'})});
 t.mock.method(globalThis,'fetch',async()=>{throw original;});const api=new TelegramAPI('123:fakeTransportTest');await assert.rejects(api.call('getMe'),error=>error.cause===original);api.stop();
});
test('MEB retry retains underlying error and stage',async()=>{
 const {retry}=require('../eokul');const original=Object.assign(new Error('test network refused'),{code:'ECONNREFUSED'});
 await assert.rejects(retry(async()=>{throw original;},{makeClient:()=>({stage:'district',close(){}})}),error=>error.cause.cause===original&&error.cause.stage==='district');
});
test('Expired retry reports TIMEOUT rather than this.stage TypeError',async()=>{
 const {retry}=require('../eokul');await assert.rejects(retry(async()=>{}, {deadline:Date.now()-1}),error=>error.cause.code==='TIMEOUT');
});
test('Startup config failure exposes reason and source without starting network',()=>{
 const result=spawnSync(process.execPath,['bot.js'],{cwd:path.join(__dirname,'..'),encoding:'utf8',env:{...process.env,BOT_TOKEN:'BURAYA',USE_PROXY:'0',LOG_LEVEL:'info'}});
 assert.equal(result.status,1);assert.match(result.stderr,/startup.failed/);assert.match(result.stderr,/BOT_TOKEN/);assert.match(result.stderr,/config.js:\d+/);assert.match(result.stderr,/hint=/);
});
