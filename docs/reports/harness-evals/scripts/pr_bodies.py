import json, sys, re, collections
d=json.load(open(sys.argv[1]))
items = d if isinstance(d,list) else d.get('items', d)
print("count", len(items), "keys", list(items[0].keys()))
markers = {
 'claude_session_url': r'claude\.ai/code/session_',
 'Claude-Session': r'Claude-Session',
 'codex_word': r'\b[Cc]odex\b',
 'chatgpt': r'chatgpt\.com',
 'chroxy_session': r'[Cc]hroxy session',
 'in_effect': r'In effect',
 'prime_directive': r'prime-directive|Prime Directive|PRIME',
 'wave': r'\bWave \d|\bwave \d',
 'benchmark': r'benchmark',
 'smoke_evidence': r'evidence: private vault|smoke/chroxy-pr',
 'closes': r'[Cc]loses #\d+',
 'test_plan': r'Test plan|## Test',
 'summary_h': r'## Summary',
 'review_verdict': r'review verdict|/full-review|agent-review',
 'coauthored': r'Co-[Aa]uthored-[Bb]y',
}
cnt=collections.Counter()
rows=[]
for it in items:
    body = it.get('body') or ''
    hits = {k for k,rx in markers.items() if re.search(rx, body)}
    for h in hits: cnt[h]+=1
    rows.append((it['number'], it['created_at'][:16], it['state'], len(body), sorted(hits), it['title'][:70]))
print("marker counts over", len(items), "PRs:")
for k,v in cnt.most_common(): print(f"  {k}: {v}")
print("min/max created:", min(i['created_at'] for i in items), max(i['created_at'] for i in items))
# print a sample of the first 300 chars of 3 bodies with distinct shapes
import random
random.seed(1)
for it in random.sample(items, 4):
    print("=====", it['number'], it['title'][:80]); print((it.get('body') or '')[:700].replace('\n','\n    '))
json.dump(items, open('data/prs_oct_bodies_all.json','w'))
