# 从 src/dash.ts 抽取前端算法函数（浏览器版），供与服务端 stats.ts 做交叉一致性对比
import io, os, sys
src = io.open(os.environ['REPO_ROOT'] + '/src/dash.ts', encoding='utf-8').read()


def grab(name):
    i = src.find('function ' + name + '(')
    if i < 0:
        print('missing function ' + name)
        sys.exit(1)
    j = src.find('{', i)
    depth = 0
    k = j
    while k < len(src):
        if src[k] == '{':
            depth += 1
        elif src[k] == '}':
            depth -= 1
            if depth == 0:
                return src[i:k + 1]
        k += 1
    print('unbalanced ' + name)
    sys.exit(1)


NAMES = ['isCh', 'annotate', 'olsRate', 'ptsOf', 'cyclePts', 'sparseOf', 'statOf', 'chgStat', 'fmtDur']
parts = ['var JUMP=8;']
for n in NAMES:
    parts.append(grab(n))
js = '\n\n'.join(parts)
io.open(os.environ['BUILD_DIR'] + '/front.js', 'w', encoding='utf-8').write(js + '\n')
print('extracted %d bytes, %d funcs' % (len(js), len(NAMES)))
