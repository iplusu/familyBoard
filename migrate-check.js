// 데이터 변환 미리 해 보기: node migrate-check.js <데이터 사본.json>
// 사본에 변환을 적용해 보고 기존 기록(아이·할 일·일정·메모·쪽지·게시판·기기)이 하나도 바뀌거나 사라지지 않았는지 확인. 파일은 읽기만 함.
// 사본 받기: Firebase 콘솔 → Realtime Database → ⋮ → JSON 내보내기 (또는 PC 서버의 data.json 복사본)
const fs = require('fs');
const { norm, SCHEMA } = require('./api');
const file = process.argv[2];
if (!file) { console.log('사용법: node migrate-check.js <데이터 사본.json>'); process.exit(2); }
let data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (typeof data === 'object' && typeof data.familyboard === 'string') data = data.familyboard; // Firebase 내보내기 파일
if (typeof data === 'string') data = JSON.parse(data);

const before = JSON.parse(JSON.stringify(data)), after = norm(JSON.parse(JSON.stringify(data)));
const problems = [], added = new Set();
(function same(a, b, p) { // a의 모든 값이 b에 그대로 있는지 (새로 생긴 칸은 허용)
  if (a === null || typeof a !== 'object') { if (a !== b) problems.push(`${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`); return; }
  if (Array.isArray(a) !== Array.isArray(b) || b === null || typeof b !== 'object') return problems.push(`${p}: 모양이 바뀜`);
  if (Array.isArray(a) && a.length !== b.length) problems.push(`${p}: ${a.length}개 → ${b.length}개`);
  for (const k of Object.keys(a)) same(a[k], b[k], `${p}.${k}`);
  if (!Array.isArray(a)) for (const k of Object.keys(b)) if (!(k in a)) added.add(`${p.replace(/\.\d+/g, '[]')}.${k}`);
})(before, after, 'data');

const n = (x) => Array.isArray(x) ? x.length : x ? 1 : 0;
console.log(`구조 버전: v${before.schema || 1} → v${SCHEMA}`);
for (const k of ['kids', 'devices', 'events', 'memos', 'mail', 'board', 'classes'])
  console.log(`  ${k.padEnd(8)} ${String(n(before[k])).padStart(4)} → ${n(after[k])}`);
console.log(`  할 일(루틴) ${before.kids?.reduce((s, k) => s + k.tasks.length, 0) ?? 0} → ${after.kids.reduce((s, k) => s + k.tasks.length, 0)}`);
if (added.size) console.log('새로 생기는 칸:', [...added].join(', '));
console.log(problems.length ? `❌ 바뀌거나 사라지는 기록 ${problems.length}개:\n  ` + problems.slice(0, 30).join('\n  ') : '✅ 기존 기록은 모두 그대로예요');
process.exitCode = problems.length ? 1 : 0;
