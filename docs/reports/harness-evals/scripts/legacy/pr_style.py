import json, re, collections, csv
items=[]
seen=set()
for f in ['data/prs_oct_bodies_p1.json','data/prs_oct_bodies_p2.json']:
    d=json.load(open(f)); d = d if isinstance(d,list) else d.get('items',[])
    for it in d:
        if it['number'] in seen: continue
        seen.add(it['number']); items.append(it)
items.sort(key=lambda x:x['number'])
json.dump(items, open('data/prs_oct_bodies_all.json','w'))
print("unique PRs with bodies:", len(items), items[0]['created_at'], '..', items[-1]['created_at'])
prs={int(r['number']):r for r in csv.DictReader(open('data/prs_closed.csv'))}
def shape(body):
    heads = re.findall(r'^#{1,3} +(.+?)\s*$', body, re.M)
    heads = [h.strip().lower() for h in heads]
    sig=[]
    for h in heads[:6]: sig.append(h[:14])
    flags=[]
    if re.search(r'^Validation:', body, re.M): flags.append('Validation:')
    if 'evidence: private vault' in body or 'smoke/chroxy-pr' in body: flags.append('SMOKE')
    if re.search(r'In effect', body): flags.append('InEffect')
    if re.search(r'\bWave\b', body): flags.append('Wave')
    if re.search(r'Test plan', body): flags.append('TestPlan')
    if re.search(r'- \[[ x]\]', body): flags.append('checkbox')
    if re.search(r'^\| ', body, re.M): flags.append('table')
    return '|'.join(sig), flags
byday=collections.defaultdict(list)
for it in items:
    b=it.get('body') or ''
    sig,flags=shape(b)
    head = prs.get(it['number'],{}).get('head','?')
    byday[it['created_at'][:10]].append((it['number'], head.split('/')[0], sig[:60], ','.join(flags), len(b)))
for d in sorted(byday):
    print("==", d, len(byday[d]))
    for row in byday[d]:
        print("   ", row)
