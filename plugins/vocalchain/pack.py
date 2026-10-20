"""Упаковывает VocalChain (wasm, параметры, родной интерфейс) в js/vc-bundle.js —
так студия работает даже при открытии файла с диска."""
import base64, gzip, json, pathlib
here = pathlib.Path(__file__).parent
root = here.parent.parent
wasm = (here / "vocalchain.wasm").read_bytes()
data = json.loads((here / "vc_data.json").read_text(encoding="utf-8"))
ui = {n: (here / "ui" / f).read_text(encoding="utf-8") for n, f in [("html", "index.html"), ("css", "style.css"), ("js", "app.js")]}
b64 = base64.b64encode(gzip.compress(wasm, 9)).decode()
out = ("/* VocalChain 1.2 для WOK Studio: сгенерировано plugins/vocalchain/pack.py, вручную не править */\n"
       "window.VC = " + json.dumps({"version": "1.2.0", "data": data, "ui": ui}, ensure_ascii=False) + ";\n"
       "window.VC.wasmGz = \"" + b64 + "\";\n")
(root / "js" / "vc-bundle.js").write_text(out, encoding="utf-8")
print("js/vc-bundle.js:", len(out) // 1024, "КБ")
