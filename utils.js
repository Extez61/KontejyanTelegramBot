'use strict';
const sleep = ms => new Promise(r => setTimeout(r,ms));
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const norm = s => String(s).replace(/[İIıÖöÜüÇçŞşĞğ]/g,c=>({'İ':'i',I:'i','ı':'i','Ö':'o','ö':'o','Ü':'u','ü':'u','Ç':'c','ç':'c','Ş':'s','ş':'s','Ğ':'g','ğ':'g'}[c])).toLowerCase().trim();
const cleanSchool = s => String(s).replace(/\s*\(\d+\)/g,'').trim();
const classText = s => s==='all'?'tüm sınıflar':s.split(',').map(c=>`${c}. sınıf`).join(', ');
const modeText = s => ({up:'artınca',down:'azalınca',both:'artınca ve azalınca'}[s]);
const timeText = ts => new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(ts*1000);
function quota(data,selected='all',html=true) {
  if (!data || !Object.keys(data).length) return 'Listelenen boş kontenjan kaydı yok (kontenjan 0 sayılır).';
  const lines=[];
  for(const [key,values] of Object.entries(data)) {
    const parts=Object.entries(values).sort((a,b)=>Number(a[0])-Number(b[0])).filter(([s])=>selected==='all'||selected.split(',').includes(s))
      .map(([s,v])=>`${s}. sınıf: ${html?`<b>${v}</b>`:v}`);
    if(parts.length) lines.push(`• ${key==='Genel'?'':`${html?esc(key):key}\n   `}${parts.join(' · ')}`);
  }
  return lines.join('\n')||'Seçilen sınıflar için kayıt bulunamadı.';
}
function splitText(text,limit=3800) {
  const chunks=[];
  while(text.length>limit) {
    let cut=text.lastIndexOf('\n',limit); if(cut<=0) cut=limit;
    // Telegram UTF-16 sınırı; surrogate çiftini ortadan bölme.
    if(cut>0 && /[\uD800-\uDBFF]/.test(text[cut-1])) cut--;
    chunks.push(text.slice(0,cut)); text=text.slice(cut).replace(/^\n+/, '');
  }
  if(text) chunks.push(text); return chunks;
}
class Semaphore {
  constructor(max) { this.max=max; this.active=0; this.wait=[]; }
  async run(fn) {
    if(this.active>=this.max) await new Promise(r=>this.wait.push(r)); else this.active++;
    try { return await fn(); } finally { const next=this.wait.shift(); if(next) next(); else this.active--; }
  }
}
function toggleClass(selected,value) {
  const set=new Set(selected);
  if(value==='all') return set.has('all')?[]:['all'];
  set.delete('all'); set.has(value)?set.delete(value):set.add(value);
  return [...set].sort((a,b)=>Number(a)-Number(b));
}
function matchingChanges(sub,changes) {
  return changes.filter(([,grade,a,b])=>(sub.sinif==='all'||sub.sinif.split(',').includes(grade)) &&
    !(b>a&&sub.mode==='down') && !(b<a&&sub.mode==='up'));
}
module.exports={sleep,esc,norm,cleanSchool,classText,modeText,timeText,quota,splitText,Semaphore,toggleClass,matchingChanges};
