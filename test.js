// 권한 흐름 점검: node test.js
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os'), path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `fb-test-${process.pid}.json`);
// Firebase 환경변수가 있으면 실제 Firebase의 테스트용 위치에서 실행하고 끝나면 지움
Object.assign(process.env, { DATA_FILE, BOARD_KEY: `fbtest-${process.pid}` });
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: 3999 } });
const U = 'http://localhost:3999';
const post = (r, body, cookie) => fetch(`${U}/api?r=${r}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookie || '' }, body: JSON.stringify(body) });
const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];

(async () => {
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    assert.equal((await fetch(U + '/api?r=state')).status, 401, '미등록 기기는 데이터 못 봄');
    const parent = cookieOf(await post('setup', { pin: '1234', name: '엄마 폰' }));
    assert.equal((await post('setup', { pin: '9999', name: 'x' })).status, 409, '두 번째 설정 불가');
    assert.equal((await post('register', { pin: '0000', name: 't', role: 'family' })).status, 403, '틀린 PIN 거부');
    const tab = cookieOf(await post('register', { pin: '1234', name: '태블릿', role: 'family' }));

    const s = await (await fetch(U + '/api?r=state', { headers: { cookie: tab } })).json();
    assert.equal(s.devices, undefined, '가족 기기에는 기기 목록 숨김');
    const kid = s.kids[0];
    assert.equal((await post('action', { type: 'addTask', kidId: kid.id, text: '양치' }, tab)).status, 403, '가족 기기 설정 불가');
    assert.equal((await post('action', { type: 'addTask', kidId: kid.id, text: '양치' }, parent)).status, 200);
    assert.equal((await post('action', { type: 'addMemo', text: '<b>hi</b>', who: '첫째' }, tab)).status, 200, '가족 기기 메모 가능');
    const s2 = await (await fetch(U + '/api?r=state', { headers: { cookie: parent } })).json();
    assert.equal((await post('action', { type: 'delMemo', id: s2.memos[0].id }, tab)).status, 403, '가족 기기 삭제 불가');
    assert.equal((await post('action', { type: 'toggle', kidId: kid.id, taskId: s2.kids[0].tasks[0].id, date: '2026-11-22' }, tab)).status, 200);
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

    // PIN 변경
    assert.equal((await act(tab, 'changePin', { current: '1234', pin: '5678' })).status, 403, '가족 기기는 PIN 변경 불가');
    assert.equal((await act(parent, 'changePin', { current: '0000', pin: '5678' })).status, 403, '현재 PIN이 틀리면 거부');
    assert.equal((await act(parent, 'changePin', { current: '1234', pin: '5678' })).status, 200);
    assert.equal((await post('register', { pin: '1234', name: 't', role: 'family' })).status, 403, '예전 PIN은 더 이상 안 됨');
    assert.equal((await post('register', { pin: '5678', name: 't2', role: 'family' })).status, 200, '새 PIN으로 등록');

    // 버전: 바뀔 때만 달라짐
    const v1 = (await (await fetch(U + '/api?r=ver')).json()).v;
    assert.equal((await (await fetch(U + '/api?r=ver')).json()).v, v1);
    await act(tab, 'addMemo', { text: 'v', who: 'x' });
    assert.notEqual((await (await fetch(U + '/api?r=ver')).json()).v, v1, '저장하면 버전이 바뀜');

    const tabId = s2.devices.find((d) => d.name === '태블릿').id;
    await post('action', { type: 'delDevice', id: tabId }, parent);
    assert.equal((await fetch(U + '/api?r=state', { headers: { cookie: tab } })).status, 401, '해제된 기기 차단');
    for (let i = 0; i < 5; i++) await post('register', { pin: '0001', name: 't', role: 'family' });
    assert.equal((await post('register', { pin: '5678', name: 't', role: 'family' })).status, 429, 'PIN 5회 실패 시 잠금');
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
