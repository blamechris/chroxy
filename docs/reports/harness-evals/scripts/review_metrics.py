import json, csv, re, collections, statistics
from datetime import datetime
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
runs=json.load(open('data/runs.json'))
prs={int(r['number']):r for r in csv.DictReader(open('data/pr_master.csv'))}
det={}
for f in ['data/pr_detail_oct.csv','data/pr_detail_sep.csv']:
    for r in csv.DictReader(open(f)):
        if r['number']: det[int(r['number'])]=r
def by(s,key):
    # parse "a=3;b=2" -> dict
    d={}
    for part in (s or '').split(';'):
        if '=' in part:
            k,v=part.rsplit('=',1)
            try: d[k]=int(v)
            except: pass
    return d
rows=[]
for o in runs:
    nums=[n for n in o['pr_numbers'] if n in det]
    if not nums: continue
    cov=f"{len(nums)}/{o['prs']}"
    commits=[int(det[n]['n_commits'] or 0) for n in nums]
    threads=[int(det[n]['n_threads'] or 0) for n in nums]
    resolved=[int(det[n]['n_resolved_threads'] or 0) for n in nums]
    rc=[int(det[n]['n_review_comments'] or 0) for n in nums]
    cop=sum(by(det[n]['comments_by'],'c').get('copilot-pull-request-reviewer',0) for n in nums)
    human=sum(by(det[n]['comments_by'],'c').get('blamechris',0) for n in nums)
    nrev=[int(det[n]['n_reviews'] or 0) for n in nums]
    approvals=sum(1 for n in nums if 'APPROVED' in (det[n]['reviews_by'] or ''))
    changes_req=sum(1 for n in nums if 'CHANGES_REQUESTED' in (det[n]['reviews_by'] or ''))
    lead=[]; post=[]
    for n in nums:
        fc=det[n]['first_commit_date']; lc=det[n]['last_commit_date']
        if fc:
            lead.append((ts(prs[n]['created_at'])-ts(fc)).total_seconds()/60)
            post.append((ts(prs[n]['merged_at'])-ts(lc)).total_seconds()/60)
    med=lambda a: round(statistics.median(a)) if a else ''
    row=dict(run=o['run'],harness=o['harness'],mode=o['mode'],coverage=cov,commits_per_pr=round(sum(commits)/len(nums),1),prs_multi_commit=sum(1 for c in commits if c>1),
             threads_total=sum(threads),threads_resolved=sum(resolved),prs_with_threads=sum(1 for t in threads if t>0),copilot_comments=cop,human_replies=human,
             reviews_per_pr=round(sum(nrev)/len(nums),2),prs_approved=approvals,prs_changes_requested=changes_req,
             median_first_commit_to_pr_min=med(lead),median_last_commit_to_merge_min=med(post),median_commit_span_min=med([(ts(det[n]['last_commit_date'])-ts(det[n]['first_commit_date'])).total_seconds()/60 for n in nums if det[n]['first_commit_date']]))
    rows.append(row); o['review']=row
json.dump(runs,open('data/runs.json','w'),indent=1)
import os
w=csv.DictWriter(open(os.environ.get('HE_METRICS_PATH','/home/user/chroxy/docs/reports/harness-evals/data/review-metrics-2026-10-17.csv'),'w',newline=''),fieldnames=list(rows[0].keys()),lineterminator='\n'); w.writeheader(); w.writerows(rows)
print(f"{'run':10} {'cov':>7} {'c/PR':>4} {'multi':>5} {'thr':>4} {'res':>4} {'PRw/thr':>7} {'copilot':>7} {'human':>5} {'rev/PR':>6} {'appr':>4} {'chg':>3} {'lead':>5} {'post':>5} {'cspan':>5}")
for r in rows:
    print(f"{r['run']:10} {r['coverage']:>7} {r['commits_per_pr']:>4} {r['prs_multi_commit']:>5} {r['threads_total']:>4} {r['threads_resolved']:>4} {r['prs_with_threads']:>7} {r['copilot_comments']:>7} {r['human_replies']:>5} {r['reviews_per_pr']:>6} {r['prs_approved']:>4} {r['prs_changes_requested']:>3} {r['median_first_commit_to_pr_min']:>5} {r['median_last_commit_to_merge_min']:>5} {r['median_commit_span_min']:>5}")
print("\nlegend: cov=PRs with detail data/PRs in run; c/PR=commits per PR; multi=PRs with >1 commit; thr=review threads (Copilot+human); res=resolved; copilot=Copilot review comments; human=owner replies; lead=median minutes first commit->PR opened; post=median minutes last commit->merge; cspan=median minutes first->last commit")
# reviewers seen
rv=collections.Counter()
for n,r in det.items():
    for part in (r['reviews_by'] or '').split(';'):
        if ':' in part: rv[part.split(':')[0]]+=1
print("\nreviewer logins (PRs reviewed):", rv.most_common())
