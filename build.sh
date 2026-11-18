#!/bin/sh
# The website is index.html + app.js and needs no build. This script only makes app.html,
# a single-file copy for the claude.ai preview artifact (everything inline, no page wrapper).
cd "$(dirname "$0")"
python3 - <<'PY'
import re
html = open('index.html').read()
head = re.search(r'<head>(.*?)</head>', html, re.S).group(1)
body = re.search(r'<body>(.*?)</body>', html, re.S).group(1)
keep = ''.join(re.findall(r'<link rel="(?:preconnect|stylesheet)"[^>]*>\n?', head)) + ''.join(re.findall(r'<style>.*?</style>', head, re.S))
body = re.sub(r'<script type="module" src="app.js"></script>\n?', '', body)
js = open('app.js').read()
out = '<title>Verd</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n' + keep + '\n' + body.strip() + '\n<script type="module">\n' + js + '</script>\n'
open('app.html', 'w').write(out)
PY
