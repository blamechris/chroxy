import csv, json, re
from datetime import datetime, timedelta
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
runs=json.load(open('data/runs.json'))
sess=list(csv.DictReader(open('data/ccr_sessions.csv')))
ch=[r for r in sess if 'chroxy' in (r['repo_sources'] or '').lower() or 'chroxy' in (r['title'] or '').lower()]
def kind(r):
    if r['environment_kind']=='anthropic_cloud': return f"cloud/{r['origin']}"
    return f"{r['environment_kind']}/{r['origin']}" + ('/rc-sdk' if 'remote-control-sdk' in r['tags'] else '')
out=[]
for o in runs:
    w0=ts(o['window_start'])-timedelta(hours=1); w1=ts(o['window_end'])+timedelta(hours=1)
    hits=[]
    for r in ch:
        c=ts(r['created_at']); u=ts(r['updated_at'])
        if c<=w1 and u>=w0:
            text=(r['recent_action'] or '')+' '+(r['status_detail'] or '')+' '+(r['needs_action'] or '')
            prs=set(int(x) for x in re.findall(r'#(\d{4})',text))
            match=sorted(prs & set(o['pr_numbers']))
            hits.append((r,match))
    out.append((o,hits))
    print(f"\n== {o['run']} [{o['harness']}/{o['mode']}] {o['window_start'][5:16]}→{o['window_end'][5:16]} PRs={o['prs']}")
    for r,match in hits:
        print(f"   {r['created_at'][5:16]}→{r['updated_at'][5:16]} {kind(r):28} {r['configured_model'][-9:]:9} ctx={r['context_used_tokens']:>7} ${r['usage_cost_usd'][:6] or '-':6} | {r['title'][:58]:58} | PRs named & in run: {match if match else '-'} | {(r['status_detail'] or '')[:60]}")
json.dump([{'run':o['run'],'sessions':[{'id':r['id'],'title':r['title'],'created':r['created_at'],'updated':r['updated_at'],'kind':kind(r),'model':r['configured_model'],'ctx':r['context_used_tokens'],'cost':r['usage_cost_usd'],'match':m,'status':r['status_detail'],'recent':r['recent_action']} for r,m in hits]} for o,hits in out], open('data/run_sessions.json','w'), indent=1)
