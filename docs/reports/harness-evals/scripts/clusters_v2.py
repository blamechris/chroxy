import csv, re, collections, json
from datetime import datetime, timedelta, timezone
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00')) if s else None
prs={int(r['number']):r for r in csv.DictReader(open('data/pr_master.csv'))}
# fix 3 unmatched merged PRs by title match to main commits
main=[]
for line in open('data/main_commit_stats.tsv'):
    sha,ci,subj,files,ins,dele=line.rstrip('\n').split('\t')
    dt=datetime.strptime(ci,'%Y-%m-%d %H:%M:%S %z').astimezone(timezone.utc)
    m=re.search(r'\(#(\d+)\)\s*$',subj); n=int(m.group(1)) if m else None
    if n is None:
        for k,p in prs.items():
            if p['merged_at'] and p['title'].strip()[:50]==subj.strip()[:50]: n=k; prs[k].update({'files':files,'ins':ins,'del':dele,'merge_sha':sha[:9]}); break
    main.append({'dt':dt,'sha':sha[:9],'pr':n,'subj':subj,'files':int(files),'ins':int(ins),'del':int(dele)})
main.sort(key=lambda x:x['dt'])
ci=collections.defaultdict(lambda: collections.Counter())
for r in csv.DictReader(open('data/workflow_runs_since_0922.csv')):
    c=ci[r['head_branch']]; c['runs']+=1; c[r['conclusion'] or r['status']]+=1
GAP=timedelta(hours=3)
clusters=[]; cur=[]
for m in main:
    if cur and m['dt']-cur[-1]['dt']>GAP: clusters.append(cur); cur=[]
    cur.append(m)
if cur: clusters.append(cur)
out=[]
for i,c in enumerate(clusters):
    nums=[m['pr'] for m in c if m['pr']]
    start,end=c[0]['dt'],c[-1]['dt']
    # earliest PR creation among merged PRs = better session start
    created=[ts(prs[n]['created_at']) for n in nums if n in prs]
    first_created=min(created) if created else start
    span_h=(end-first_created).total_seconds()/3600
    cyc=[(ts(prs[n]['merged_at'])-ts(prs[n]['created_at'])).total_seconds()/60 for n in nums if n in prs and prs[n]['merged_at']]
    heads=[prs[n]['head'] for n in nums if n in prs]
    prefixes=collections.Counter(h.split('/')[0] for h in heads)
    sig=collections.Counter()
    for n in nums:
        if n in prs:
            for s in prs[n]['signals'].split(';'):
                if s: sig[s]+=1
    cir=collections.Counter()
    for h in heads:
        for k,v in ci.get(h,{}).items(): cir[k]+=v
    out.append({'cluster':i,'first_pr_created':first_created.strftime('%m-%d %H:%M'),'first_merge':start.strftime('%m-%d %H:%M'),'last_merge':end.strftime('%m-%d %H:%M'),
        'span_h':round(span_h,1),'merge_span_h':round((end-start).total_seconds()/3600,1),'merges':len(c),'prs':len(nums),'files':sum(m['files'] for m in c),'ins':sum(m['ins'] for m in c),'del':sum(m['del'] for m in c),
        'median_cycle_min':round(sorted(cyc)[len(cyc)//2]) if cyc else '', 'prefixes':dict(prefixes),'signals':dict(sig),'ci':dict(cir),'prs_list':nums})
json.dump(out,open('data/clusters.json','w'),indent=1,default=str)
for o in out:
    print(f"C{o['cluster']:02d} created≥{o['first_pr_created']} merges {o['first_merge']}→{o['last_merge']} span {o['span_h']:>5}h  n={o['merges']:>3} PRs={o['prs']:>3} files={o['files']:>4} +{o['ins']:>6}/-{o['del']:>5} medCycle={o['median_cycle_min']}m  {o['prefixes']}")
    print(f"      signals={o['signals']}")
    print(f"      ci={o['ci']}")
