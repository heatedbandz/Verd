#!/bin/sh
# The website is index.html + app.js + core.js and needs no build. This script only makes app.html,
# a single-file copy for the claude.ai preview artifact (everything inline, no page wrapper).
cd "$(dirname "$0")"
python3 - <<'PY'
import re
html = open('index.html').read()
head = re.search(r'<head>(.*?)</head>', html, re.S).group(1)
body = re.search(r'<body>(.*?)</body>', html, re.S).group(1)
keep = ''.join(re.findall(r'<link rel="(?:preconnect|stylesheet)"[^>]*>\n?', head)) + ''.join(re.findall(r'<style>.*?</style>', head, re.S))
body = re.sub(r'<script type="module" src="app.js"></script>\n?', '', body)
# core.js and app.js become one inline module: drop the import line and the export keywords.
core = re.sub(r'^export ', '', open('core.js').read(), flags=re.M)
app = re.sub(r'^import [^\n]*from "\./core\.js";\n', '', open('app.js').read(), flags=re.M)
# The preview keeps its own shared votes in claude.ai, never the real database: blank its settings.
app = re.sub(r'supabaseUrl: "[^"]*"', 'supabaseUrl: ""', app); app = re.sub(r'supabaseKey: "[^"]*"', 'supabaseKey: ""', app)
assert 'supabase.co' not in app, 'the preview must not carry the real database settings'
assert 'import ' not in app.split('\n', 1)[0], 'app.js still imports something build.sh does not inline'
decl = lambda src: set(re.findall(r'^(?:export )?(?:const|let|var|(?:async )?function\*?|class) (\w+)', src, re.M))
clash = decl(core) & decl(app)
assert not clash, 'core.js and app.js both declare: ' + ', '.join(sorted(clash))
js = core + '\n' + app
out = '<title>Verd</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n' + keep + '\n' + body.strip() + '\n<script type="module">\n' + js + '</script>\n'
open('app.html', 'w').write(out)
PY
