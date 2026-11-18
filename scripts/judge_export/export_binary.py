"""Turn a bot's binary data files into plain text for the fact judge. Runs only inside a locked-down container
(no network, /bot read-only): unpickling a file the builder wrote can run code.

    python3 export_binary.py /bot /out

For every *.pkl, *.pickle (gzipped or not), *.json.gz and *.sqlite/*.db under /bot, writes /out/<path>.part<N>.txt
files of at most 1.5 MB each (the judge reads files up to 2 MB): a NetworkX graph as one line per node and per
edge with their attributes, other objects as JSON, a SQLite database as one line per row.
"""
import gzip, json, pickle, sqlite3, sys
from pathlib import Path

PART = 1_500_000
src, out = Path(sys.argv[1]), Path(sys.argv[2])

def text(v):
    return json.dumps(v, default=str, ensure_ascii=False) if not isinstance(v, str) else v

def lines_of(obj):
    try:
        import networkx as nx
        if isinstance(obj, nx.Graph):
            yield f"# graph: {type(obj).__name__}, {obj.number_of_nodes()} nodes, {obj.number_of_edges()} edges"
            for n, a in obj.nodes(data=True):
                yield f"node {text(n)}: " + "; ".join(f"{k}={text(v)}" for k, v in a.items())
            for u, v, a in obj.edges(data=True):
                yield f"edge {text(u)} -> {text(v)}: " + "; ".join(f"{k}={text(x)}" for k, x in a.items())
            return
    except ImportError:
        pass
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and not isinstance(v, str):
                yield f"## {text(k)}"
                yield from lines_of(v)
            else:
                yield f"{text(k)}: {text(v)}"
    elif isinstance(obj, (list, tuple, set)):
        for v in obj:
            yield text(v)
    else:
        yield text(obj)

def write(rel, lines):
    part, buf, size, n = 1, [], 0, 0
    def flush():
        nonlocal part, buf, size
        if buf:
            dst = out / f"{rel}.part{part}.txt"
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text("\n".join(buf) + "\n")
            part, buf, size = part + 1, [], 0
    for line in lines:
        b = len(line.encode()) + 1
        if size + b > PART:
            flush()
        buf.append(line); size += b; n += 1
    flush()
    return n

done = []
for p in sorted(src.rglob("*")):
    if not p.is_file():
        continue
    name, rel = p.name.lower(), str(p.relative_to(src))
    try:
        if name.endswith((".pkl", ".pickle", ".pkl.gz", ".pickle.gz")):
            opener = gzip.open if name.endswith(".gz") else open
            with opener(p, "rb") as f:
                obj = pickle.load(f)
            done.append((rel, write(rel, lines_of(obj))))
        elif name.endswith(".json.gz"):
            with gzip.open(p, "rt") as f:
                done.append((rel, write(rel, lines_of(json.load(f)))))
        elif name.endswith((".sqlite", ".sqlite3", ".db")):
            con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
            def rows():
                for (t,) in con.execute("select name from sqlite_master where type='table'"):
                    for r in con.execute(f'select * from "{t}"'):
                        yield f"{t}: " + text(list(r))
            done.append((rel, write(rel, rows())))
    except Exception as e:
        done.append((rel, f"not converted: {type(e).__name__}: {str(e)[:200]}"))
for rel, n in done:
    print(f"{rel}: {n} lines" if isinstance(n, int) else f"{rel}: {n}")
