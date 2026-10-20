"""Собирает VoxDesk в один файл dist/voxdesk.html (стили и скрипты внутри)."""
import re, pathlib

root = pathlib.Path(__file__).parent
html = (root / "index.html").read_text(encoding="utf-8")

def inline_css(m):
    return "<style>\n" + (root / m.group(1)).read_text(encoding="utf-8") + "\n</style>"

def inline_js(m):
    # внутри скриптов есть строки с «</script» (интерфейсы плагинов) — экранируем, иначе тег закроется раньше времени
    js = (root / m.group(1)).read_text(encoding="utf-8").replace("</script", "<\\/script").replace("<!--", "<\\!--")
    return "<script>\n" + js + "\n</script>"

html = re.sub(r'<link rel="stylesheet" href="(css/[^"]+)">', inline_css, html)
html = re.sub(r'<script src="(js/[^"]+)"></script>', inline_js, html)

(root / "dist").mkdir(exist_ok=True)
(root / "dist" / "voxdesk.html").write_text(html, encoding="utf-8")

# фрагмент без <html>/<head>/<body> — для публикации как артефакт Claude
# границы берём по первому <head>/</head> и первому <body>/последнему </body>:
# внутри встроенных скриптов тоже встречаются такие теги (интерфейсы плагинов)
h0 = html.index("<head>") + len("<head>"); h1 = html.index("</head>", h0)
head = re.sub(r'<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*', "", html[h0:h1])
b0 = html.index("<body>", h1) + len("<body>"); b1 = html.rindex("</body>")
body = html[b0:b1]
(root / "dist" / "voxdesk-artifact.html").write_text(head.strip() + "\n" + body.strip() + "\n", encoding="utf-8")
print("ok")
