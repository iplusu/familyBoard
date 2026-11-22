// 가족 대시보드 API — Vercel 함수(/api) 겸 로컬 server.js 가 쓰는 핸들러. Node 내장 모듈만 사용.
// 라우팅: /api?r=ver|me|setup|register|state|action   오류는 코드로 응답(화면에서 번역)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const id = () => crypto.randomBytes(6).toString('hex');
// 데이터 구조 버전. 구조를 바꿀 때마다 올리고 norm()에 변환을 추가 → 서버가 원본을 먼저 백업한 뒤 변환해서 저장
const SCHEMA = 2; // 1: 처음 ~ 2: 루틴 시간대·적립금·학원·외부 달력
const fresh = () => ({
  schema: SCHEMA,
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
  classes: [], // 학원 { id, kid, name, days: [0-6], time, memo, prep, start, end, off: [date], makeup: [{ date, time }] }
  cal: null, // 외부 달력 { url(비공개, 화면에 안 보냄), events, at, err }
  board: [], // 게시판 { id, from, to: [kidId], text, start, end, alarm, doneBy: {kid: ts}, seenBy: {kid: ts}, at, doneAt }
});
const SLOTS = ['am', 'pm', 'eve'], REWARD = 100; // 하루 루틴 모두 완료 보상: 100센트 = $1 // 루틴 시간대: 아침, 방과후, 저녁
const norm = (db) => { // 예전 데이터에 새 항목 채우기
  db.mail ||= []; db.board ||= []; db.classes ||= []; db.cal ??= null;
  for (const k of db.kids) { k.cents ??= 0; k.rewardOn ??= null; for (const t of k.tasks) t.slot ||= 'am'; }
  return db;
};

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
    const db = data ? JSON.parse(data) : fresh();
    return { ver: r.headers.get('etag'), raw: data, schema: db.schema || 1, db: norm(db) };
  },
  async backup(raw, tag) { await fb('PUT', {}, JSON.stringify(raw), `${KEY}_backup_${tag}`); }, // 원본 문자열 그대로
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
      try { const raw = fs.readFileSync(file, 'utf8'), db = JSON.parse(raw); return { ver, raw, schema: db.schema || 1, db: norm(db) }; } catch (e) {
        if (e.code !== 'ENOENT') throw e; // 파일이 깨졌으면 덮어쓰지 않고 오류
        return { ver, db: fresh(), schema: SCHEMA };
      }
    },
    async backup(raw, tag) { fs.writeFileSync(`${file}.backup-${tag}.json`, raw, { flag: 'wx' }); }, // 이미 있으면 덮어쓰지 않음
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
// 틀린 PIN: 한 곳(IP)에서 5번, 또는 모든 곳 합쳐 20번 틀리면 5분 잠금 (IP를 바꿔 가며 맞히기 방지)
const hot = (f, max) => f && f.n >= max && Date.now() - f.t < LOCK_MS;
const locked = (db, ip) => hot(db.fails?.[ip], 5) || hot(db.fails?.['*'], 20);
function fail(db, ip) {
  db.fails ||= {};
  for (const k in db.fails) if (Date.now() - db.fails[k].t > LOCK_MS) delete db.fails[k];
  for (const k of [ip, '*']) { const f = (db.fails[k] ||= { n: 0 }); f.n++; f.t = Date.now(); }
}
// 너무 쉬운 PIN 거부: 같은 숫자 반복(0000), 연속(1234, 9876)
function newPin(v) {
  const p = match(v, /^\d{4,8}$/), d = [...p].map(Number), step = d[1] - d[0];
  if (Math.abs(step) <= 1 && d.every((x, i) => !i || x - d[i - 1] === step)) throw 'weak_pin';
  return p;
}
// 요청한 기기의 IP: Vercel에서는 플랫폼이 넣는 값만, PC 서버에서는 실제 연결 주소만 (헤더 흉내 무시)
const clientIp = (req) => (process.env.VERCEL && String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || '?';

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
const opt = (v, max) => v == null || v === '' ? '' : str(v, max); // 비워도 되는 글
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
  toggle: { run(db, b) {
    const k = find(db.kids, b.kidId), t = find(k.tasks, b.taskId), d = match(b.date, DATE);
    t.doneOn = t.doneOn === d ? null : d;
    // 보상: 그날 루틴을 모두 끝내면 $1, 같은 날 체크를 풀면 다시 빼기
    const all = k.tasks.every((x) => x.doneOn === d);
    if (all && k.rewardOn !== d) { k.cents += REWARD; k.rewardOn = d; }
    else if (!all && k.rewardOn === d) { k.cents -= REWARD; k.rewardOn = null; }
  } },
  setDeposit: { parent: true, run(db, b) {
    const n = Number(b.amount); if (!Number.isFinite(n) || n < 0 || n > 100000) throw 400;
    find(db.kids, b.kidId).cents = Math.round(n * 100);
  } },
  addEvent: { run(db, b) {
    const old = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
    db.events = db.events.filter((e) => e.date >= old); // 지난 일정 정리
    if (db.events.length >= 100) throw 400;
    db.events.push({ id: id(), date: match(b.date, DATE), time: b.time ? match(b.time, TIME) : '', title: str(b.title, 60), who: str(b.who, 20), prep: opt(b.prep, 60) });
  } },
  addMemo: { run(db, b) { db.memos.unshift({ id: id(), text: str(b.text, 200), who: str(b.who, 20), at: Date.now() }); db.memos.length = Math.min(db.memos.length, 30); } },
  delEvent: { parent: true, run(db, b) { db.events = db.events.filter((e) => e.id !== b.id); } },
  delMemo: { parent: true, run(db, b) { db.memos = db.memos.filter((m) => m.id !== b.id); } },
  saveKid: { parent: true, run(db, b) { const k = find(db.kids, b.id); k.name = str(b.name, 12); k.emoji = str(b.emoji, 8); k.color = match(b.color, /^#[0-9a-fA-F]{6}$/); } },
  addTask: { parent: true, run(db, b) {
    const k = find(db.kids, b.kidId), slot = pick(b.slot, SLOTS);
    if (k.tasks.filter((t) => t.slot === slot).length >= 8) throw 400;
    k.tasks.push({ id: id(), text: str(b.text, 30), slot, doneOn: null });
  } },
  editTask: { parent: true, run(db, b) { const t = find(find(db.kids, b.kidId).tasks, b.taskId); t.text = str(b.text, 30); } },
  delTask: { parent: true, run(db, b) { const k = find(db.kids, b.kidId); k.tasks = k.tasks.filter((t) => t.id !== b.taskId); } },
  invite: { parent: true, needPin: (b) => b.role !== 'family', run(db, b) { // 새 기기 추가: 15분 동안 한 번만 쓰는 등록 링크. 부모 기기 링크는 PIN을 한 번 더 확인
    const code = crypto.randomBytes(16).toString('hex');
    db.invites = (db.invites || []).filter((i) => i.exp > Date.now()).slice(-4);
    db.invites.push({ hash: sha(code), role: pick(b.role, ['parent', 'family']), exp: Date.now() + 15 * 60e3 });
    return { reply: { code } };
  } },
  // 기기 관리: 부모 기기가 하나도 안 남게 되는 삭제·변경은 막음 (잠김 방지)
  delDevice: { parent: true, run(db, b) {
    const d = find(db.devices, b.id);
    if (d.role === 'parent' && db.devices.filter((x) => x.role === 'parent').length === 1) throw 'last_parent';
    db.devices = db.devices.filter((x) => x !== d);
  } },
  editDevice: { parent: true, needPin: (b) => b.role === 'parent', run(db, b) { // 부모 기기로 바꿀 때는 PIN 확인
    const d = find(db.devices, b.id), role = pick(b.role, ['parent', 'family']);
    if (d.role === 'parent' && role === 'family' && db.devices.filter((x) => x.role === 'parent').length === 1) throw 'last_parent';
    d.name = str(b.name, 20);
    if (role !== d.role) { d.role = role; delete d.member; delete d.push; } // 역할이 바뀌면 엄마/아빠·알림은 다시 설정
  } },
  changePin: { parent: true, needPin: true, run(db, b) { setPin(db, newPin(b.pin)); } },

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
  // 학원: 요일·시간·메모·준비물·기간, 휴강·보강
  saveClass: { parent: true, run(db, b) {
    const days = [...new Set(Array.isArray(b.days) ? b.days.map(Number) : [])];
    if (!days.length || days.some((d) => !(d >= 0 && d <= 6))) throw 400;
    const start = b.start ? match(b.start, DATE) : '', end = b.end ? match(b.end, DATE) : '';
    if (start && end && end < start) throw 400;
    const c = { kid: pick(b.kid, kidIds(db)), name: str(b.name, 30), days: days.sort(), time: match(b.time, TIME),
      memo: opt(b.memo, 60), prep: opt(b.prep, 60), start, end };
    if (b.id) return void Object.assign(find(db.classes, b.id), c);
    if (db.classes.length >= 30) throw 400;
    db.classes.push({ id: id(), ...c, off: [], makeup: [] });
  } },
  delClass: { parent: true, run(db, b) { db.classes = db.classes.filter((c) => c.id !== b.id); } },
  classOff: { parent: true, run(db, b) { // 휴강 표시 / 취소
    const c = find(db.classes, b.id), d = match(b.date, DATE);
    c.off = c.off.includes(d) ? c.off.filter((x) => x !== d) : [...c.off, d].slice(-60);
  } },
  addMakeup: { parent: true, run(db, b) {
    const c = find(db.classes, b.id), m = { date: match(b.date, DATE), time: match(b.time, TIME) };
    if (c.makeup.length >= 30) throw 400;
    c.makeup.push(m);
  } },
  delMakeup: { parent: true, run(db, b) { const c = find(db.classes, b.id); c.makeup = c.makeup.filter((m) => !(m.date === b.date && m.time === b.time)); } },
  // 외부 달력: 비공개 iCal 주소는 서버에만 저장
  setCal: { parent: true, run(db, b) {
    if (!b.url) { db.cal = null; return; }
    let u; try { u = new URL(str(b.url, 2000).trim().replace(/^webcal:/i, 'https:')); } catch { throw 400; }
    if (u.protocol !== 'https:' || /^(localhost|[\d.]+|\[.*\])$/i.test(u.hostname)) throw 400;
    db.cal = { url: u.href, events: [], at: 0, err: null };
    return { calSync: true };
  } },
  setPlace: { parent: true, run(db, b) { // 날씨 위치 (동네 수준으로 반올림)
    if (!b.name) { db.place = null; return; }
    const lat = Number(b.lat), lon = Number(b.lon);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw 400;
    db.place = { name: str(b.name, 40), lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, unit: pick(b.unit || 'C', ['C', 'F']) };
  } },
  delNote: { parent: true, run(db, b) { db.board = db.board.filter((n) => n.id !== b.id); } },
};

// ---------- 외부 달력 (iCal) ----------
// ponytail: 반복 일정은 DAILY/WEEKLY(BYDAY)/MONTHLY(같은 날짜)/YEARLY + INTERVAL·UNTIL·COUNT·EXDATE·수정된 회차만. "매월 둘째 화요일" 같은 규칙은 첫 회만 보임
const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const icsUnesc = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').slice(0, 80);
function icsTime(v) { // 20261122 | 20261122T150000 | 20261122T150000Z  → 시각(UTC 기준 계산용), Z 여부
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d))?/.exec(v || ''); if (!m) return null;
  return { t: Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)), allDay: !m[4], z: v.endsWith('Z') };
}
function* icsOccur(ev, horizon) {
  const r = ev.rrule, s = ev.start.t;
  if (!r) return yield s;
  const iv = +r.INTERVAL || 1, until = icsTime(r.UNTIL)?.t ?? Infinity, count = +r.COUNT || Infinity, D = 864e5;
  const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => ICS_DAYS.indexOf(x.slice(-2))).filter((x) => x >= 0).sort() : null;
  let n = 0;
  for (let k = 0; k < 3000; k++) {
    let c;
    const d = new Date(s);
    if (r.FREQ === 'DAILY') c = [s + k * iv * D];
    else if (r.FREQ === 'WEEKLY') { const w = s - d.getUTCDay() * D + k * iv * 7 * D; c = (byday || [d.getUTCDay()]).map((x) => w + x * D).filter((x) => x >= s); }
    else if (r.FREQ === 'MONTHLY') { const x = new Date(s); x.setUTCMonth(d.getUTCMonth() + k * iv); c = x.getUTCDate() === d.getUTCDate() ? [+x] : []; }
    else if (r.FREQ === 'YEARLY') { const x = new Date(s); x.setUTCFullYear(d.getUTCFullYear() + k * iv); c = [+x]; }
    else return yield s;
    for (const t of c) { if (t > until || ++n > count) return; yield t; }
    if (s + k * iv * D > horizon) return;
  }
}
function parseICS(text) {
  const evs = [];
  let ev = null;
  for (const l of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (l === 'BEGIN:VEVENT') ev = { ex: [] };
    else if (l === 'END:VEVENT') { if (ev?.start) evs.push(ev); ev = null; }
    else if (ev) {
      const i = l.indexOf(':'); if (i < 0) continue;
      const name = l.slice(0, i).split(';')[0], v = l.slice(i + 1);
      if (name === 'DTSTART') ev.start = icsTime(v);
      else if (name === 'SUMMARY') ev.title = icsUnesc(v);
      else if (name === 'LOCATION') ev.loc = icsUnesc(v);
      else if (name === 'UID') ev.uid = v;
      else if (name === 'RRULE') ev.rrule = Object.fromEntries(v.split(';').map((p) => p.split('=')));
      else if (name === 'EXDATE') ev.ex.push(...v.split(',').map((x) => icsTime(x)?.t));
      else if (name === 'RECURRENCE-ID') ev.rid = icsTime(v)?.t;
      else if (name === 'STATUS') ev.cancelled = v === 'CANCELLED';
    }
  }
  const moved = new Map(); // 따로 수정된 회차는 원래 반복에서 빼기
  for (const e of evs) if (e.rid != null) moved.set(e.uid, [...(moved.get(e.uid) || []), e.rid]);
  const from = Date.now() - 40 * DAY, to = Date.now() + 130 * DAY, out = [];
  for (const e of evs) {
    if (e.cancelled) continue;
    const skip = new Set([...e.ex, ...(e.rid == null ? moved.get(e.uid) || [] : [])]);
    for (const t of icsOccur(e, to)) {
      if (t < from || t > to || skip.has(t)) continue;
      const iso = new Date(t).toISOString();
      // Z 시각은 화면(가족 기기의 시간대)에서 바꿔서 보여 줌. 나머지는 적힌 그대로
      out.push({ title: e.title || '', loc: e.loc || '', ...(e.start.z ? { at: t } : { date: iso.slice(0, 10), time: e.start.allDay ? '' : iso.slice(11, 16) }) });
      if (out.length >= 400) break;
    }
  }
  return out.sort((a, b) => (a.at ?? Date.parse(a.date)) - (b.at ?? Date.parse(b.date)));
}
async function fetchCal(url) { // 오류에도 주소가 남지 않게 코드만 돌려줌 (로그 없음)
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(8000) }); } catch { throw 'cal_fetch'; }
  if (!r.ok) throw 'cal_fetch';
  const text = await r.text();
  if (text.length > 3e6) throw 'cal_big';
  if (!text.includes('BEGIN:VCALENDAR')) throw 'cal_format';
  return parseICS(text);
}

