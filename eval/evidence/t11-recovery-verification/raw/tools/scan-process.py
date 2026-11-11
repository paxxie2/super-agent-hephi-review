import sys
path, pattern = sys.argv[1], sys.argv[2]
hits = []
for line in open(path):
    line = line.rstrip('\n')
    if pattern not in line:
        continue
    pid, _, command = line.strip().partition(' ')
    if 'scan-process.py' in command or 'ps -ax -o pid=,command=' in command:
        continue
    hits.append(line)
if not hits:
    print('no process matches %r (scan of ps -ax output)' % pattern)
else:
    for hit in hits:
        print(hit)
