'use strict';
const { DatabaseSync } = require('node:sqlite');
const now = () => Math.floor(Date.now() / 1000);
class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS subs(
        chat_id INTEGER NOT NULL, okul_id TEXT NOT NULL, sinif TEXT NOT NULL,
        mode TEXT NOT NULL, tur TEXT NOT NULL, il TEXT NOT NULL, ilce TEXT NOT NULL,
        okul_ad TEXT NOT NULL, il_ad TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id,okul_id,sinif));
      CREATE INDEX IF NOT EXISTS idx_subs_okul ON subs(okul_id);
      CREATE TABLE IF NOT EXISTS snaps(okul_id TEXT PRIMARY KEY,data TEXT NOT NULL,
        checked_at INTEGER NOT NULL,changed_at INTEGER,fail_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS lists(key TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages(chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(chat_id,message_id));`);
    const cols = this.all('PRAGMA table_info(subs)').map(r => r.name);
    if (!cols.includes('user_id')) this.db.exec('ALTER TABLE subs ADD COLUMN user_id INTEGER');
    if (!cols.includes('user_name')) this.db.exec('ALTER TABLE subs ADD COLUMN user_name TEXT');
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args).map(r => ({...r})); }
  get(sql, ...args) { const row = this.db.prepare(sql).get(...args); return row ? {...row} : null; }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  addSub(s) {
    this.run(`INSERT INTO subs(chat_id,okul_id,sinif,mode,tur,il,ilce,okul_ad,il_ad,created_at,user_id,user_name)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,okul_id,sinif) DO UPDATE SET
      mode=excluded.mode,user_id=excluded.user_id,user_name=excluded.user_name`,
      s.chat_id,s.okul_id,s.sinif,s.mode,s.tur,s.il,s.ilce,s.okul_ad,s.il_ad,now(),s.user_id??null,s.user_name??null);
  }
  saveSchoolSub(sub,limit) {
    // Okul başına tek ayar: silme/ekleme atomiktir. Kontenjan snapshot'ı silinmez.
    const normalize=value=>{
      if(value==='all')return 'all';
      const grades=[...new Set(String(value).split(','))].sort((a,b)=>Number(a)-Number(b));
      if(!grades.length||grades.some(g=>!['9','10','11','12'].includes(g)))throw new Error('Geçersiz sınıf seçimi');
      return grades.length===4?'all':grades.join(',');
    };
    const sinif=normalize(sub.sinif),next={...sub,sinif};
    if(!['up','down','both'].includes(next.mode))throw new Error('Geçersiz bildirim tercihi');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.all('SELECT * FROM subs WHERE chat_id=? AND okul_id=?',sub.chat_id,sub.okul_id);
      if(previous.length===1&&normalize(previous[0].sinif)===sinif&&previous[0].mode===next.mode){
        this.db.exec('COMMIT');return {action:'already',sinif};
      }
      if(!previous.length&&this.countSubs(sub.chat_id)>=limit){
        this.db.exec('COMMIT');return {action:'limit',sinif};
      }
      this.run('DELETE FROM subs WHERE chat_id=? AND okul_id=?',sub.chat_id,sub.okul_id);
      this.addSub(next);
      this.db.exec('COMMIT');return {action:previous.length?'updated':'added',sinif};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  listSubs(chat) { return this.all('SELECT * FROM subs WHERE chat_id=? ORDER BY created_at', chat); }
  subsForSchool(id) { return this.all('SELECT * FROM subs WHERE okul_id=?',id); }
  hasSub(chat,id,grade) { return !!this.get('SELECT 1 FROM subs WHERE chat_id=? AND okul_id=? AND sinif=?',chat,id,grade); }
  countSubs(chat) { return this.get('SELECT COUNT(*) AS n FROM subs WHERE chat_id=?',chat).n; }
  deleteSub(chat,id,grade) { this.run('DELETE FROM subs WHERE chat_id=? AND okul_id=? AND sinif=?',chat,id,grade); this.prune(); }
  deleteChat(chat) { this.run('DELETE FROM subs WHERE chat_id=?',chat); this.prune(); }
  prune() { this.run('DELETE FROM snaps WHERE okul_id NOT IN (SELECT DISTINCT okul_id FROM subs)'); }
  groups() {
    const map = new Map();
    for (const r of this.all('SELECT tur,il,okul_id,MIN(ilce) AS ilce FROM subs GROUP BY tur,il,okul_id')) {
      const key = `${r.tur}:${r.il}`;
      if (!map.has(key)) map.set(key,{tur:r.tur,il:r.il,schools:[]});
      map.get(key).schools.push([r.okul_id,r.ilce]);
    }
    return [...map.values()];
  }
  getSnap(id) { const row = this.get('SELECT * FROM snaps WHERE okul_id=?',id); return row ? {...row,data:JSON.parse(row.data)} : null; }
  saveSnap(id,data,changed=false) {
    const t = now();
    this.run(`INSERT INTO snaps(okul_id,data,checked_at,changed_at,fail_count) VALUES(?,?,?,?,0)
      ON CONFLICT(okul_id) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at,
      changed_at=CASE WHEN ? THEN excluded.checked_at ELSE snaps.changed_at END,fail_count=0`,
      id,JSON.stringify(data),t,changed?t:null,changed?1:0);
  }
  bumpFail(id) { this.run('UPDATE snaps SET fail_count=fail_count+1 WHERE okul_id=?',id); }
  getList(key) { const row=this.get('SELECT * FROM lists WHERE key=?',key); return row?{...row,data:JSON.parse(row.data)}:null; }
  putList(key,data) { this.run(`INSERT INTO lists(key,data,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,key,JSON.stringify(data),now()); }
  remember(chat,id,user) {
    this.run('DELETE FROM chat_messages WHERE created_at<?',now()-48*3600);
    this.run('INSERT OR IGNORE INTO chat_messages VALUES(?,?,?,?)',chat,id,user,now());
  }
  messages(chat,user) { return this.all('SELECT message_id FROM chat_messages WHERE chat_id=? AND user_id=? ORDER BY message_id',chat,user).map(r=>r.message_id); }
  forget(chat,ids) {
    this.db.exec('BEGIN');
    try { for (const id of ids) this.run('DELETE FROM chat_messages WHERE chat_id=? AND message_id=?',chat,id); this.db.exec('COMMIT'); }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { if(!this.closed){this.db.close();this.closed=true;} }
}
module.exports = { Store, now };
