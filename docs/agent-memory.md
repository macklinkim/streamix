# Agent Mem 운영

수정일: 2026-10-20 (Asia/Seoul)

Streamix 작업 기억은 로컬 Agent Mem에, 사람이 검토할 작업 이력은 [work-history.md](work-history.md)에 남긴다. 문서 목록은 [README.md](README.md)에서 관리한다.

## 설치 확인 결과

- 원본: [Abuarchiv/agent-mem](https://github.com/Abuarchiv/agent-mem), [공식 사용법](https://github.com/Abuarchiv/agent-mem/blob/main/README.md). 확인일 2026-10-20.
- 실제 설치: `agent-mem 1.0.0 (676f80e)`, Python 3.14.3.
- 실행 파일: `C:\Users\mack\.local\bin\agent-mem.exe`.
- 데이터: `C:\Users\mack\AppData\Local\agent-mem\memory.db`.
- 설정·로그·모델: 같은 데이터 폴더의 `config.json`, `logs/`, `models/`.
- Python 환경: `C:\Users\mack\AppData\Roaming\uv\tools\agent-mem\Scripts\python.exe`.
- 로컬 뷰어: <http://localhost:37778/>. 외부 공개 주소가 아니다.
- `doctor`: DB 무결성, 검색 모델, Claude/Codex 훅, 뷰어 정상. 최초 확인 시 검색 인덱스 미생성 경고와 **0 프로젝트·0 세션·0 요청·0 기억**을 확인했다.

설치는 재실행하지 않았다. 기존 설치의 저장·조회 기능을 직접 사용했다. 이 Codex Desktop 세션에는 agent-mem MCP 도구가 노출되지 않았으므로 아래 로컬 MCP 구현을 호출했다. 훅 설치 상태만으로 Desktop 대화 자동 수집을 보장하지 않는다. 과거 대화를 가짜 세션/요청으로 만들어 주입하지 않는다.

이번 작업의 기억: **M1**은 배포 결과 이관과 리뷰 착수, **M2**는 리뷰 판정·검사 결과·산출물·남은 검증이다. 인덱스 갱신은 `agent-mem index --no-download`로 실행했다. 기억 저장을 자동 대화 이력 수집으로 표현하지 않는다.

M1·M2 검색과 M2 본문 조회가 성공했다. 첫 인덱스 갱신은 기존 native 노트도 가져와 당시 전체 상태가 **4 프로젝트·37 기억, 검색 인덱스 37개**로 표시됐다. 이후 작업 단위별 기록 **M38·M39·M40**도 저장·본문 조회했다. 이번에 직접 작성한 기억은 이 다섯 건이며, 세션·요청 기록은 여전히 0건이다. 기존 노트는 과거 시점의 자료이므로 현재 배포 상태로 간주하지 않는다.

## 작업 시작·종료 절차

저장소 루트 PowerShell에서 실행한다.

```powershell
agent-mem status
agent-mem doctor
agent-mem search 'Streamix 방송 관리' --limit 5
agent-mem show M1
```

다른 디렉터리에서 호출할 때는 검색 범위를 명시한다.

```powershell
agent-mem search 'Streamix UX/UI' --project 'C:\Users\mack\Desktop\projects\study\Streamix' --limit 5
```

1. 관련 기억을 검색하고 ID를 연다. 현재 코드·배포 상태와 대조한다.
2. 조사·구현·검증·문서화/배포처럼 결과가 남는 작업 단위로 나눈다. 각 단위가 끝날 때, 방향 전환·인계 직전, 작업 종료 전에 중간 기록을 저장한다. 명령 하나나 사소한 편집마다 기록하지 않는다.
3. MCP가 연결된 세션에서는 `mem_remember(text, kind, title)`을 사용한다. `kind`는 `fact`, `decision`, `dead_end`, `lesson`; 기본은 프로젝트 범위다. 이미 지난 사실을 교체할 때는 확인한 ID를 `supersedes`로 지정한다.
4. 반환된 `M...` ID를 `agent-mem show`와 검색으로 확인한다. 기록할 내용은 직접 검증한 사실로 한정한다.
5. [work-history.md](work-history.md)와 [문서 인덱스](README.md)를 함께 갱신한다. 상세 결과는 해당 보고서에 링크한다.

중간 기록에는 공통 ID `YYYY-MM-DD-NN`과 작업 범위, 완료 결과, 검증, 남은 작업, 증거 경로를 포함한다. 같은 ID를 기억 제목·본문과 작업 이력에 남겨 양쪽을 연결한다. 진행 중이면 완료라고 적지 않는다. 이미 끝난 작업을 뒤늦게 정리할 때는 **사후 정리**라고 표시하고 수행 시각을 만들어내지 않는다. 사용한 기억 ID는 저장 결과에 나온 값을 기록한다.

```text
2026-10-20-02 — UX/UI 재현·검증
결과: 재현한 문제와 검사 결과.
검증: 환경, 실행한 검사와 실제 결과.
남은 작업: 다음 단위에서 수행할 내용.
증거: docs/보고서.md, 결과 파일 경로.
```

`agent-mem search`와 `show`는 설치된 CLI 명령이다. **`agent-mem remember`라는 CLI 명령은 없다.** MCP 도구는 `mem_search`, `mem_timeline`, `mem_get`, `mem_remember`, `mem_forget`이다. `mem_timeline`은 실제 기록된 요청의 주변 이력을 조회하며, 직접 저장한 기억만으로 대화 이력이 새로 생성되지는 않는다.

## 현재 세션에서 사용한 수동 저장 방법

아래는 설치 버전 1.0.0의 로컬 MCP 서버를 호출하는 대체 절차다. DB를 직접 수정하지 않으며 새 패키지나 별도 서비스를 설치하지 않는다. Python 경로는 이 PC에서 확인한 값이므로 다른 PC에서는 `uv tool dir`과 `agent-mem paths`부터 확인한다. 이후 MCP 도구가 연결되면 도구 직접 호출을 우선한다.

```powershell
@'
import asyncio
from agent_mem.mcp.server import build

async def main():
    server = build()
    result = await server.call_tool("mem_remember", {
        "text": "YYYY-MM-DD Streamix: 검증한 변경, 실행한 검사 결과, 남은 작업, docs/문서.md",
        "kind": "fact",
        "title": "Streamix 작업 결과"
    })
    for block in result.content:
        if hasattr(block, "text"):
            print(block.text)

asyncio.run(main())
'@ | & 'C:/Users/mack/AppData/Roaming/uv/tools/agent-mem/Scripts/python.exe' -
```

예시 문구를 그대로 저장하지 않는다. 실제 수행 내용으로 바꾼다. 이 호출은 로컬 저장이며 사실 추출용 외부 모델 호출을 하지 않는다. 이후 검색 인덱스가 필요하면 `agent-mem index --no-download`를 실행한다.

## 자동 이력 수집 확인과 한계

공식 문서는 Codex CLI 훅 신뢰 검토를 `/hooks`에서 진행하도록 안내한다. 기존 훅을 자동으로 신뢰 처리하거나 보안 검토를 우회하지 않는다. 새 CLI 세션의 요청 종료 후 `agent-mem status`에서 세션·요청 수 증가를 확인해야 자동 수집을 검증할 수 있다. 현재 Desktop 세션의 수동 기억 저장 성공과 자동 요청 기록 성공은 서로 다른 결과다.

필요할 때만 다음 진단을 실행한다.

```powershell
agent-mem observe --status
agent-mem index --no-download
agent-mem doctor
```

`observe --once`는 대기 중인 요청에서 사실을 추출하며 기존 CLI 로그인과 모델 사용량을 쓸 수 있다. 현재 대기 요청이 없는 상태에서 자동 이력이 수집됐다고 설명하지 않는다. `setup codex`는 변경 없는 설정 안내이고, `setup codex --write`는 설정 변경이다. 이번 작업에서는 이미 정상인 전역 설정을 변경하지 않았다.

## 기록 내용과 보안

저장할 것: 사용자 요청의 범위, 결정 이유, 재현 가능한 검사 결과, 환경, 산출물 경로, 미검증 조건. 이전 배포 상세는 [릴리스 기록](../outbox/releases/2026-10-20-ca2551c3.md)을 참조한다.

저장하지 않을 것: 비밀번호, 토큰, 쿠키 값, 스트림 키, 서명 URL, 개인 계정 목록, 비밀 환경 변수, 인증 원문 로그. Agent Mem의 필터만 믿고 비밀 값을 전달하지 않는다. DB는 암호화 저장소가 아니며 뷰어도 인증이 없는 로컬 서비스다. `purge`, `mem_forget`, 전역 규칙 활성화·캡처 정책 변경은 이번 운영 범위에 포함하지 않는다.
