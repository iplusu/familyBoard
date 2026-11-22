# Family Board

거실 태블릿에 하루 종일 켜 두는 가족 대시보드입니다. 엄마·아빠는 폰 브라우저로 같은 주소에 들어와서 보고 고칩니다.

- 아이별 "오늘 할 일" 체크리스트 (매일 자정에 자동 초기화)
- 다가오는 일정, 가족 메모
- 아이마다 이름·이모지·색 설정
- 영어/한국어 화면 (기본 영어, 기기마다 🌐 버튼으로 전환)
- Node.js 내장 모듈만 사용 — `npm install` 필요 없음

## 권한

| | 등록 안 된 기기 | 가족 화면 기기 | 부모 기기 |
|---|:-:|:-:|:-:|
| 데이터 보기 | ✗ | ✓ | ✓ |
| 할 일 체크, 일정·메모 추가 | ✗ | ✓ | ✓ |
| 설정(아이·할 일·기기 관리), 삭제 | ✗ | ✗ | ✓ |

- 모든 기기는 **부모 PIN**을 입력해서 등록해야 데이터에 접근할 수 있습니다.
- PIN을 5번 틀리면 해당 IP에서 5분 동안 등록이 막힙니다.
- 잃어버린 기기는 부모 기기의 ⚙️ Settings에서 등록을 해제하세요.

## PC에서 실행하기

Node.js 18 이상이 필요합니다.

```bash
node server.js
```

터미널에 나오는 주소로 접속합니다.

- PC: `http://localhost:3000`
- 같은 와이파이의 태블릿·폰: `http://192.168.x.x:3000` (터미널에 표시됨)

로컬에서는 데이터가 프로젝트 폴더의 `data.json`에 저장됩니다. (`.gitignore`에 포함되어 커밋되지 않습니다.)

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 |
| `DATA_FILE` | `./data.json` | 로컬 데이터 파일 위치 |

### 처음 쓸 때

1. 처음 접속한 기기에서 **부모 PIN**(숫자 4~8자리)을 만듭니다. 이 기기는 부모 기기가 됩니다.
2. 태블릿에서 같은 주소로 접속 → PIN 입력 → **Family screen**으로 등록합니다.
3. 엄마·아빠 폰도 PIN 입력 → **Parent device**로 등록합니다.
4. 부모 기기의 ⚙️ Settings에서 아이 이름·이모지·색과 매일 할 일(아이당 최대 8개)을 정합니다.

### 테스트

```bash
node test.js
```

권한, PIN 잠금, 동시 저장 시 유실 여부를 점검합니다. KV 환경변수(아래)를 주면 실제 KV에서 별도 테스트 키로 실행하고 끝나면 지웁니다.

## Vercel에 배포하기

Vercel 서버는 파일을 계속 저장할 수 없으므로 **Upstash Redis(Vercel KV)** 를 연결해야 합니다.

1. vercel.com → **Add New → Project** → 이 GitHub 저장소를 가져옵니다.
   Framework Preset은 **Other**, 빌드 설정은 비워 둡니다.
2. 프로젝트의 **Storage** 탭 → **Upstash (Redis)** 를 만들고 이 프로젝트에 연결합니다.
   `KV_REST_API_URL`, `KV_REST_API_TOKEN` 환경변수가 자동으로 추가됩니다.
3. 환경변수는 다음 배포부터 적용되므로 **Deployments → Redeploy** 를 누릅니다.
4. 배포 주소에 바로 접속해서 **부모 PIN부터 만드세요.** 가장 먼저 PIN을 만든 사람이 부모가 됩니다.

KV를 연결하지 않고 배포하면 화면에 "KV storage is not connected" 오류가 나옵니다.

| 환경변수 | 설명 |
|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash 연결 시 자동 설정 (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 도 인식) |
| `KV_PREFIX` | KV 키 이름 앞부분 (기본 `familyboard`). 같은 KV를 여러 보드가 쓸 때만 바꾸세요 |

### 로컬에서 실제 KV로 확인하기

Vercel Storage 화면에서 URL과 토큰을 복사한 뒤:

```bash
KV_REST_API_URL=... KV_REST_API_TOKEN=... node server.js   # 실제 데이터로 실행
KV_REST_API_URL=... KV_REST_API_TOKEN=... node test.js     # 테스트 키로 점검
```

## 알아둘 점

- **화면 갱신:** 다른 기기에서 바꾼 내용은 최대 10초 안에 보입니다. 간격은 `public/index.html`의 `POLL_MS`로 조절합니다. 짧게 할수록 KV 사용량이 늘어납니다.
- **KV 사용량:** 태블릿을 하루 종일 켜 두면 월 약 26만 번 읽습니다. Upstash 무료 한도는 현재 기준으로 확인하세요.
- **태블릿 화면 꺼짐:** 안드로이드 설정에서 화면 자동 꺼짐을 끄거나, 개발자 옵션의 "충전 중 화면 켜짐 유지"를 켜세요. (HTTPS인 Vercel 주소에서는 브라우저가 화면 켜짐 유지도 시도합니다.)
- **동시 수정:** 두 기기가 동시에 고쳐도 한쪽 변경이 사라지지 않도록 저장 시 버전을 확인하고 재시도합니다.

## 파일 구조

```
api/index.js       API 전체 (Vercel 함수 겸 로컬 서버용 핸들러), 저장소 선택
public/index.html  화면 (HTML/CSS/JS 한 파일, 영어/한국어 문구 포함)
server.js          로컬 실행용 서버
test.js            권한·동시 저장 점검
```
