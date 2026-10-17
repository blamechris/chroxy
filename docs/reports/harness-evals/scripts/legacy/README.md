# Exploratory scripts (not part of the reproduce.sh chain)

These four scripts were used while building the diagnostic but their inputs
(`main_commits_since_0920.tsv`, `prs_closed.csv`, `prs_oct_bodies_p1/p2.json`)
were not retained. They produce no number in the published report; the chain
that does is `../reproduce.sh`. Two of them (`pr_bodies.py`, `pr_style.py`)
write `data/prs_oct_bodies_all.json`, which IS a chain input — do not run them
inside a reproduce work directory.
