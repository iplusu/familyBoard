// 권한 흐름 점검: node test.js
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os'), path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `fb-test-${process.pid}.json`);
// 실제 가족 데이터는 절대 건드리지 않음: Firebase 설정을 지우고 임시 파일 + 다른 포트로만 시험
delete process.env.FIREBASE_DB_URL; delete process.env.FIREBASE_SERVICE_ACCOUNT;
Object.assign(process.env, { DATA_FILE, BOARD_KEY: `fbtest-${process.pid}` });
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: 3999 } });
const U = 'http://localhost:3999';
const post = (r, body, cookie) => fetch(`${U}/api?r=${r}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookie || '' }, body: JSON.stringify(body) });
const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];

(async () => {
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    assert.equal((await fetch(U + '/api?r=state')).status, 401, '미등록 기기는 데이터 못 봄');
    const parent = cookieOf(await post('setup', { pin: '2580', name: '엄마 폰' }));
    assert.equal((await post('setup', { pin: '4826', name: 'x' })).status, 409, '두 번째 설정 불가');
    assert.equal((await post('register', { pin: '0000', name: 't', role: 'family' })).status, 403, '틀린 PIN 거부');
    const tab = cookieOf(await post('register', { pin: '2580', name: '태블릿', role: 'family' }));

    const s = await (await fetch(U + '/api?r=state', { headers: { cookie: tab } })).json();
    assert.equal(s.devices, undefined, '가족 기기에는 기기 목록 숨김');
    const kid = s.kids[0];
    assert.equal((await post('action', { type: 'addTask', kidId: kid.id, text: '양치', slot: 'am' }, tab)).status, 403, '가족 기기 설정 불가');
    assert.equal((await post('action', { type: 'addTask', kidId: kid.id, text: '양치', slot: 'noon' }, parent)).status, 400, '시간대 검증');
    assert.equal((await post('action', { type: 'addTask', kidId: kid.id, text: '양치', slot: 'am' }, parent)).status, 200);
    await post('action', { type: 'addTask', kidId: kid.id, text: '숙제', slot: 'pm' }, parent);
    assert.equal((await post('action', { type: 'addMemo', text: '<b>hi</b>', who: '첫째' }, tab)).status, 200, '가족 기기 메모 가능');
    const s2 = await (await fetch(U + '/api?r=state', { headers: { cookie: parent } })).json();
    assert.equal((await post('action', { type: 'delMemo', id: s2.memos[0].id }, tab)).status, 403, '가족 기기 삭제 불가');
    assert.equal((await post('action', { type: 'toggle', kidId: kid.id, taskId: s2.kids[0].tasks[0].id, date: '2026-11-22' }, tab)).status, 200);
    const t0 = s2.kids[0].tasks[0];
    assert.equal((await post('action', { type: 'editTask', kidId: kid.id, taskId: t0.id, text: '이 닦기' }, tab)).status, 403, '루틴 수정은 부모만');
    await post('action', { type: 'editTask', kidId: kid.id, taskId: t0.id, text: '이 닦기' }, parent);
    const rt = (await (await fetch(U + '/api?r=state', { headers: { cookie: parent } })).json()).kids[0].tasks;
    assert.deepEqual(rt.map((x) => [x.text, x.slot, x.doneOn]), [['이 닦기', 'am', '2026-11-22'], ['숙제', 'pm', null]], '수정·시간대·체크 유지');
    // 보상: 하루 루틴 모두 끝내면 $1, 체크를 풀면 다시 빠짐, 부모만 수정
    const tog = (taskId) => post('action', { type: 'toggle', kidId: kid.id, taskId, date: '2026-11-22' }, tab);
    const cents = async () => (await (await fetch(U + '/api?r=state', { headers: { cookie: tab } })).json()).kids[0].cents;
    await tog(rt[1].id); assert.equal(await cents(), 100, '모두 끝내면 $1');
    await tog(rt[1].id); assert.equal(await cents(), 0, '체크를 풀면 빠짐');
    await tog(rt[1].id); await tog(rt[1].id); await tog(rt[1].id); assert.equal(await cents(), 100, '하루에 한 번만');
    assert.equal((await post('action', { type: 'setDeposit', kidId: kid.id, amount: 5 }, tab)).status, 403, '적립금 수정은 부모만');
    assert.equal((await post('action', { type: 'setDeposit', kidId: kid.id, amount: -1 }, parent)).status, 400, '음수 거부');
    await post('action', { type: 'setDeposit', kidId: kid.id, amount: '12.5' }, parent); assert.equal(await cents(), 1250);
    assert.equal((await post('action', { type: 'saveKid', id: kid.id, name: 'a', emoji: 'b', color: 'red;}' }, parent)).status, 400, '색 값 검증');

    // 우체통
    const act = (cookie, type, data) => post('action', { type, ...data }, cookie);
    const state = async (cookie) => (await fetch(U + '/api?r=state', { headers: { cookie } })).json();
    const k1 = kid.id, k2 = s.kids[1].id;
    assert.equal((await act(parent, 'sendMail', { to: [k1], text: 'hi' })).status, 400, '부모 기기는 먼저 엄마/아빠를 정해야 함');
    assert.equal((await act(tab, 'setMe', { member: 'mom' })).status, 403, '가족 기기는 setMe 불가');
    assert.equal((await act(parent, 'setMe', { member: 'mom' })).status, 200);
    assert.equal((await act(tab, 'sendMail', { from: 'mom', to: ['dad'], text: 'x' })).status, 400, '태블릿은 엄마 이름으로 못 보냄');
    assert.equal((await act(tab, 'sendMail', { from: k1, to: [k1], text: 'x' })).status, 400, '자기 자신에게는 못 보냄');
    assert.equal((await act(tab, 'sendMail', { from: k1, to: ['mom', 'dad'], text: '배고파요' })).status, 200);
    let m = (await state(parent)).mail[0];
    assert.deepEqual([m.from, m.to, m.readBy], [k1, ['mom', 'dad'], []]);
    await act(parent, 'readMail', {});
    await act(parent, 'sendMail', { to: [k1], text: '알았어', re: m.id });
    const sm = await state(tab);
    assert.deepEqual(sm.mail[1].readBy, ['mom'], '엄마가 읽은 표시가 태블릿에도 보임');
    assert.deepEqual([sm.mail[0].from, sm.mail[0].re], ['mom', m.id], '답장');
    assert.equal((await act(parent, 'subscribe', { endpoint: 'http://evil.example/x', lang: 'en' })).status, 400, '알림 주소는 푸시 서비스만');
    assert.ok((await state(parent)).vapid, '알림 공개키 발급됨');

    // 게시판
    assert.equal((await act(tab, 'addNote', { to: [k1], text: 'x', start: '2026-11-22', end: '2026-11-30' })).status, 403, '쪽지 붙이기는 부모만');
    assert.equal((await act(parent, 'addNote', { to: [k1], text: 'x', start: '2026-11-30', end: '2026-11-22' })).status, 400, '마감이 시작보다 빠르면 거부');
    assert.equal((await act(parent, 'addNote', { to: [k1, k2], text: '방 정리', start: '2026-11-22', end: '2026-11-30', alarm: '19:00' })).status, 200);
    let n = (await state(tab)).board[0];
    await act(tab, 'seeNote', { id: n.id, kid: k1 });
    await act(tab, 'doneNote', { id: n.id, kid: k1 });
    n = (await state(tab)).board[0];
    assert.ok(n.seenBy[k1] && n.doneBy[k1] && !n.doneAt, '한 명만 끝내면 아직 남아 있음');
    await act(tab, 'doneNote', { id: n.id, kid: k2 });
    assert.ok((await state(tab)).board[0].doneAt, '모두 끝내면 기록으로');
    assert.equal((await act(tab, 'doneNote', { id: n.id, kid: 'nobody' })).status, 400, '받는 아이만 체크 가능');

    // 학원: 부모만, 요일 필요, 휴강·보강
    assert.equal((await act(tab, 'saveClass', { kid: k1, name: '피아노', days: [1], time: '15:30' })).status, 403, '학원 등록은 부모만');
    assert.equal((await act(parent, 'saveClass', { kid: k1, name: '피아노', days: [], time: '15:30' })).status, 400, '요일 필요');
    assert.equal((await act(parent, 'saveClass', { kid: k1, name: '피아노', days: [1, 3], time: '15:30', memo: '302호', start: '2026-12-01', end: '2026-11-01' })).status, 400, '기간 검증');
    assert.equal((await act(parent, 'saveClass', { kid: k1, name: '피아노', days: [1, 3], time: '15:30', memo: '302호', prep: '악보' })).status, 200);
    const cl = (await state(tab)).classes[0];
    await act(parent, 'classOff', { id: cl.id, date: '2026-11-23' });
    await act(parent, 'addMakeup', { id: cl.id, date: '2026-11-28', time: '10:00' });
    await act(parent, 'saveClass', { id: cl.id, kid: k1, name: '피아노', days: [1], time: '16:00', memo: '303호' });
    const cl2 = (await state(tab)).classes[0];
    assert.deepEqual([cl2.off, cl2.makeup, cl2.time, cl2.memo], [['2026-11-23'], [{ date: '2026-11-28', time: '10:00' }], '16:00', '303호'], '수정해도 휴강·보강 유지');
    // 외부 달력: 주소는 어디에도 안 보임
    assert.equal((await act(parent, 'setCal', { url: 'http://x.example/a.ics' })).status, 400, 'https만');
    assert.equal((await act(parent, 'setCal', { url: 'https://127.0.0.1/a.ics' })).status, 400, '내부 주소 거부');
    assert.equal((await act(tab, 'setCal', { url: 'https://x.invalid/a.ics' })).status, 403, '달력 연결은 부모만');
    assert.equal((await act(parent, 'setCal', { url: 'webcal://secret-token.invalid/private.ics' })).status, 200);
    const raw = await (await fetch(U + '/api?r=state', { headers: { cookie: parent } })).text();
    assert.ok(!raw.includes('secret-token') && JSON.parse(raw).cal.on && JSON.parse(raw).cal.err === 'cal_fetch', '비공개 주소는 화면에 안 보냄');
    // 기기 추가 링크: 부모만, 한 번만
    assert.equal((await act(tab, 'invite', { role: 'family' })).status, 403, '링크는 부모만');
    const { code } = await (await act(parent, 'invite', { role: 'family' })).json();
    const j = await post('register', { name: '새 태블릿', join: code });
    assert.equal(j.status, 200, '링크로 등록');
    assert.equal((await state(cookieOf(j))).me.role, 'family');
    assert.equal((await post('register', { name: 'x', join: code })).status, 403, '링크는 한 번만');

    assert.equal((await act(tab, 'setPlace', { name: 'Seoul', lat: 37.5665, lon: 126.978 })).status, 403, '날씨 위치는 부모만');
    assert.equal((await act(parent, 'setPlace', { name: 'x', lat: 99, lon: 0 })).status, 400, '좌표 검증');
    await act(parent, 'setPlace', { name: 'Seoul', lat: 37.5665, lon: 126.978, unit: 'C' });
    assert.deepEqual((await state(tab)).place, { name: 'Seoul', lat: 37.57, lon: 126.98, unit: 'C' }, '동네 수준으로 반올림');

    // PIN 변경
    assert.equal((await act(tab, 'changePin', { current: '2580', pin: '3907' })).status, 403, '가족 기기는 PIN 변경 불가');
    assert.equal((await act(parent, 'changePin', { current: '0000', pin: '3907' })).status, 403, '현재 PIN이 틀리면 거부');
    assert.equal((await act(parent, 'changePin', { current: '2580', pin: '3907' })).status, 200);
    assert.equal((await post('register', { pin: '2580', name: 't', role: 'family' })).status, 403, '예전 PIN은 더 이상 안 됨');
    assert.equal((await post('register', { pin: '3907', name: 't2', role: 'family' })).status, 200, '새 PIN으로 등록');

    // 버전: 바뀔 때만 달라짐
    const v1 = (await (await fetch(U + '/api?r=ver')).json()).v;
    assert.equal((await (await fetch(U + '/api?r=ver')).json()).v, v1);
    await act(tab, 'addMemo', { text: 'v', who: 'x' });
    assert.notEqual((await (await fetch(U + '/api?r=ver')).json()).v, v1, '저장하면 버전이 바뀜');

    const tabId = s2.devices.find((d) => d.name === '태블릿').id;
    // 기기 수정·삭제: 부모 기기는 하나 이상 남아야 함, 부모로 바꾸려면 PIN
    const myId = s2.devices.find((d) => d.me).id;
    assert.equal((await act(parent, 'delDevice', { id: myId })).status, 400, '마지막 부모 기기는 삭제 불가');
    assert.equal((await act(parent, 'editDevice', { id: myId, name: 'x', role: 'family' })).status, 400, '마지막 부모 기기는 가족 기기로 못 바꿈');
    assert.equal((await act(parent, 'editDevice', { id: tabId, name: '거실 태블릿', role: 'parent' })).status, 403, '부모로 바꾸려면 PIN');
    assert.equal((await act(tab, 'editDevice', { id: tabId, name: 'x', role: 'family' })).status, 403, '태블릿은 기기 수정 불가');
    assert.equal((await act(parent, 'editDevice', { id: tabId, name: '거실 태블릿', role: 'family' })).status, 200);
    assert.equal((await state(parent)).devices.find((d) => d.id === tabId).name, '거실 태블릿', '이름 바뀜');
    await post('action', { type: 'delDevice', id: tabId }, parent);
    assert.equal((await fetch(U + '/api?r=state', { headers: { cookie: tab } })).status, 401, '해제된 기기 차단');
    for (let i = 0; i < 5; i++) await post('register', { pin: '0001', name: 't', role: 'family' });
    assert.equal((await post('register', { pin: '3907', name: 't', role: 'family' })).status, 429, 'PIN 5회 실패 시 잠금');
    // 동시에 10개를 써도 하나도 사라지지 않아야 함
    await Promise.all(Array.from({ length: 10 }, (_, i) => post('action', { type: 'addMemo', text: 'm' + i, who: '엄마' }, parent)));
    const s3 = await (await fetch(U + '/api?r=state', { headers: { cookie: parent } })).json();
    assert.equal(s3.memos.filter((m) => /^m\d$/.test(m.text)).length, 10, '동시 저장 시 유실 없음');
    console.log('ok');
  } finally {
    srv.kill();
    await require('./api').store.del();
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
