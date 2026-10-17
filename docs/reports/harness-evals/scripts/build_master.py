import json, csv, re, collections
from datetime import datetime, timezone
D='data/'
# PR list pages
prs={}
for f in ['prs_closed_p1.json','prs_closed_p2.json','prs_closed_p3.json','prs_closed_p4.json']:
    for r in json.load(open(D+f)):
        prs[r['number']]={'number':r['number'],'created_at':r['created_at'],'closed_at':r.get('closed_at'),'merged_at':r.get('merged_at'),
            'head':r['head']['ref'],'base':r['base']['ref'],'user':r['user']['login'],'title':r['title']}
# bodies
bodies={}
for f in ['prs_sep22_30_bodies.json','prs_oct_bodies_all.json']:
    d=json.load(open(D+f)); d=d if isinstance(d,list) else d.get('items',[])
    for it in d: bodies[it['number']]=it.get('body') or ''
# git stats by PR number
stats={}
for line in open(D+'main_commit_stats.tsv'):
    sha,ci,subj,files,ins,dele=line.rstrip('\n').split('\t')
    m=re.search(r'\(#(\d+)\)\s*$',subj)
    if m: stats[int(m.group(1))]={'files':int(files),'ins':int(ins),'del':int(dele),'merge_sha':sha[:9],'merge_ci':ci}
def classify(body, head):
    b=body
    sig=[]
    if head.startswith('codex/'): sig.append('codex-branch')
    if re.search(r'^Validation:', b, re.M): sig.append('Validation:')
    if 'evidence: private vault' in b or 'smoke/chroxy-pr' in b or re.search(r'^#+ +Smoke', b, re.M|re.I): sig.append('smoke-step')
    if re.search(r'In effect', b): sig.append('in-effect')
    if re.search(r'(?i)mutation|mutant', b): sig.append('mutation-proof')
    if re.search(r'(?i)review round|round \d \(|delta (pass|review)|fold-in', b): sig.append('review-rounds')
    if re.search(r'(?i)\bcodex\b.*(review|pass|round|finding)|(review|pass|round|finding).*\bcodex\b', b): sig.append('codex-reviewer')
    if re.search(r'(?i)\bcoordinator\b', b): sig.append('coordinator')
    if re.search(r'(?i)owner-reserved|COULD-NOT-CHECK', b): sig.append('owner-reserved')
    if re.search(r'Test plan', b): sig.append('test-plan')
    if re.search(r'^## Summary', b, re.M): sig.append('h-summary')
    if re.search(r'(?im)^## (Cause|Problem)', b): sig.append('h-cause/problem')
    if re.search(r'(?im)^## What', b): sig.append('h-what')
    return sig
# MANUAL_SHA: squash subjects that match neither (#N) nor the PR title
MANUAL={8581:'deliver provider instructions and runtime deta'}
for line in open(D+'main_commit_stats.tsv'):
    sha,ci,subj,files,ins,dele=line.rstrip('\n').split('\t')
    for n,frag in MANUAL.items():
        if frag in subj: stats[n]={'files':int(files),'ins':int(ins),'del':int(dele),'merge_sha':sha[:9],'merge_ci':ci}
# TITLE_FALLBACK
subj_index={}
for line in open(D+'main_commit_stats.tsv'):
    sha,ci,subj,files,ins,dele=line.rstrip('\n').split('\t')
    if not re.search(r'\(#(\d+)\)\s*$',subj): subj_index[subj.strip()[:60]]={'files':int(files),'ins':int(ins),'del':int(dele),'merge_sha':sha[:9],'merge_ci':ci}
for n,p in prs.items():
    if n not in stats and p['merged_at'] and p['title'].strip()[:60] in subj_index: stats[n]=subj_index[p['title'].strip()[:60]]
rows=[]
for n,p in sorted(prs.items()):
    b=bodies.get(n,'')
    s=stats.get(n,{})
    rows.append({**p,'body_len':len(b),'has_body':bool(b),'files':s.get('files',''),'ins':s.get('ins',''),'del':s.get('del',''),'merge_sha':s.get('merge_sha',''),
                 'signals':';'.join(classify(b,p['head'])),'head_prefix':p['head'].split('/')[0]})
w=csv.DictWriter(open(D+'pr_master.csv','w'),fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print("PRs in master:", len(rows), "with body:", sum(r['has_body'] for r in rows), "with git stats:", sum(1 for r in rows if r['files']!=''))
print("created range:", rows[0]['created_at'], rows[-1]['created_at'])
print("\nhead prefixes (all 400):", collections.Counter(r['head_prefix'] for r in rows).most_common())
print("\nmerged but no git stat match (merged_at set, not found on main by (#N)):")
miss=[r for r in rows if r['merged_at'] and r['files']=='']
for r in miss: print("  ", r['number'], r['merged_at'][:10], r['head'], r['title'][:60])
print("\nmain commits with (#N) but N not in PR list:", [n for n in stats if n not in prs][:20])
