"""전사 복원 v3: '완전한 파일 스냅샷'만 기준점으로 삼고 그 이후 Edit만 재생한다.
Read 결과는 startLine==1 이고 numLines==totalLines 일 때만 완전본으로 인정한다."""
import json, sys, os
BS = chr(92)
LOG, OUT = sys.argv[1], sys.argv[2]
MARK = 'matt-pocock-setup/'

def norm(p): return (p or '').replace(BS, '/')

events, seq = [], 0
for line in open(LOG, encoding='utf-8'):
    seq += 1
    try: r = json.loads(line)
    except Exception: continue
    tur = r.get('toolUseResult')
    if isinstance(tur, dict):
        f = tur.get('file')
        if isinstance(f, dict) and f.get('filePath') and f.get('content') is not None:
            p = norm(f['filePath'])
            if MARK in p:
                complete = (f.get('startLine') in (1, None)
                            and f.get('numLines') is not None
                            and f.get('numLines') == f.get('totalLines'))
                events.append((seq, p.split(MARK)[1],
                               'full' if complete else 'partial', f['content']))
    m = r.get('message')
    if isinstance(m, dict) and isinstance(m.get('content'), list):
        for it in m['content']:
            if not (isinstance(it, dict) and it.get('type') == 'tool_use'): continue
            inp = it.get('input') or {}
            p = norm(inp.get('file_path'))
            if MARK not in p: continue
            rel = p.split(MARK)[1]
            if it.get('name') == 'Write':
                events.append((seq, rel, 'full', inp.get('content') or ''))
            elif it.get('name') == 'Edit':
                events.append((seq, rel, 'edit', (inp.get('old_string') or '',
                                                  inp.get('new_string') or '',
                                                  bool(inp.get('replace_all')))))

last_seq = seq
rows = []
for rel in sorted({e[1] for e in events}):
    evs = [e for e in events if e[1] == rel]
    fulls = [e for e in evs if e[2] == 'full']
    edits = [e for e in evs if e[2] == 'edit']
    if not fulls:
        rows.append((rel, '없음', 0, 0, len(edits), '-'))
        continue
    base_seq, _, _, content = max(fulls, key=lambda e: e[0])
    applied = failed = 0
    for s, _, kind, pay in edits:
        if s <= base_seq: continue
        old, new, all_ = pay
        if old and old in content:
            content = content.replace(old, new) if all_ else content.replace(old, new, 1)
            applied += 1
        else:
            failed += 1
    dest = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    open(dest, 'w', encoding='utf-8', newline='\n').write(content)
    freshness = f'{100*base_seq//last_seq}%'
    rows.append((rel, f'seq{base_seq}', len(content.splitlines()), applied, failed, freshness))

print(f"{'file':46} {'기준점':>8} {'줄수':>6} {'적용':>5} {'실패':>5} {'신선도':>7}")
for r in rows:
    print(f"{r[0][:46]:46} {r[1]:>8} {r[2]:>6} {r[3]:>5} {r[4]:>5} {r[5]:>7}")
print(f"\n전사 총 {last_seq}줄")
