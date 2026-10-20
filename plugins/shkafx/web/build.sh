#!/bin/sh
# Сборка ShkaFX в WebAssembly для VoxDesk (нужен wasi-sdk 24).
# Использование: SDK=/путь/wasi-sdk SHKA=/путь/ShkaFX sh build.sh
set -e
cd "$(dirname "$0")"
python3 patch.py "$SHKA" ./src
F="--target=wasm32-wasip1 --sysroot=$SDK/share/wasi-sysroot -O3 -std=c++17 -fno-exceptions -I./shim -I./src"
$SDK/bin/clang++ $F -mexec-model=reactor src/ParamTable.cpp src/dsp/SwellEngine.cpp shka_web.cpp \
  -o ../shkafx.wasm -Wl,--strip-all -Wl,-z,stack-size=2097152
echo "готово: shkafx.wasm; затем python3 ../pack.py"
