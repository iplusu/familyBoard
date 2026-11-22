// 가족 대시보드 API — Vercel 함수(/api) 겸 로컬 server.js 가 쓰는 핸들러. Node 내장 모듈만 사용.
// 라우팅: /api?r=ver|me|setup|register|state|action   오류는 코드로 응답(화면에서 번역)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const id = () => crypto.randomBytes(6).toString('hex');
const fresh = () => ({
  pin: null, // { salt, hash }
  devices: [], // { id, tokenHash, name, role: 'parent'|'family', created, member?: 'mom'|'dad', push?: url, lang? }
  fails: {}, // ip -> { n, t }  PIN 실패 횟수
  kids: [
    { id: id(), name: 'Kid 1', emoji: '🦊', color: '#ff8a3d', tasks: [] },
    { id: id(), name: 'Kid 2', emoji: '🐰', color: '#4fa3ff', tasks: [] },
  ],
  events: [], // { id, date, time, title, who }
  memos: [], // { id, text, who, at }
  mail: [], // 우체통 { id, from, to: [member], text, at, readBy: [member], re: id|null }
  board: [], // 게시판 { id, from, to: [kidId], text, start, end, alarm, doneBy: {kid: ts}, seenBy: {kid: ts}, at, doneAt }
});
const norm = (db) => { db.mail ||= []; db.board ||= []; return db; }; // 예전 데이터에 새 항목 채우기

// ---------- 저장소: Firebase Realtime Database(무료 Spark 요금제) 환경변수가 있으면 Firebase, 없으면 data.json ----------
// FIREBASE_DB_URL: https://<프로젝트>-default-rtdb.<지역>.firebasedatabase.app
// FIREBASE_SERVICE_ACCOUNT: Firebase 콘솔에서 받은 서비스 계정 키 JSON 전체
const DB_URL = process.env.FIREBASE_DB_URL?.replace(/\/+$/, '');
const SA = process.env.FIREBASE_SERVICE_ACCOUNT && JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const KEY = process.env.BOARD_KEY || 'familyboard';
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

