'use strict';
// Statik menü veri seti: MEB'e il/ilçe menüsü için istek gönderilmez.
const data=require('./locations.json');
const provinces=new Map();
for(const p of data.provinces) {
  if(provinces.has(p.id))throw new Error('Tekrarlanan yerel il kimliği');
  provinces.set(p.id,p);
}
if(provinces.size!==81)throw new Error('Yerel il veri seti eksik');
const sort=(a,b)=>a[1].localeCompare(b[1],'tr');
function provinceOptions(){return [...provinces.values()].map(p=>[p.id,`${p.name.toLocaleUpperCase('tr-TR')} (${p.id.padStart(2,'0')})`]).sort(sort);}
function districtOptions(id){return (provinces.get(String(id))?.districts||[]).map(d=>[d.id,d.name.toLocaleUpperCase('tr-TR')]).sort(sort);}
module.exports={provinceOptions,districtOptions};
