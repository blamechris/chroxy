import json, csv, re, collections, statistics, math
from datetime import datetime, timezone
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
prs={int(r['number']):r for r in csv.DictReader(open('data/pr_master.csv'))}
issues={i['number']:i for i in json.load(open('data/issues_since_0922.json'))}
bodies={}
for f in ['data/prs_sep22_30_bodies.json','data/prs_oct_bodies_all.json']:
    d=json.load(open(f)); d=d if isinstance(d,list) else d.get('items',[])
    for it in d: bodies[it['number']]=it.get('body') or ''
ci=collections.defaultdict(collections.Counter)
for r in csv.DictReader(open('data/workflow_runs_since_0922.csv')):
    if r['workflow_name']=='CI': ci[r['head_branch']][r['conclusion'] or r['status']]+=1
heads={}
for r in csv.DictReader(open('data/pr_head_commits.csv')): heads[int(r['number'])]=r
# RUN DEFINITIONS: (id, label, harness, mode, confidence, PR filter)
def prs_between(a,b,pred=lambda p:True):
    return sorted(n for n,p in prs.items() if p['merged_at'] and a<=p['merged_at']<=b and pred(p))
codex=lambda p:p['head'].startswith('codex/')
notcodex=lambda p:not codex(p)
runs=[
 ('B-CX-Sep13','Codex baseline, Sep 13-15','CX','SS?','high: codex/ branches', [7841,7842,7843,7844,7848,7850,7851,7853]),
 ('B-CX-7854','Codex agent-control MCP PR, Sep 18-26','CX','SS','high: codex/ branch',[7854]),
 ('B1','Sep 22 session','CD?','PD?','inferred',prs_between('2026-09-22T00:00','2026-09-23T00:00',notcodex)),
 ('B2','Sep 24 marathon','CD?','PD?','inferred',prs_between('2026-09-24T00:00','2026-09-24T23:59',notcodex)),
 ('B3','Sep 25-26 marathon','CD?','PD?','inferred',prs_between('2026-09-25T00:00','2026-09-26T12:00',lambda p:notcodex(p) and not p['head'].startswith('renovate'))),
 ('B4','Sep 26-28 marathon','CD?','PD?','inferred',prs_between('2026-09-26T12:00','2026-09-28T09:00',lambda p:notcodex(p) and not p['head'].startswith('renovate'))),
 ('B5','Sep 28 session','CD?','PD?','inferred',prs_between('2026-09-28T09:00','2026-09-28T16:00',notcodex)),
 ('B6','Sep 28-29 session','CD?','PD?','inferred',prs_between('2026-09-28T16:00','2026-09-29T05:00',notcodex)),
 ('B7','Sep 29-30 marathon (incl. v0.11.1 cloud session)','CD?','PD?','inferred; 3 PRs from llm-/ cloud branch',prs_between('2026-09-29T05:00','2026-09-30T09:00',notcodex)),
 ('B8','Sep 30 session (v0.11.2)','CD?','SS?','inferred',prs_between('2026-09-30T09:00','2026-09-30T19:00',notcodex)),
 ('R01','Sep 30 16:24 -> Oct 1 08:11 Claude session','CD?','PD?','inferred',prs_between('2026-09-30T19:00','2026-10-01T09:00',notcodex)),
 ('R02-CX','Oct 1 Codex PRIME-compat PRs','CX','SS','high: codex/ branches + Validation: dialect',[8200,8202,8205]),
 ('R03','Oct 1-2 Claude PRs','CD?','SS?','inferred',prs_between('2026-10-01T09:00','2026-10-03T00:00',notcodex)),
 ('R04','Oct 3 #8216 (delivery pilot)','CD?','SS','inferred; body: "under the delivery pilot"',prs_between('2026-10-03T00:00','2026-10-03T23:59',notcodex)),
 ('R05','Oct 4 #8272 (first smoke-table PR)','CD?','PD?','inferred',prs_between('2026-10-04T00:00','2026-10-04T23:59',notcodex)),
 ('R06','Oct 5 #8297/#8299','CD?','SS','inferred',[8297,8299]),
 ('R07-CY','Oct 4-6 Chroxy claude-sdk worker delivering #8276 (CX-coordinated, NORMAL)','CY worker / CX coord','SS','documented: #8300/#8304; checkout git identity; CX evaluation: CX coordinator, assignment NORMAL',[8276]),
 ('R08','Oct 6 follow-up to the CY run (#8304 docs, #8320, #8325)','CD?','SS','inferred; desktop git identity',[8304,8320,8325]),
 ('R09','Oct 6 auto-deploy #8330','CD?','SS','inferred',[8330]),
 ('R10','Oct 7 release train (0.11.3/0.11.4 + 4 fixes)','CD','SS + release','CX evaluation: same native root as the PD chain, NORMAL episodes before PD; entrypoint claude-desktop',prs_between('2026-10-07T00:00','2026-10-07T23:00',notcodex)),
 ('R11','Oct 7 23:25 -> Oct 9 05:05 coordinator waves 1-20','CD','PD','CX evaluation: native entrypoint claude-desktop (root 532cf9d9 waves 1-19 = 89 PRs; c26d0267 wave 20 = 3); session records §3.1',prs_between('2026-10-07T23:00','2026-10-09T06:00',notcodex)),
 ('R12','Oct 9 wave 21','CD','PD','session record + CX evaluation (b22bbf2b)',prs_between('2026-10-09T06:00','2026-10-09T12:00',notcodex)),
 ('R13','Oct 9 wave 22','CD','PD','session record + CX evaluation (34a55f19)',prs_between('2026-10-09T12:00','2026-10-09T23:59',notcodex)),
 ('R14','Oct 10 waves 23-28','CD','PD','session record + CX evaluation (28912bd5)',prs_between('2026-10-10T00:00','2026-10-10T23:59',notcodex)),
 ('R15','Oct 11 waves 29-30','CD','PD','session record + CX evaluation (3a0b4364)',prs_between('2026-10-11T00:00','2026-10-11T23:59',notcodex)),
 ('R16-CX','Oct 12 #8578 (CX PD) and #8581 (CX SS with a Chroxy-hosted Codex worker)','CX','PD + SS','dialect; CX evaluation: roots 01a12d7b and 01a12de6; #8581 implemented by a CY native Codex worker',[8578,8581]),
 ('R17','Oct 12 #8582','?','SS','unknown',[8582]),
 ('R18-CX','Oct 13-14 Codex chats (three roots: #8583 SS; #8586/#8588 PD; nine-PR daily-driver PD)','CX','PD (+1 SS)','codex/ branches; CX evaluation: roots 01a1329d, 01a133a3, 01a1365a; CY native workers on #8591 and #8600',prs_between('2026-10-13T00:00','2026-10-14T23:59',codex)),
 ('R19-CX','Oct 17 #8612','CX','SS','codex/ branch; CX evaluation: root 01a147f9 selected package',[8612]),
]
out=[]
for rid,label,h,m,conf,nums in runs:
    nums=[n for n in nums if n in prs and prs[n]['merged_at'] and prs[n]['user']=='blamechris' and not prs[n]['head'].startswith('renovate')]
    if not nums: continue
    created=[ts(prs[n]['created_at']) for n in nums]; merged=[ts(prs[n]['merged_at']) for n in nums]
    firstc=[ts(heads[n]['first_author_date']+'+00:00') if n in heads and heads[n]['first_author_date'] else None for n in nums]
    # first_author_date is in local tz string w/o offset; approximate: parse pr_head_commits (dates recorded as local time) -> skip tz; use created instead
    w0=min(created); w1=max(merged)
    ins=sum(int(prs[n]['ins'] or 0) for n in nums); dele=sum(int(prs[n]['del'] or 0) for n in nums); files=sum(int(prs[n]['files'] or 0) for n in nums)
    cyc=sorted((ts(prs[n]['merged_at'])-ts(prs[n]['created_at'])).total_seconds()/60 for n in nums)
    ncommits=sum(int(heads[n]['n_commits']) for n in nums if n in heads)
    cic=collections.Counter()
    for n in nums:
        for k,v in ci.get(prs[n]['head'],{}).items(): cic[k]+=v
    closes=set()
    for n in nums:
        for mm in re.finditer(r'(?i)\b(?:closes|fixes|resolves)\s+#(\d+)', bodies.get(n,'')): closes.add(int(mm.group(1)))
    inwin=sum(1 for i in closes if i in issues and w0<=ts(issues[i]['created_at'])<=w1)
    filed=[i for i in issues.values() if w0<=ts(i['created_at'])<=w1]
    labs=lambda i:[l if isinstance(l,str) else l.get('name') for l in (i.get('labels') or [])]
    sig=collections.Counter()
    for n in nums:
        for s in prs[n]['signals'].split(';'):
            if s: sig[s]+=1
    out.append(dict(run=rid,label=label,harness=h,mode=m,confidence=conf,prs=len(nums),pr_numbers=nums,window_start=w0.isoformat(),window_end=w1.isoformat(),
        span_h=round((w1-w0).total_seconds()/3600,1),files=files,ins=ins,dels=dele,commits=ncommits,median_cycle_min=round(statistics.median(cyc),1),p90_cycle_min=round(cyc[max(0,math.ceil(0.9*len(cyc))-1)],1),
        ci_runs=sum(cic.values()),ci_failure=cic['failure'],ci_cancelled=cic['cancelled'],ci_success=cic['success'],issues_closed=len(closes),closed_filed_in_window=inwin,issues_filed_in_window=len(filed),
        from_review_filed=sum(1 for i in filed if 'from-review' in labs(i)),bugs_filed=sum(1 for i in filed if any('bug' in (l or '') for l in labs(i))),signals=dict(sig)))