// 서비스 계정으로 Google 액세스 토큰 발급 (JWT RS256 서명), 만료 전까지 재사용
let tok = { value: null, exp: 0 };
async function token() {
  if (Date.now() < tok.exp) return tok.value;
  const now = Math.floor(Date.now() / 1000), aud = SA.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: SA.client_email, aud, iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database' });
  const jwt = unsigned + '.' + crypto.sign('RSA-SHA256', Buffer.from(unsigned), SA.private_key).toString('base64url');
  const r = await fetch(aud, { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('Firebase token: ' + JSON.stringify(j));
  tok = { value: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return tok.value;
}
async function fb(method, headers = {}, body, key = KEY) {
  const r = await fetch(`${DB_URL}/${key}.json`, { method, body, headers: { Authorization: `Bearer ${await token()}`, ...headers } });
  if (!r.ok && r.status !== 412) throw new Error(`Firebase ${method} ${r.status}: ${await r.text()}`);
  return r;
}
// 데이터는 문자열 하나로 저장(Firebase가 빈 배열·null을 지우는 것 방지).
// ETag가 그대로일 때만 저장 → 두 기기가 동시에 고쳐도 한쪽 변경이 사라지지 않음.
// 저장할 때마다 작은 버전 값(KEY_ver)도 바꿔서, 화면은 10초마다 이것만 확인하고 바뀌었을 때만 전체를 받음(무료 다운로드 한도 절약).
const firebaseStore = {
  async ver() { return (await fb('GET', {}, undefined, KEY + '_ver')).json(); },
  async load() {
    const r = await fb('GET', { 'X-Firebase-ETag': 'true' });
    const data = await r.json();
    return { ver: r.headers.get('etag'), db: norm(data ? JSON.parse(data) : fresh()) };
  },
  async cas(ver, db) {
    if (!(await fb('PUT', { 'if-match': ver }, JSON.stringify(JSON.stringify(db)))).ok) return false;
    await fb('PUT', {}, JSON.stringify(id()), KEY + '_ver').catch((e) => console.error(e)); // 실패해도 데이터는 이미 저장됨
    return true;
  },
  async del() { await fb('DELETE'); await fb('DELETE', {}, undefined, KEY + '_ver'); }, // 테스트 정리용
};

function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');
  const boot = id();
  let ver = 0;
  return {
    async ver() { return `${boot}-${ver}`; },
    async load() {
      try { return { ver, db: norm(JSON.parse(fs.readFileSync(file, 'utf8'))) }; } catch (e) {
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
    async del() { fs.rmSync(file, { force: true }); },
  };
}
const store = DB_URL && SA ? firebaseStore : process.env.VERCEL ? null : fileStore();

// ---------- 인증 ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
const pinOk = (db, pin) => crypto.timingSafeEqual(Buffer.from(hashPin(String(pin), db.pin.salt), 'hex'), Buffer.from(db.pin.hash, 'hex'));
const setPin = (db, pin) => { const salt = crypto.randomBytes(16).toString('hex'); db.pin = { salt, hash: hashPin(pin, salt) }; };
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

// ---------- 웹 푸시 (부모 폰 알림) ----------
// 내용 없는 푸시만 보냄(암호화 불필요) → 폰의 sw.js가 받아서 /api?r=state 로 새 쪽지를 읽어 알림을 띄움
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
function ensureVapid(db) {
  if (db.vapid) return;
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  db.vapid = { jwk, pub: pub.toString('base64url') };
}
async function webpush(vapid, endpoint, sub) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64({ typ: 'JWT', alg: 'ES256' }) + '.' + b64({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub });
  const key = crypto.createPrivateKey({ key: vapid.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const r = await fetch(endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', Authorization: `vapid t=${unsigned}.${sig}, k=${vapid.pub}` } });
  return r.status;
}

// ---------- 입력 검증 ----------
const str = (v, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw 400; return v.trim(); };
const pick = (v, list) => { if (!list.includes(v)) throw 400; return v; };
const match = (v, re) => { if (typeof v !== 'string' || !re.test(v)) throw 400; return v; };
const find = (arr, i) => { const x = arr.find((o) => o.id === i); if (!x) throw 404; return x; };
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;
const PARENTS = ['mom', 'dad'];
const kidIds = (db) => db.kids.map((k) => k.id);
const members = (db) => [...PARENTS, ...kidIds(db)];
const list = (v, allowed) => { // 받는 사람 목록: 중복 없이, 허용된 사람만, 1명 이상
  if (!Array.isArray(v) || !v.length || v.length > 10) throw 400;
  return [...new Set(v.map((x) => pick(x, allowed)))];
};
// 이 기기가 누구로서 쓰는지: 부모 기기는 등록한 본인(엄마/아빠), 가족 화면(태블릿)은 고른 아이
function actor(db, me, who) {
  if (me.role !== 'parent') return pick(who, kidIds(db));
  if (!me.member) throw 'need_member';
  return me.member;
}
const DAY = 864e5;
function prune(db) { // 오래된 쪽지·기록 자동 정리
  db.mail = db.mail.filter((m) => Date.now() - m.at < 30 * DAY).slice(0, 60);
  const history = db.board.filter((n) => n.doneAt).sort((a, b) => b.doneAt - a.doneAt);
  const drop = new Set(history.filter((n, i) => i >= 50 || Date.now() - n.doneAt > 30 * DAY).map((n) => n.id));
  db.board = db.board.filter((n) => !drop.has(n.id));
}

// ---------- 동작 (parent: 부모 기기만, needPin: 현재 PIN 확인) ----------
const actions = {
  toggle: { run(db, b) { const t = find(find(db.kids, b.kidId).tasks, b.taskId); const d = match(b.date, DATE); t.doneOn = t.doneOn === d ? null : d; } },
  addEvent: { run(db, b) {
    const old = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
    db.events = db.events.filter((e) => e.date >= old); // 지난 일정 정리
    if (db.events.length >= 100) throw 400;
    db.events.push({ id: id(), date: match(b.date, DATE), time: b.time ? match(b.time, TIME) : '', title: str(b.title, 60), who: str(b.who, 20) });
  } },
  addMemo: { run(db, b) { db.memos.unshift({ id: id(), text: str(b.text, 200), who: str(b.who, 20), at: Date.now() }); db.memos.length = Math.min(db.memos.length, 30); } },
  delEvent: { parent: true, run(db, b) { db.events = db.events.filter((e) => e.id !== b.id); } },
  delMemo: { parent: true, run(db, b) { db.memos = db.memos.filter((m) => m.id !== b.id); } },
  saveKid: { parent: true, run(db, b) { const k = find(db.kids, b.id); k.name = str(b.name, 12); k.emoji = str(b.emoji, 8); k.color = match(b.color, /^#[0-9a-fA-F]{6}$/); } },
  addTask: { parent: true, run(db, b) { const k = find(db.kids, b.kidId); if (k.tasks.length >= 8) throw 400; k.tasks.push({ id: id(), text: str(b.text, 30), doneOn: null }); } },
  delTask: { parent: true, run(db, b) { const k = find(db.kids, b.kidId); k.tasks = k.tasks.filter((t) => t.id !== b.taskId); } },
  delDevice: { parent: true, run(db, b, me) { if (b.id === me.id) throw 400; db.devices = db.devices.filter((d) => d.id !== b.id); } },
  changePin: { parent: true, needPin: true, run(db, b) { setPin(db, match(b.pin, /^\d{4,8}$/)); } },

  // 부모 기기 주인(엄마/아빠) 정하기, 알림 등록
  setMe: { parent: true, run(db, b, me) { find(db.devices, me.id).member = pick(b.member, PARENTS); ensureVapid(db); } },
  subscribe: { parent: true, run(db, b, me) {
    let u; try { u = new URL(str(b.endpoint, 1000)); } catch { throw 400; }
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) throw 400;
    Object.assign(find(db.devices, me.id), { push: u.href, lang: pick(b.lang, ['en', 'ko']) });
  } },

  // 우체통
  sendMail: { run(db, b, me) {
    const from = actor(db, me, b.from);
    const to = list(b.to, members(db).filter((m) => m !== from));
    const re = b.re ? find(db.mail, b.re).id : null;
    db.mail.unshift({ id: id(), from, to, text: str(b.text, 100), at: Date.now(), readBy: [], re });
    prune(db);
    return { notify: to.filter((m) => PARENTS.includes(m)) }; // 부모에게는 폰 알림
  } },
  readMail: { run(db, b, me) {
    const who = actor(db, me, b.who);
    for (const m of db.mail) if (m.to.includes(who) && !m.readBy.includes(who)) m.readBy.push(who);
  } },
  delMail: { parent: true, run(db, b) { db.mail = db.mail.filter((m) => m.id !== b.id); } },

  // 게시판: 아이들이 스스로 할 일. 받는 아이가 각자 "했어요"를 누를 때까지 남음
  addNote: { parent: true, run(db, b, me) {
    const from = actor(db, me), start = match(b.start, DATE), end = match(b.end, DATE);
    if (end < start) throw 400;
    if (db.board.filter((n) => !n.doneAt).length >= 30) throw 400;
    db.board.unshift({ id: id(), from, to: list(b.to, kidIds(db)), text: str(b.text, 200), start, end,
      alarm: b.alarm ? match(b.alarm, TIME) : '', doneBy: {}, seenBy: {}, at: Date.now(), doneAt: null });
  } },
  seeNote: { run(db, b) { const n = find(db.board, b.id); n.seenBy[pick(b.kid, n.to)] ||= Date.now(); } },
  doneNote: { run(db, b) { // 누르면 완료, 다시 누르면 취소
    const n = find(db.board, b.id), kid = pick(b.kid, n.to);
    if (n.doneBy[kid]) delete n.doneBy[kid]; else n.doneBy[kid] = Date.now();
    n.doneAt = n.to.every((k) => n.doneBy[k]) ? Date.now() : null; // 모두 끝내면 기록으로
    prune(db);
  } },
  delNote: { parent: true, run(db, b) { db.board = db.board.filter((n) => n.id !== b.id); } },
};

function view(db, me) {
  const { kids, events, memos, mail, board } = db;
  const out = { me: { name: me.name, role: me.role, member: me.member || null, push: !!me.push, lang: me.lang || 'en' }, kids, events, memos, mail, board };
  if (me.role === 'parent') {
    out.devices = db.devices.map(({ id, name, role, created, member }) => ({ id, name, role, created, member, me: id === me.id }));
    out.vapid = db.vapid?.pub;
  }
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

module.exports = handler;
module.exports.store = store;
async function handler(req, res) {
  if (!store) return send(res, 500, { error: 'no_db' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress).split(',')[0].trim();
  const r = new URL(req.url, 'http://x').searchParams.get('r');
  const post = req.method === 'POST';
  try {
    if (r === 'ver') return send(res, 200, { v: await store.ver() }); // 바뀐 게 있는지만 (개인 정보 없음)

    let snap = await store.load();
    // 스냅샷에 변경을 적용하고 저장; 그 사이 다른 기기가 바꿨으면 다시 읽어서 재시도. fn의 결과를 돌려줌
    const mutate = async (fn) => {
      for (let i = 0; i < 10; i++) {
        if (i) { await new Promise((ok) => setTimeout(ok, Math.random() * 40 * i)); snap = await store.load(); }
        const out = fn(snap.db);
        if (await store.cas(snap.ver, snap.db)) return out;
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
        setPin(db, pin);
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
      if (a.needPin) { // 현재 PIN 확인 (틀리면 등록과 같은 잠금 규칙)
        if (locked(snap.db, ip)) return send(res, 429, { error: 'locked' });
        if (!pinOk(snap.db, b.current)) { await mutate((db) => fail(db, ip)); return send(res, 403, { error: 'wrong_pin' }); }
      }
      const out = await mutate((db) => a.run(db, b, me));
      if (out?.notify?.length) { // 부모 폰에 알림. 없어진 구독(404/410)은 정리
        const targets = snap.db.devices.filter((d) => d.push && out.notify.includes(d.member));
        const gone = [];
        await Promise.all(targets.map((d) => webpush(snap.db.vapid, d.push, `https://${req.headers.host}`)
          .then((s) => { if (s === 404 || s === 410) gone.push(d.id); }, (e) => console.error('push', e.message))));
        if (gone.length) await mutate((db) => db.devices.forEach((d) => { if (gone.includes(d.id)) delete d.push; }));
      }
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (typeof e === 'number') return send(res, e, { error: e === 409 ? 'conflict' : 'bad_request' });
    if (typeof e === 'string') return send(res, 400, { error: e });
    console.error(e);
    send(res, 500, { error: 'server_error' });
  }
}
