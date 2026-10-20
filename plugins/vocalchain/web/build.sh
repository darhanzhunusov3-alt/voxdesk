#!/bin/sh
# Сборка VocalChain в WebAssembly (нужны wasi-sdk 24 и исходники VocalChain + RNNoise).
# Использование: SDK=/путь/wasi-sdk VC=/путь/VocalChain RN=/путь/rnnoise sh build.sh
set -e
F="--target=wasm32-wasip1 --sysroot=$SDK/share/wasi-sysroot -O3"
mkdir -p obj
for f in celt_lpc denoise kiss_fft nnet nnet_default parse_lpcnet_weights pitch rnn rnnoise_tables rnnoise_data; do
  $SDK/bin/clang $F -w -I$RN/include -I$RN/src -c $RN/src/$f.c -o obj/$f.o
done
for f in $VC/source/ParamTable.cpp $VC/source/dsp/NoiseSuppressor.cpp vc_web.cpp; do
  $SDK/bin/clang++ $F -std=c++17 -fno-exceptions -I$VC/source -I$RN/include -c $f -o obj/$(basename $f .cpp).o
done
$SDK/bin/clang++ $F -fno-exceptions -mexec-model=reactor obj/*.o -o ../vocalchain.wasm -Wl,--strip-all -Wl,-z,stack-size=1048576
# таблица параметров и пресетов
g++ -std=c++17 -O1 -I$VC/source dump.cpp $VC/source/ParamTable.cpp -o dump && ./dump > ../vc_data.json
echo "готово: vocalchain.wasm, vc_data.json; затем python3 pack.py"
