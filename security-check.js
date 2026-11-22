// 권한 점검: node security-check.js
// 가짜 가족 데이터로 임시 서버(다른 포트, 임시 파일)를 켜서, 등록 안 된 기기·태블릿·흉내 낸 요청이 막히는지 확인. 실제 데이터는 건드리지 않음.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const DATA_FILE = path.join(os.tmpdir(), `fb-sec-${process.pid}.json`), PORT = 3998, U = `http://localhost:${PORT}`;
const env = { ...process.env, DATA_FILE, PORT };
delete env.FIREBASE_DB_URL; delete env.FIREBASE_SERVICE_ACCOUNT; delete env.VERCEL;
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env });
let logs = ''; srv.stdout.on('data', (d) => logs += d); srv.stderr.on('data', (d) => logs += d);

const PIN = '2580', SECRET = 'webcal://calendar.invalid/private-secret-abc123/basic.ics';
const req = (r, { body, cookie = '', method = body ? 'POST' : 'GET', headers = {} } = {}) => fetch(`${U}/api?r=${r}`,
  { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body && JSON.stringify(body) });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const rows = []; let bad = 0;
const check = (name, ok, note = '') => { rows.push(`${ok ? '✅' : '❌'} ${name}${note ? ` (${note})` : ''}`); if (!ok) bad++; };

