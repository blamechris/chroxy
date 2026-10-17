import csv, sys, re, collections
from datetime import datetime, timedelta, timezone
# main commits
rows=[]
for line in open('data/main_commits_since_0920.tsv'):
    sha, ci, subj = line.rstrip('\n').split('\t',2)
    dt = datetime.strptime(ci, '%Y-%m-%d %H:%M:%S %z').astimezone(timezone.utc)
    m = re.search(r'\(#(\d+)\)\s*$', subj)
    rows.append((dt, sha[:9], int(m.group(1)) if m else None, subj))
rows.sort()
# PR size map
prs={}
for r in csv.DictReader(open('data/prs_closed.csv')):
    prs[int(r['number'])]=r
GAP=timedelta(hours=3)
clusters=[]; cur=[]
for r in rows:
    if cur and r[0]-cur[-1][0] > GAP:
        clusters.append(cur); cur=[]
    cur.append(r)
if cur: clusters.append(cur)
print(f"{'#':>2} {'start(UTC)':16} {'end(UTC)':16} {'hrs':>5} {'merges':>6} {'PRs':>4} {'adds':>6} {'dels':>6} {'files':>5}  sample")
for i,c in enumerate(clusters):
    start,end=c[0][0],c[-1][0]
    hrs=(end-start).total_seconds()/3600
    nums=[x[2] for x in c if x[2]]
    adds=sum(int(prs[n]['adds'] or 0) for n in nums if n in prs)
    dels=sum(int(prs[n]['dels'] or 0) for n in nums if n in prs)
    files=sum(int(prs[n]['files'] or 0) for n in nums if n in prs)
    known=sum(1 for n in nums if n in prs)
    sample=c[0][3][:60]
    print(f"{i:>2} {start:%m-%d %H:%M} {end:%m-%d %H:%M} {hrs:5.1f} {len(c):6} {len(nums):4} {adds:6} {dels:6} {files:5}  [{known} in csv] {sample}")
