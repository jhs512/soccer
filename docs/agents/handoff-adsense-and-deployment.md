# Blob Soccer AdSense·배포 인수인계

## 목적

`soccer.oa.gg`에 Google AdSense를 안전하게 추가하고 기존 GitHub Pages 프런트와 AWS Lightsail 서울 백엔드 배포를 이어간다.

## 현재 사실

- 작업 루트: `C:\Users\jangk\Documents\Codex\2026-08-07\matt-pocock-setup`
- 운영 프런트: `https://soccer.oa.gg/`
- `https://jhs512.github.io/soccer/`는 현재 `https://soccer.oa.gg/`로 이동한다.
- Vite CNAME 원본: `packages/web/public/CNAME` (`soccer.oa.gg`)
- 운영 백엔드: `https://blob-soccer-server.recre6149eyw0.ap-northeast-2.cs.amazonlightsail.com/`
- AWS 리전: `ap-northeast-2` (서울)
- Lightsail 서비스: `blob-soccer-server`
- 현재 백엔드 배포: `game-server.11`, 상태 `RUNNING`, scale 1
- 운영 프런트 백엔드 환경: `packages/web/.env.production`
- GitHub Pages 배포 worktree: `.scratch/github-pages-deploy-20260807-2256`

## 기존 세션의 두 오판

### Lightsail 도구

다운로드하지 않는다. 공식 플러그인이 이미 있다.

```text
.scratch/tools/lightsailctl/lightsailctl.exe
```

확인 시 크기는 약 9.79MB였다. AWS 이미지 푸시 전에 해당 디렉터리를 현재 PowerShell 프로세스의 `PATH`에 추가한다.

```powershell
$env:Path = "$PWD\.scratch\tools\lightsailctl;$env:Path"
```

### AdSense ID

사용자에게 다시 묻지 않는다. 로그인된 `jangka512@gmail.com` AdSense 계정에서 다음 게시자 ID를 확인했다.

```text
ca-pub-8194376114167709
```

광고 단위 slot ID는 아직 없다. 추측하거나 임의 생성하지 않는다.

## AdSense의 실제 차단점

현재 계정은 다음 상태다.

- YouTube용 AdSense: 활성
- 웹사이트용 AdSense: 해지 상태
- AdSense 홈에 `계정 다시 활성화` 버튼 표시
- 사이트·광고 단위 메뉴는 재활성화 전에는 사용할 수 없음

따라서 코드보다 먼저 사용자가 Chrome에서 `계정 다시 활성화`를 승인해야 한다. 이 버튼을 누르는 것은 외부 계정 상태 변경이므로 사용자 확인 없이 실행하지 않는다.

재활성화 뒤 다음을 확인한다.

1. `soccer.oa.gg`를 사이트로 등록할 수 있는지 확인한다.
2. Google이 요구하는 소유권 확인·심사 단계를 완료한다.
3. 자동 광고를 쓸지 수동 반응형 광고 단위를 만들지 결정한다.
4. 수동 광고를 선택한 경우 콘솔이 발급한 실제 `data-ad-slot` 값을 기록한다.

## 구현 경계

광고 변경은 프런트 전용이다. 서버 API 변경이 없다면 Lightsail 이미지를 다시 배포하지 않는다.

다음 UI 상태에서는 광고를 렌더링하지 않는다.

- AI 경기 및 AI 워밍업
- 온라인 경기
- 관전 화면
- 매칭 확인·대전 신청 다이얼로그
- 모바일 전체화면 채팅

월드도 조작 가능한 화면이다. 하단에는 랜덤 매치 버튼, 미니맵, 조이스틱, FIRE/DASH가 있으므로 하단 고정 광고를 바로 추가하지 않는다. 광고가 버튼·미니맵·채팅·캐릭터 클릭 영역을 덮지 않는 전용 슬롯을 먼저 설계하고 PC·모바일 세로·가로에서 검증한다.

권장 구조:

- `packages/web/src/ads/lobby-ad.tsx`: 월드 전용 광고 컴포넌트
- `VITE_ADSENSE_CLIENT`: `ca-pub-...` 환경값
- `VITE_ADSENSE_SLOT`: 수동 광고 단위가 발급된 뒤에만 설정
- 값이 없거나 개발 환경이면 빈 예약 영역도 만들지 않는다.
- React Strict Mode나 재렌더에서 `(adsbygoogle).push({})`를 중복 호출하지 않도록 ref로 1회 초기화한다.