json.dump(out,open('data/runs.json','w'),indent=1)
print(f"{'run':10} {'H':4} {'M':4} {'PRs':>3} {'span_h':>6} {'files':>5} {'+ins':>6} {'-del':>5} {'cmts':>4} {'medCyc':>6} {'p90':>5} {'CI':>4} {'fail':>4} {'closed':>6} {'inWin':>5} {'filed':>5} {'fromRev':>7} {'bugs':>4}")
for o in out:
    print(f"{o['run']:10} {o['harness']:4} {o['mode']:4} {o['prs']:>3} {o['span_h']:>6} {o['files']:>5} {o['ins']:>6} {o['dels']:>5} {o['commits']:>4} {o['median_cycle_min']:>6} {o['p90_cycle_min']:>5} {o['ci_runs']:>4} {o['ci_failure']:>4} {o['issues_closed']:>6} {o['closed_filed_in_window']:>5} {o['issues_filed_in_window']:>5} {o['from_review_filed']:>7} {o['bugs_filed']:>4}")

print("\n=== Oct 1-17 totals by harness bucket (merged PRs with merged_at in window) ===")
tot=collections.defaultdict(lambda: collections.Counter())
for o in out:
    if not o['run'].startswith('B'):
        b=o['harness']; tot[b]['prs']+=o['prs']; tot[b]['ins']+=o['ins']; tot[b]['dels']+=o['dels']; tot[b]['files']+=o['files']; tot[b]['closed']+=o['issues_closed']; tot[b]['runs']+=1
for b,c in tot.items(): print(b, dict(c))
allm=[n for n,p in prs.items() if p['merged_at'] and '2026-10-01'<=p['merged_at'][:10]<='2026-10-17']
print("all merged Oct 1-17:", len(allm), "assigned to runs:", sum(o['prs'] for o in out if not o['run'].startswith('B')))
print("unassigned:", sorted(set(allm)-set(n for o in out if not o['run'].startswith('B') for n in o['pr_numbers'])))
