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

권한, PIN 잠금, 동시 저장 시 유실 여부를 점검합니다. Firebase 환경변수(아래)를 주면 실제 Firebase의 별도 테스트 위치에서 실행하고 끝나면 지웁니다.

## Vercel에 배포하기 (무료)

Vercel 서버는 파일을 계속 저장할 수 없으므로 데이터는 **Firebase Realtime Database**에 저장합니다.
무료 Spark 요금제로 충분하며 카드 등록이 필요 없습니다. (요청 횟수 제한이 없고 저장 용량·다운로드 양만 제한됩니다.)

### 1. Firebase 데이터베이스 만들기

1. [console.firebase.google.com](https://console.firebase.google.com) → **프로젝트 추가** (Google Analytics는 꺼도 됩니다).
2. 왼쪽 메뉴 **빌드 → Realtime Database → 데이터베이스 만들기**.
   - 위치: 가까운 곳 (예: `asia-southeast1` 싱가포르)
   - 보안 규칙: **잠금 모드**로 시작 — 외부에서 직접 접근은 모두 막히고, 서버만 서비스 계정으로 접근합니다.
3. 만들어진 데이터베이스 주소를 복사합니다. 예: `https://my-family-default-rtdb.asia-southeast1.firebasedatabase.app`
4. ⚙️ **프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성** → JSON 파일이 다운로드됩니다.
   이 파일은 비밀번호와 같으니 **절대 GitHub에 올리지 마세요.**

### 2. Vercel 프로젝트 만들기

1. vercel.com → **Add New → Project** → 이 GitHub 저장소를 가져옵니다.
   Framework Preset은 **Other**, 빌드 설정은 비워 둡니다.
2. **Settings → Environment Variables** 에 두 개를 추가합니다.

   | 이름 | 값 |
   |---|---|
   | `FIREBASE_DB_URL` | 1-3에서 복사한 데이터베이스 주소 |
   | `FIREBASE_SERVICE_ACCOUNT` | 1-4에서 받은 JSON 파일 **내용 전체**를 그대로 붙여넣기 |

3. 환경변수는 다음 배포부터 적용되므로 **Deployments → Redeploy** 를 누릅니다.
4. 배포 주소에 바로 접속해서 **부모 PIN부터 만드세요.** 가장 먼저 PIN을 만든 사람이 부모가 됩니다.

환경변수 없이 배포하면 화면에 "Firebase is not connected" 오류가 나옵니다.

| 선택 환경변수 | 설명 |
|---|---|
| `BOARD_KEY` | Firebase 안의 저장 위치 이름 (기본 `familyboard`). 같은 데이터베이스를 여러 보드가 쓸 때만 바꾸세요 |

### 로컬에서 실제 Firebase로 확인하기

```bash
export FIREBASE_DB_URL=https://....firebasedatabase.app
export FIREBASE_SERVICE_ACCOUNT="$(cat 다운로드한-키.json)"
node server.js   # 실제 데이터로 실행
node test.js     # 테스트 위치에서 점검 후 정리
```

## 알아둘 점

- **화면 갱신:** 다른 기기에서 바꾼 내용은 최대 10초 안에 보입니다. 간격은 `public/index.html`의 `POLL_MS`로 조절합니다.
- **무료 한도:** 태블릿을 하루 종일 켜 두면 한 달에 약 1GB 미만을 다운로드합니다. Spark 요금제 한도는 [Firebase 요금 페이지](https://firebase.google.com/pricing)에서 확인하세요. 한도를 넘어도 요금이 청구되지 않고, 그날은 접속이 막혔다가 다음 날 풀립니다.
- **태블릿 화면 꺼짐:** 안드로이드 설정에서 화면 자동 꺼짐을 끄거나, 개발자 옵션의 "충전 중 화면 켜짐 유지"를 켜세요. (HTTPS인 Vercel 주소에서는 브라우저가 화면 켜짐 유지도 시도합니다.)
- **동시 수정:** 두 기기가 동시에 고쳐도 한쪽 변경이 사라지지 않도록 저장 시 버전(ETag)을 확인하고 재시도합니다.

## 파일 구조

```
api/index.js       API 전체 (Vercel 함수 겸 로컬 서버용 핸들러), 저장소(Firebase / data.json)
public/index.html  화면 (HTML/CSS/JS 한 파일, 영어/한국어 문구 포함)
server.js          로컬 실행용 서버
test.js            권한·동시 저장 점검
```
