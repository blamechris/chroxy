import json, csv, re, collections
from datetime import datetime, timedelta, timezone
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
clusters=json.load(open('data/clusters.json'))
prs={int(r['number']):r for r in csv.DictReader(open('data/pr_master.csv'))}
bodies={}
for f in ['data/prs_sep22_30_bodies.json','data/prs_oct_bodies_all.json']:
    d=json.load(open(f)); d=d if isinstance(d,list) else d.get('items',[])
    for it in d: bodies[it['number']]=it.get('body') or ''
issues={i['number']:i for i in json.load(open('data/issues_since_0922.json'))}
print(f"{'C':>3} {'window(UTC)':33} {'PRs':>3} {'closes':>6} {'inWin':>5} {'preWin':>6} {'issuesFiled':>11} {'fromReview':>10} {'bugs':>4} {'needsDogfood':>12}")
rows=[]
for c in clusters:
    nums=c['prs_list']
    # window: first PR created -> last merge
    created=[ts(prs[n]['created_at']) for n in nums if n in prs]
    merged=[ts(prs[n]['merged_at']) for n in nums if n in prs and prs[n]['merged_at']]
    if not created: continue
    w0=min(created); w1=max(merged) if merged else w0
    closes=set()
    for n in nums:
        for m in re.finditer(r'(?i)\b(?:closes|fixes|resolves)\s+#(\d+)', bodies.get(n,'')): closes.add(int(m.group(1)))
    inwin=sum(1 for i in closes if i in issues and w0<=ts(issues[i]['created_at'])<=w1)
    prewin=sum(1 for i in closes if i in issues and ts(issues[i]['created_at'])<w0)
    unknown=sum(1 for i in closes if i not in issues)
    filed=[i for i in issues.values() if w0<=ts(i['created_at'])<=w1]
    labs=lambda i:[l if isinstance(l,str) else l.get('name') for l in (i.get('labels') or [])]
    fr=sum(1 for i in filed if 'from-review' in labs(i)); bugs=sum(1 for i in filed if any('bug' in (l or '') for l in labs(i))); dog=sum(1 for i in filed if 'needs-dogfood' in labs(i))
    rows.append((c['cluster'],f"{w0:%m-%d %H:%M}→{w1:%m-%d %H:%M}",len(nums),len(closes),inwin,prewin+unknown,len(filed),fr,bugs,dog))
    print(f"C{c['cluster']:02d} {rows[-1][1]:33} {len(nums):>3} {len(closes):>6} {inwin:>5} {prewin+unknown:>6} {len(filed):>11} {fr:>10} {bugs:>4} {dog:>12}")
json.dump(rows,open('data/cluster_issues.json','w'))
print("\n(preWin includes issues older than the issue export, i.e. created before 2026-09-22 but not updated since; 'closes' counts distinct issue numbers in Closes/Fixes/Resolves lines)")