(async () => {
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    // 가짜 가족 데이터 만들기
    check('처음 설정: 너무 쉬운 PIN(1234) 거부', (await req('setup', { body: { pin: '1234', name: 'x' } })).status === 400);
    const s1 = await req('setup', { body: { pin: PIN, name: 'Fake Mom phone' } });
    const parent = cookieOf(s1);
    check('부모 기기 쿠키: HttpOnly + SameSite=Strict', /HttpOnly/.test(s1.headers.get('set-cookie')) && /SameSite=Strict/.test(s1.headers.get('set-cookie')));
    const tab = cookieOf(await req('register', { body: { pin: PIN, name: 'Fake tablet', role: 'family' } }));
    const act = (cookie, type, data = {}) => req('action', { cookie, body: { type, ...data } });
    const st = async (cookie) => (await req('state', { cookie })).json();
    const kid = (await st(parent)).kids[0].id;
    await act(parent, 'setMe', { member: 'mom' });
    await act(parent, 'addEvent', { title: 'Fake dentist', date: '2030-01-02', time: '10:00', who: 'Kid 1' });
    await act(parent, 'addMemo', { text: 'Fake memo', who: 'Mom' });
    await act(parent, 'sendMail', { to: [kid], text: 'Fake mail' });
    await act(parent, 'addNote', { to: [kid], text: 'Fake note', start: '2030-01-01', end: '2030-01-05' });
    await act(parent, 'saveClass', { kid, name: 'Fake piano', days: [1], time: '15:00', memo: 'Room 1' });
    await act(parent, 'setPlace', { name: 'Fake town', lat: 1, lon: 2 });
    await act(parent, 'setCal', { url: SECRET });

    // 1) 등록 안 된 기기
    const none = await req('state');
    check('등록 안 된 기기: 가족 기록 읽기 막힘', none.status === 401, `HTTP ${none.status}`);
    const fake = 'fb=' + 'a'.repeat(64);
    check('가짜 쿠키: 가족 기록 읽기 막힘', (await req('state', { cookie: fake })).status === 401);
    const me = await (await req('me')).json(), ver = await (await req('ver')).json();
    check('로그인 전 공개 정보는 "설정됨" 여부와 버전 번호뿐', JSON.stringify(Object.keys(me)) === '["setup","device"]' && me.device === null && JSON.stringify(Object.keys(ver)) === '["v"]');
    const types = Object.keys(require('./api').actions);
    let open = [];
    for (const type of types) if ((await act('', type, { id: 'x' })).status !== 401) open.push(type);
    check(`등록 안 된 기기: 동작 ${types.length}개 모두 막힘`, !open.length, open.join(','));
    open = [];
    for (const type of types) if ((await act(fake, type, { id: 'x' })).status !== 401) open.push(type);
    check('가짜 쿠키: 동작 모두 막힘', !open.length, open.join(','));
    check('GET으로 동작 부르기 안 됨', (await req('action', { cookie: parent, method: 'GET' })).status === 404);
    check('두 번째 처음 설정(부모 PIN 덮어쓰기) 막힘', (await req('setup', { body: { pin: '4826', name: 'evil' } })).status === 409);

    // 2) 태블릿(가족 기기)이 부모 기능 흉내
    const parentOnly = types.filter((t) => require('./api').actions[t].parent);
    open = [];
    for (const type of parentOnly) if ((await act(tab, type, { id: 'x', kidId: kid, kid, role: 'parent', current: PIN, pin: '4826', url: SECRET, member: 'mom' })).status !== 403) open.push(type);
    check(`태블릿: 부모 기능 ${parentOnly.length}개 모두 막힘 (PIN을 같이 보내도)`, !open.length, open.join(','));
    const ts = await (await req('state', { cookie: tab })).text();
    check('태블릿에는 기기 목록·알림키 안 보냄', !('devices' in JSON.parse(ts)) && !('vapid' in JSON.parse(ts)));
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const ps = await (await req('state', { cookie: parent })).text();
    check('PIN 해시·실패 기록·초대·기기 토큰은 어떤 화면에도 안 보냄', [ts, ps].every((x) => !x.includes(raw.pin.hash) && !x.includes(raw.pin.salt) && !x.includes('tokenHash') && !x.includes('"fails"')));
    check('비공개 iCal 주소는 부모 화면에도 안 보냄', [ts, ps].every((x) => !x.includes('private-secret-abc123')));

    // 3) 부모 기기 / PIN
    check('부모 기기 링크 만들기: PIN 없으면 거부', (await act(parent, 'invite', { role: 'parent' })).status === 403);
    check('PIN 바꾸기: 너무 쉬운 PIN 거부', (await act(parent, 'changePin', { current: PIN, pin: '0000' })).status === 400);
    check('틀린 PIN으로 부모 기기 등록 거부', (await req('register', { body: { pin: '1111', name: 'x', role: 'parent' } })).status === 403);
    for (let i = 0; i < 4; i++) await req('register', { body: { pin: '1111', name: 'x', role: 'parent' } });
    check('틀린 PIN 5번이면 잠금 (맞는 PIN도 5분간 거부)', (await req('register', { body: { pin: PIN, name: 'x', role: 'parent' } })).status === 429);
    const spoof = await req('register', { body: { pin: PIN, name: 'x', role: 'parent' }, headers: { 'X-Forwarded-For': '203.0.113.' + Date.now() % 250, 'X-Real-IP': '198.51.100.7' } });
    check('IP 헤더를 흉내 내도 잠금 그대로', spoof.status === 429, `HTTP ${spoof.status}`);
    const { locked, fail } = require('./api')._auth, db = {};
    for (let i = 0; i < 20; i++) fail(db, '10.0.0.' + i);
    check('IP를 바꿔 가며 틀려도 모두 합쳐 20번이면 전체 잠금', locked(db, '10.9.9.9'));

    // 4) 기록·파일
    check('데이터 파일에 PIN이 그대로 저장되지 않음 (scrypt 해시)', !fs.readFileSync(DATA_FILE, 'utf8').includes(`"${PIN}"`));
    check('서버 로그에 PIN·iCal 주소 없음', !logs.includes(PIN) && !logs.includes('private-secret'));
    const leaks = [];
    for (const p of ['/data.json', '/server.js', '/api/index.js', '/.env', '/../data.json', '/%2e%2e/server.js', '/test.js'])
      if ((await fetch(U + p)).status !== 404) leaks.push(p);
    check('서버 파일·데이터 파일은 주소로 못 받음', !leaks.length, leaks.join(','));
  } finally {
    srv.kill();
    fs.rmSync(DATA_FILE, { force: true });
  }
  console.log(rows.join('\n') + `\n\n${bad ? `❌ ${bad}개 실패` : '✅ 모두 통과'} (${rows.length}개 점검)`);
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { srv.kill(); fs.rmSync(DATA_FILE, { force: true }); console.error(e); process.exitCode = 1; });
