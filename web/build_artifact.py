"""Inline app.css + app.js into one page body for claude.ai artifact hosting (no doctype/head: the host adds them)."""
import pathlib, re
W = pathlib.Path(__file__).parent
css, js = (W / 'app.css').read_text(), (W / 'app.js').read_text()
body = re.search(r'<body>(.*?)<script', (W / 'index.html').read_text(), re.S).group(1)
# artifact frame: sticky header clears the safe area itself, side gutters clear side system bars
css += """
.topbar { top: env(safe-area-inset-top, 0px); padding-top: 10px; }
main, .topbar { padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
main { padding-block: 12px; }
body { min-height: 100%; }
"""
out = f"""<title>Pocket Ledger</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
{css}
</style>
{body.strip()}
<script>
{js}
</script>
"""
(W.parent / 'dist').mkdir(exist_ok=True)
(W.parent / 'dist' / 'expense-tracker.html').write_text(out)
print(len(out), 'bytes')
