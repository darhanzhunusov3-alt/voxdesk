"""Копирует исходники ShkaFX и вносит две правки для WebAssembly:
фоновый поток SwellEngine не запускается, вместо него есть метод pump().
Использование: python3 patch.py /путь/к/ShkaFX ./src"""
import sys, pathlib, shutil
src, dst = pathlib.Path(sys.argv[1]) / 'source', pathlib.Path(sys.argv[2])
if dst.exists(): shutil.rmtree(dst)
shutil.copytree(src / 'dsp', dst / 'dsp')
for f in ['ParamTable.h', 'ParamTable.cpp']: shutil.copy(src / f, dst / f)
h = dst / 'dsp' / 'SwellEngine.h'; t = h.read_text(encoding='utf-8')
a = '    bool isFileMode() const { return fileMode.load(); }'
assert a in t; h.write_text(t.replace(a, a + '\n    /** WebAssembly: одна итерация фоновой работы (вместо потока). */\n    void pump();'), encoding='utf-8')
c = dst / 'dsp' / 'SwellEngine.cpp'; t = c.read_text(encoding='utf-8')
a = '    thread = std::thread ([this] { worker(); });'
assert a in t; t = t.replace(a, '    // WebAssembly: фоновую работу делает pump()')
t += '''
namespace vc
{
void SwellEngine::pump()
{
    wake.store (false);
    drainCapture();
    renderDirty();
    retired.clear();
}
} // namespace vc
'''
c.write_text(t, encoding='utf-8')
print('ok')
