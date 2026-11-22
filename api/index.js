// 가족 대시보드 API — Vercel 함수(/api) 겸 로컬 server.js 가 쓰는 핸들러. Node 내장 모듈만 사용.
// 라우팅: /api?r=me|setup|register|state|action   오류는 코드로 응답(화면에서 번역)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const id = () => crypto.randomBytes(6).toString('hex');
const fresh = () => ({
  pin: null, // { salt, hash }
  devices: [], // { id, tokenHash, name, role: 'parent'|'family', created }
  fails: {}, // ip -> { n, t }  PIN 실패 횟수
  kids: [
    { id: id(), name: 'Kid 1', emoji: '🦊', color: '#ff8a3d', tasks: [] },
    { id: id(), name: 'Kid 2', emoji: '🐰', color: '#4fa3ff', tasks: [] },
  ],
  events: [], // { id, date, time, title, who }
  memos: [], // { id, text, who, at }
});

// ---------- 저장소: KV(Upstash Redis) 환경변수가 있으면 KV, 없으면 data.json ----------
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = process.env.KV_PREFIX || 'familyboard';

async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (j.error) throw new Error('KV: ' + j.error);
  return j.result;
}
// 읽은 뒤 아무도 안 바꿨을 때만 저장 → 두 기기가 동시에 고쳐도 한쪽 변경이 사라지지 않음
const CAS = "if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then return 0 end " +
  "redis.call('SET', KEYS[2], ARGV[2]) redis.call('INCR', KEYS[1]) return 1";

const kvStore = {
  async load() {
    const [ver, data] = await kv(['MGET', `${KEY}:ver`, `${KEY}:data`]);
    return { ver: ver || '0', db: data ? JSON.parse(data) : fresh() };
  },
  async cas(ver, db) { return (await kv(['EVAL', CAS, '2', `${KEY}:ver`, `${KEY}:data`, ver, JSON.stringify(db)])) === 1; },
};

function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');
  let ver = 0;
  return {
    async load() {
      try { return { ver, db: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) {
        if (e.code !== 'ENOENT') throw e; // 파일이 깨졌으면 덮어쓰지 않고 오류
        return { ver, db: fresh() };
      }
    },
    async cas(v, db) {
      if (v !== ver) return false;
      fs.writeFileSync(file + '.tmp', JSON.stringify(db, null, 2));
      fs.renameSync(file + '.tmp', file); // 원자적 교체
      ver++;
      return true;
    },
  };
}
const store = KV_URL && KV_TOKEN ? kvStore : process.env.VERCEL ? null : fileStore();

// ---------- 인증 ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
const pinOk = (db, pin) => crypto.timingSafeEqual(Buffer.from(hashPin(String(pin), db.pin.salt), 'hex'), Buffer.from(db.pin.hash, 'hex'));
const LOCK_MS = 5 * 60e3;
const locked = (db, ip) => { const f = db.fails?.[ip]; return f && f.n >= 5 && Date.now() - f.t < LOCK_MS; };
function fail(db, ip) {
  db.fails ||= {};
  for (const k in db.fails) if (Date.now() - db.fails[k].t > LOCK_MS) delete db.fails[k];
  const f = (db.fails[ip] ||= { n: 0 });
  f.n++; f.t = Date.now();
}

