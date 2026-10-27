'use strict';
const major=Number(process.versions.node.split('.')[0]);
if(major<24){console.error('Node.js 24+ gerekli.');process.exit(1);}
const {Store}=require('./db');
const {EokulClient}=require('./eokul');
const {parseProxies,proxyAgent}=require('./proxies');
const {classKeyboard}=require('./bot');
const db=new Store(':memory:');
db.putList('check',[['ok','test']]);
if(db.getList('check').data[0][0]!=='ok')throw new Error('SQLite testi başarısız');
db.close();
const client=new EokulClient();client.parse('<form id="Form1"><input name="__VIEWSTATE" value="ok"></form>');
if(client.fields().__VIEWSTATE!=='ok')throw new Error('HTML testi başarısız');client.close();
const url=parseProxies('192.0.2.1:8080:testuser:testpass')[0];
proxyAgent(url).destroy();
if(classKeyboard().length!==5)throw new Error('Klavye testi başarısız');
console.log(`Node.js ${process.versions.node}: OK`);
console.log('SQLite, HTML, proxy ve bot modülleri: OK');
console.log('Telegram/MEB ağına bağlantı yapılmadı.');