function view(db, me) {
  const { kids, events, memos, mail, board, classes, cal } = db;
  const out = { me: { name: me.name, role: me.role, member: me.member || null, push: !!me.push, lang: me.lang || 'en' }, kids, events, memos, mail, board, classes,
    place: db.place || null,
    cal: cal ? { on: true, at: cal.at, err: cal.err, events: cal.events } : { on: false } }; // 주소(url)는 절대 보내지 않음
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
module.exports.parseICS = parseICS;
module.exports.actions = actions;
module.exports.norm = norm;
module.exports.SCHEMA = SCHEMA;
module.exports._auth = { locked, fail, clientIp };
async function handler(req, res) {
  if (!store) return send(res, 500, { error: 'no_db' });
  const ip = clientIp(req);
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
    if (snap.schema < SCHEMA) { // 예전 구조: 원본을 그대로 백업한 다음에만 변환본을 저장
      const tag = `v${snap.schema}-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
      await store.backup(snap.raw, tag).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      await mutate((db) => { db.schema = SCHEMA; });
      console.log(`data converted v${snap.schema} -> v${SCHEMA}, backup ${tag}`);
    }
    const me = device(snap.db, req);

    if (r === 'me') return send(res, 200, { setup: !!snap.db.pin, device: me ? { name: me.name, role: me.role } : null });

    if (post && r === 'setup') { // 첫 실행: 부모 PIN 만들기 + 이 기기를 부모 기기로 등록
      const b = await body(req);
      const pin = newPin(b.pin), name = str(b.name, 20);
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
      const name = str(b.name, 20);
      if (b.join) { // 등록 링크: 맞으면 바로 지우고(한 번만) 링크에 정해진 역할로 등록
        let ok = false;
        await mutate((db) => {
          const inv = (db.invites || []).find((i) => i.hash === sha(String(b.join)) && i.exp > Date.now());
          if (!(ok = !!inv)) return fail(db, ip);
          db.invites = db.invites.filter((i) => i !== inv);
          if (db.fails) delete db.fails[ip];
          issue(db, req, res, name, inv.role);
        });
        if (!ok) { res.removeHeader('Set-Cookie'); return send(res, 403, { error: 'bad_link' }); }
        return send(res, 200, { ok: true });
      }
      const role = pick(b.role, ['parent', 'family']);
      if (!pinOk(snap.db, b.pin)) { await mutate((db) => fail(db, ip)); return send(res, 403, { error: 'wrong_pin' }); }
      await mutate((db) => { if (db.fails) delete db.fails[ip]; issue(db, req, res, name, role); });
      return send(res, 200, { ok: true });
    }

    // 여기부터는 등록된 기기만
    if (!me) return send(res, 401, { error: 'unregistered' });

    if (r === 'state') return send(res, 200, view(snap.db, me));

    // 외부 달력 새로 읽기: 30분에 한 번까지 (부모가 "지금"을 누르면 바로)
    const syncCal = async () => {
      const url = snap.db.cal?.url; if (!url) return;
      let events = null, err = null;
      try { events = await fetchCal(url); } catch (e) { err = typeof e === 'string' ? e : 'cal_fetch'; }
      await mutate((db) => { if (db.cal?.url !== url) return; Object.assign(db.cal, { at: Date.now(), err }, events && { events }); });
    };
    if (post && r === 'calsync') {
      const b = await body(req), c = snap.db.cal;
      if (c && ((b.now && me.role === 'parent') || Date.now() - c.at > 30 * 60e3)) await syncCal();
      return send(res, 200, { ok: true });
    }

    if (post && r === 'action') {
      const b = await body(req);
      const a = actions[b.type];
      if (!a) throw 400;
      if (a.parent && me.role !== 'parent') return send(res, 403, { error: 'parent_only' });
      if (a.needPin === true || a.needPin?.(b)) { // 현재 PIN 확인 (틀리면 등록과 같은 잠금 규칙)
        if (locked(snap.db, ip)) return send(res, 429, { error: 'locked' });
        if (!pinOk(snap.db, b.current)) { await mutate((db) => fail(db, ip)); return send(res, 403, { error: 'wrong_pin' }); }
      }
      const out = await mutate((db) => a.run(db, b, me));
      if (out?.calSync) await syncCal();
      if (out?.notify?.length) { // 부모 폰에 알림. 없어진 구독(404/410)은 정리
        const targets = snap.db.devices.filter((d) => d.push && out.notify.includes(d.member));
        const gone = [];
        await Promise.all(targets.map((d) => webpush(snap.db.vapid, d.push, `https://${req.headers.host}`)
          .then((s) => { if (s === 404 || s === 410) gone.push(d.id); }, (e) => console.error('push', e.message))));
        if (gone.length) await mutate((db) => db.devices.forEach((d) => { if (gone.includes(d.id)) delete d.push; }));
      }
      return send(res, 200, { ok: true, ...out?.reply });
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (typeof e === 'number') return send(res, e, { error: e === 409 ? 'conflict' : 'bad_request' });
    if (typeof e === 'string') return send(res, 400, { error: e });
    console.error(e?.stack || e); // 요청 내용(PIN 등)은 기록하지 않음
    send(res, 500, { error: 'server_error' });
  }
}
