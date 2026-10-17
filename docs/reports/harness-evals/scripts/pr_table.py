import json, sys, csv, collections
from datetime import datetime
rows=[]
for f in sys.argv[1:]:
    rows += json.load(open(f))
seen=set(); out=[]
for r in rows:
    if r['number'] in seen: continue
    seen.add(r['number'])
    out.append(r)
out.sort(key=lambda r: r['number'])
def prefix(ref):
    return ref.split('/')[0] if '/' in ref else ref
print("total unique PRs:", len(out), "range", out[0]['number'], '..', out[-1]['number'])
print("created range", min(r['created_at'] for r in out), max(r['created_at'] for r in out))
w=csv.writer(open('data/prs_closed.csv','w'))
w.writerow(['number','created_at','closed_at','merged_at','merged','head','base','user','adds','dels','files','commits','comments','title'])
byweek=collections.defaultdict(lambda: collections.Counter())
for r in out:
    w.writerow([r['number'],r['created_at'],r.get('closed_at'),r.get('merged_at'),r.get('merged'),r['head']['ref'],r['base']['ref'],r['user']['login'],r.get('additions'),r.get('deletions'),r.get('changed_files'),r.get('commits'),r.get('comments'),r['title']])
    d=r['created_at'][:10]
    byweek[d][prefix(r['head']['ref'])+('' if r.get('merged') else '(closed-unmerged)')]+=1
for d in sorted(byweek):
    print(d, dict(byweek[d]))
