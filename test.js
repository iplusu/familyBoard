// 권한 흐름 점검: node test.js
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os'), path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `fb-test-${process.pid}.json`);
const KV_PREFIX = `fbtest-${process.pid}`; // KV 환경변수가 있으면 실제 KV의 테스트용 키에서 실행
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: 3999, DATA_FILE, KV_PREFIX } });
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

    const tabId = s2.devices.find((d) => d.name === '태블릿').id;
    await post('action', { type: 'delDevice', id: tabId }, parent);
    assert.equal((await fetch(U + '/api?r=state', { headers: { cookie: tab } })).status, 401, '해제된 기기 차단');
    for (let i = 0; i < 5; i++) await post('register', { pin: '0000', name: 't', role: 'family' });
    assert.equal((await post('register', { pin: '1234', name: 't', role: 'family' })).status, 429, 'PIN 5회 실패 시 잠금');
    // 동시에 10개를 써도 하나도 사라지지 않아야 함
    await Promise.all(Array.from({ length: 10 }, (_, i) => post('action', { type: 'addMemo', text: 'm' + i, who: '엄마' }, parent)));
    const s3 = await (await fetch(U + '/api?r=state', { headers: { cookie: parent } })).json();
    assert.equal(s3.memos.filter((m) => /^m\d$/.test(m.text)).length, 10, '동시 저장 시 유실 없음');
    console.log('ok');
  } finally {
    srv.kill(); require('fs').rmSync(DATA_FILE, { force: true });
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url) await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: JSON.stringify(['DEL', `${KV_PREFIX}:ver`, `${KV_PREFIX}:data`]) });
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
