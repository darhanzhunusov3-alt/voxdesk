"""Упаковывает ShkaFX (wasm + родной интерфейс со шрифтами) в js/shka-bundle.js."""
import base64, gzip, json, pathlib, re
here = pathlib.Path(__file__).parent
root = here.parent.parent
wasm = (here / "shkafx.wasm").read_bytes()
css = (here / "ui" / "style.css").read_text(encoding="utf-8")
# шрифты Inter прямо в CSS: окно плагина в студии — это страница без отдельных файлов
def font(m):
    f = here / "ui" / "fonts" / pathlib.Path(m.group(1)).name
    return 'url("data:font/woff;base64,' + base64.b64encode(f.read_bytes()).decode() + '")'
css = re.sub(r'url\("(fonts/[^"]+\.woff)"\)', font, css)
ui = {"html": (here / "ui" / "index.html").read_text(encoding="utf-8"), "css": css,
      "js": (here / "ui" / "app.js").read_text(encoding="utf-8")}
ver = re.search(r'project\(ShkaFX VERSION ([0-9.]+)', (here / "VERSION.txt").read_text()) if (here / "VERSION.txt").exists() else None
out = ("/* ShkaFX для WOK Studio: сгенерировано plugins/shkafx/pack.py, вручную не править */\n"
       "window.SHKA = " + json.dumps({"version": "3.4.1", "ui": ui}, ensure_ascii=False) + ";\n"
       "window.SHKA.wasmGz = \"" + base64.b64encode(gzip.compress(wasm, 9)).decode() + "\";\n")
(root / "js" / "shka-bundle.js").write_text(out, encoding="utf-8")
print("js/shka-bundle.js:", len(out) // 1024, "КБ")