## ads.txt

웹사이트용 계정을 재활성화하고 게시자 ID가 콘솔에서 다시 확인된 뒤 `packages/web/public/ads.txt`를 만든다.

```text
google.com, pub-8194376114167709, DIRECT, f08c47fec0942fa0
```

Vite는 `public/ads.txt`를 `dist/ads.txt`로 복사한다. GitHub Pages 배포 때 `dist`의 루트 파일도 함께 복사해야 한다. 완료 기준:

```text
https://soccer.oa.gg/ads.txt
```

위 URL이 HTTP 200과 정확한 한 줄을 반환한다.

## 프런트 검증·배포

```powershell
pnpm test
pnpm --filter @blob-soccer/web build
pnpm exec playwright test --retries=0
```

검증 기준:

- 광고는 월드의 승인된 전용 영역에서만 보인다.
- 경기·관전 Canvas에는 광고 DOM이 없다.
- 모바일 390×844와 844×390에서 광고가 미니맵·채팅·컨트롤을 가리지 않는다.
- 가상 키보드가 열린 전체화면 채팅에서 광고가 나타나지 않는다.
- 광고 네트워크가 차단되어도 게임과 매칭은 정상 작동한다.
- 콘솔 오류가 없다.

빌드 결과 전체를 gh-pages worktree에 복사한다. `CNAME`과 `ads.txt` 같은 루트 파일을 빠뜨리지 않는다.

```powershell
$deployRoot = (Resolve-Path '.scratch/github-pages-deploy-20260807-2256').Path
Copy-Item -Path 'packages/web/dist/*' -Destination $deployRoot -Recurse -Force
git -C $deployRoot add .
git -C $deployRoot commit -m "feat: add approved AdSense placement"
git -C $deployRoot push origin gh-pages
```

GitHub Pages 완료 확인:

```powershell
gh api repos/jhs512/soccer/pages/builds/latest --jq '{status:.status,commit:.commit}'
```

`status`가 `built`가 된 뒤 `soccer.oa.gg`, `ads.txt`, 광고 비노출 경기 화면을 운영 브라우저에서 다시 검증한다.

## 백엔드 배포 참고

광고만 수정했다면 이 절차를 실행하지 않는다. 서버 변경이 생긴 경우에만 사용한다.

```powershell
docker build -f Dockerfile.aws -t blob-soccer-server:latest .
$env:Path = "$PWD\.scratch\tools\lightsailctl;$env:Path"
aws lightsail push-container-image `
  --region ap-northeast-2 `
  --service-name blob-soccer-server `
  --label game-server `
  --image blob-soccer-server:latest
```

출력된 `:blob-soccer-server.game-server.N`을 `aws/lightsail-containers.json`에 기록한다. 배포 시 기존 `WORLD_POSITION_SECRET`을 현재 배포에서 읽어 새 컨테이너 환경에 다시 넣는다. 비밀값을 로그나 문서에 출력하지 않는다.

```powershell
$service = aws lightsail get-container-services `
  --region ap-northeast-2 `
  --service-name blob-soccer-server `
  --output json | ConvertFrom-Json
$secret = $service.containerServices[0].currentDeployment.containers.'game-server'.environment.WORLD_POSITION_SECRET
if (-not $secret) { throw '운영 WORLD_POSITION_SECRET을 찾을 수 없습니다.' }

$containers = Get-Content -Raw 'aws/lightsail-containers.json' | ConvertFrom-Json
$containers.'game-server'.environment | Add-Member -NotePropertyName WORLD_POSITION_SECRET -NotePropertyValue $secret -Force
$containersJson = $containers | ConvertTo-Json -Depth 8 -Compress
$endpointJson = (Get-Content -Raw 'aws/lightsail-public-endpoint.json' | ConvertFrom-Json) | ConvertTo-Json -Depth 8 -Compress

aws lightsail create-container-service-deployment `
  --region ap-northeast-2 `
  --service-name blob-soccer-server `
  --containers $containersJson `
  --public-endpoint $endpointJson
```

완료 기준:

- 서비스 `state`: `RUNNING`
- `nextDeployment`: 없음
- `/health`: HTTP 200, `{ "status": "ok" }`

## 다음 결정 하나

사용자가 Chrome에 열어둔 AdSense 홈에서 웹사이트용 계정을 재활성화할지 결정한다. 승인 전에는 광고 스크립트·slot·`ads.txt`를 운영에 넣지 않는다.
