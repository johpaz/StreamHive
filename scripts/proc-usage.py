#!/usr/bin/env python3
"""CPU y memoria de un ÁRBOL de procesos medidos igual para cualquier programa (OBS, StreamHive...).
CPU = tiempo de CPU consumido (usuario+sistema) / segundos, en "núcleos". Memoria = PSS (reparte la memoria compartida
entre procesos, así que no se cuenta dos veces) y RSS.
Uso: proc-usage.py --root PID --seconds N      (imprime una línea JSON)"""
import argparse, json, os, time

TICK = os.sysconf("SC_CLK_TCK")

def children_map():
    m = {}
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                stat = open(f"/proc/{p}/stat").read()
                rest = stat[stat.rindex(")") + 2:].split()
                m.setdefault(int(rest[1]), []).append(int(p))
            except Exception:
                pass
    return m

def tree(root):
    m, out, todo = children_map(), [], [root]
    while todo:
        p = todo.pop()
        out.append(p)
        todo += m.get(p, [])
    return out

def ticks(pid):
    try:
        f = open(f"/proc/{pid}/stat").read()
        r = f[f.rindex(")") + 2:].split()
        return int(r[11]) + int(r[12])  # utime + stime
    except Exception:
        return None

def mem(pid):
    pss = rss = 0
    try:
        for line in open(f"/proc/{pid}/smaps_rollup"):
            if line.startswith("Pss:"): pss = int(line.split()[1])
            elif line.startswith("Rss:"): rss = int(line.split()[1])
    except Exception:
        pass
    return pss, rss

ap = argparse.ArgumentParser()
ap.add_argument("--root", type=int, required=True)
ap.add_argument("--seconds", type=float, default=20)
ap.add_argument("--detail", action="store_true", help="desglose por proceso")
a = ap.parse_args()
start = {p: ticks(p) for p in tree(a.root)}
t0 = time.time()
peak_pss = 0
while time.time() - t0 < a.seconds:
    time.sleep(1)
    peak_pss = max(peak_pss, sum(mem(p)[0] for p in tree(a.root)))
elapsed = time.time() - t0
end_pids = tree(a.root)
cpu = 0.0
for p in end_pids:
    e = ticks(p)
    if e is None: continue
    cpu += (e - (start.get(p) or 0)) / TICK
names = {}
for p in end_pids:
    try: names[p] = open(f"/proc/{p}/comm").read().strip()
    except Exception: pass
if a.detail:
    rows = []
    for p in end_pids:
        e = ticks(p)
        if e is None: continue
        try: cmd = open(f"/proc/{p}/cmdline").read().split("\0")
        except Exception: cmd = []
        typ = next((c.split("=", 1)[1] for c in cmd if c.startswith("--type=")), "main/otro")
        rows.append({"pid": p, "comando": names.get(p, "?"), "tipo": typ, "nucleos": round((e - (start.get(p) or 0)) / TICK / elapsed, 3), "pss_mb": round(mem(p)[0] / 1024)})
    print(json.dumps({"procesos": sorted(rows, key=lambda r: -r["nucleos"])}))
    raise SystemExit
pss = sum(mem(p)[0] for p in end_pids); rss = sum(mem(p)[1] for p in end_pids)
print(json.dumps({"nucleos": round(cpu / elapsed, 2), "pss_mb": round(pss / 1024), "pss_pico_mb": round(peak_pss / 1024), "rss_mb": round(rss / 1024), "procesos": len(end_pids), "segundos": round(elapsed, 1), "comandos": sorted(set(names.values()))}))