function device(db, req) {
  const m = /(?:^|;\s*)fb=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m && db.devices.find((d) => d.tokenHash === sha(m[1]));
}
function issue(db, req, res, name, role) {
  const token = crypto.randomBytes(32).toString('hex');
  db.devices.push({ id: id(), tokenHash: sha(token), name, role, created: Date.now() });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `fb=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
}

// ---------- 입력 검증 ----------
const str = (v, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw 400; return v.trim(); };
const pick = (v, list) => { if (!list.includes(v)) throw 400; return v; };
const match = (v, re) => { if (typeof v !== 'string' || !re.test(v)) throw 400; return v; };
const find = (arr, i) => { const x = arr.find((o) => o.id === i); if (!x) throw 404; return x; };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 동작 (parent: true 는 부모 기기만) ----------
const actions = {
  toggle: { run(db, b) { const t = find(find(db.kids, b.kidId).tasks, b.taskId); const d = match(b.date, DATE); t.doneOn = t.doneOn === d ? null : d; } },
  addEvent: { run(db, b) {
    const old = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    db.events = db.events.filter((e) => e.date >= old); // 지난 일정 정리
    if (db.events.length >= 100) throw 400;
    db.events.push({ id: id(), date: match(b.date, DATE), time: b.time ? match(b.time, /^\d{2}:\d{2}$/) : '', title: str(b.title, 60), who: str(b.who, 20) });
  } },
  addMemo: { run(db, b) { db.memos.unshift({ id: id(), text: str(b.text, 200), who: str(b.who, 20), at: Date.now() }); db.memos.length = Math.min(db.memos.length, 30); } },
  delEvent: { parent: true, run(db, b) { db.events = db.events.filter((e) => e.id !== b.id); } },
  delMemo: { parent: true, run(db, b) { db.memos = db.memos.filter((m) => m.id !== b.id); } },
  saveKid: { parent: true, run(db, b) { const k = find(db.kids, b.id); k.name = str(b.name, 12); k.emoji = str(b.emoji, 8); k.color = match(b.color, /^#[0-9a-fA-F]{6}$/); } },
  addTask: { parent: true, run(db, b) { const k = find(db.kids, b.kidId); if (k.tasks.length >= 8) throw 400; k.tasks.push({ id: id(), text: str(b.text, 30), doneOn: null }); } },
  delTask: { parent: true, run(db, b) { const k = find(db.kids, b.kidId); k.tasks = k.tasks.filter((t) => t.id !== b.taskId); } },
  delDevice: { parent: true, run(db, b, me) { if (b.id === me.id) throw 400; db.devices = db.devices.filter((d) => d.id !== b.id); } },
};

function view(db, me) {
  const { kids, events, memos } = db;
  const out = { me: { name: me.name, role: me.role }, kids, events, memos };
  if (me.role === 'parent') out.devices = db.devices.map(({ id, name, role, created }) => ({ id, name, role, created, me: id === me.id }));
  return out;
}

// ---------- HTTP ----------
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
  if (req.body !== undefined) return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}); // Vercel이 미리 파싱한 경우
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 10e3) { no(413); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { no(400); } });
  });
}

module.exports = async function handler(req, res) {
  if (!store) return send(res, 500, { error: 'no_kv' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress).split(',')[0].trim();
  const r = new URL(req.url, 'http://x').searchParams.get('r');
  const post = req.method === 'POST';
  try {
    let snap = await store.load();
    // 스냅샷에 변경을 적용하고 저장; 그 사이 다른 기기가 바꿨으면 다시 읽어서 재시도
    const mutate = async (fn) => {
      for (let i = 0; i < 10; i++) {
        if (i) { await new Promise((ok) => setTimeout(ok, Math.random() * 40 * i)); snap = await store.load(); }
        fn(snap.db);
        if (await store.cas(snap.ver, snap.db)) return;
      }
      throw 409;
    };
    const me = device(snap.db, req);

    if (r === 'me') return send(res, 200, { setup: !!snap.db.pin, device: me ? { name: me.name, role: me.role } : null });

    if (post && r === 'setup') { // 첫 실행: 부모 PIN 만들기 + 이 기기를 부모 기기로 등록
      const b = await body(req);
      const pin = match(b.pin, /^\d{4,8}$/), name = str(b.name, 20);
      let taken = false;
      await mutate((db) => {
        if ((taken = !!db.pin)) return;
        const salt = crypto.randomBytes(16).toString('hex');
        db.pin = { salt, hash: hashPin(pin, salt) };
        issue(db, req, res, name, 'parent');
      });
      if (taken) { res.removeHeader('Set-Cookie'); return send(res, 409, { error: 'already_setup' }); }
      return send(res, 200, { ok: true });
    }

    if (post && r === 'register') { // 새 기기 등록 (부모 PIN 필요)
      if (!snap.db.pin) return send(res, 409, { error: 'setup_first' });
      if (locked(snap.db, ip)) return send(res, 429, { error: 'locked' });
      const b = await body(req);
      const name = str(b.name, 20), role = pick(b.role, ['parent', 'family']);
      if (!pinOk(snap.db, b.pin)) { await mutate((db) => fail(db, ip)); return send(res, 403, { error: 'wrong_pin' }); }
      await mutate((db) => { if (db.fails) delete db.fails[ip]; issue(db, req, res, name, role); });
      return send(res, 200, { ok: true });
    }

    // 여기부터는 등록된 기기만
    if (!me) return send(res, 401, { error: 'unregistered' });

    if (r === 'state') return send(res, 200, view(snap.db, me));

    if (post && r === 'action') {
      const b = await body(req);
      const a = actions[b.type];
      if (!a) throw 400;
      if (a.parent && me.role !== 'parent') return send(res, 403, { error: 'parent_only' });
      await mutate((db) => a.run(db, b, me));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (typeof e === 'number') return send(res, e, { error: e === 409 ? 'conflict' : 'bad_request' });
    console.error(e);
    send(res, 500, { error: 'server_error' });
  }
};
