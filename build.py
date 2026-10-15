# -*- coding: utf-8 -*-
"""把 模板+CSS+vendor+logic+storage+ui 拼装成单文件 六级单词复习.html"""
import io, os, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.path.dirname(os.path.abspath(__file__))

def read(rel):
    with io.open(os.path.join(BASE, rel), encoding="utf-8") as f:
        return f.read()

tpl = read("src/index.template.html")
vendor = read("vendor/xlsx.full.min.js")
assert "</script" not in vendor.lower(), "vendor 含 </script，不能直接内联"

parts = [
    ("<!--__STYLES__-->",  "<style>\n" + read("src/styles.css") + "\n</style>"),
    ("<!--__VENDOR__-->",  "<script>\n" + vendor + "\n</script>"),
    ("<!--__LOGIC__-->",   "<script>\n" + read("src/logic.js") + "\n</script>"),
    ("<!--__STORAGE__-->", "<script>\n" + read("src/storage.js") + "\n</script>"),
    ("<!--__UI__-->",      "<script>\n" + read("src/ui.js") + "\n</script>"),
]
for marker, chunk in parts:
    assert marker in tpl, "模板缺少占位符 " + marker
    tpl = tpl.replace(marker, chunk)
assert "<!--__" not in tpl, "仍有未替换的占位符"

out = os.path.join(BASE, "六级单词复习.html")
with io.open(out, "w", encoding="utf-8", newline="\n") as f:
    f.write(tpl)
print("BUILT", out, os.path.getsize(out), "bytes")
