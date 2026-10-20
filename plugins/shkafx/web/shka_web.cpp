// ShkaFX → WebAssembly: обёртка над SwellEngine и ThrowDelay для VoxDesk.
// Один и тот же файл .wasm запускается дважды:
//   * в Web Worker — «фон»: запись волны, выделения, расчёт хвостов, офлайн-рендер (shka_*);
//   * в AudioWorklet — «звук»: delay Throw A/B в реальном времени (rt_*).
// Готовые хвосты из фона пересылаются в AudioWorklet и подмешиваются по позиции песни.
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <chrono>
#define private public   // доступ к готовым хвостам (live) без изменения исходников
#include "dsp/SwellEngine.h"
#undef private
#include "ParamTable.h"

#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

using namespace vc;

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

namespace
{
SwellEngine* eng = nullptr;
std::vector<float> values;
const void* lastLive = nullptr;
std::string str;                    // последняя строка (JSON, ошибки, сериализация)
std::vector<float> fbuf;            // последний массив чисел
SwellEngine::OfflineResult res;
std::map<int, std::shared_ptr<SwellEngine::RegionsSnapshot>> snaps;
int snapSeq = 1;

std::vector<float> defaults()
{
    std::vector<float> d;
    for (const auto& p : paramTable()) d.push_back (p.def);
    return d;
}

void jstr (std::string& o, const std::string& s)
{
    o += '"';
    for (char c : s)
    {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if ((unsigned char) c < 0x20) { char b[8]; std::snprintf (b, sizeof b, "\\u%04x", c); o += b; }
        else o += c;
    }
    o += '"';
}
void jnum (std::string& o, double v) { char b[40]; std::snprintf (b, sizeof b, "%.9g", v); o += b; }
}

// ===================================================================== общее
EXPORT(shka_num_params) int shka_num_params() { return (int) paramTable().size(); }
EXPORT(shka_alloc) void* shka_alloc (int bytes) { return new char[(size_t) bytes]; }
EXPORT(shka_free) void shka_free (void* p) { delete[] (char*) p; }
EXPORT(shka_str) const char* shka_str() { return str.c_str(); }
EXPORT(shka_str_len) int shka_str_len() { return (int) str.size(); }
EXPORT(shka_fbuf) float* shka_fbuf() { return fbuf.data(); }
EXPORT(shka_fbuf_len) int shka_fbuf_len() { return (int) fbuf.size(); }

// таблица параметров в JSON (для интерфейса)
EXPORT(shka_params_json) int shka_params_json()
{
    str = "[";
    const auto& t = paramTable();
    for (size_t i = 0; i < t.size(); ++i)
    {
        const auto& d = t[i];
        if (i) str += ',';
        str += "{\"id\":"; jstr (str, d.id);
        str += ",\"name\":"; jstr (str, d.name);
        str += ",\"group\":"; jstr (str, d.group);
        str += ",\"unit\":"; jstr (str, d.unit);
        str += ",\"kind\":"; jstr (str, d.kind == Kind::Float ? "float" : (d.kind == Kind::Bool ? "bool" : "choice"));
        str += ",\"min\":"; jnum (str, d.min);
        str += ",\"max\":"; jnum (str, d.max);
        str += ",\"def\":"; jnum (str, d.def);
        str += ",\"centre\":"; jnum (str, d.centre);
        str += ",\"reverse\":"; str += d.reverse ? "true" : "false";
        str += ",\"choices\":[";
        for (size_t k = 0; k < d.choices.size(); ++k) { if (k) str += ','; jstr (str, d.choices[k]); }
        str += "]}";
    }
    str += "]";
    return (int) str.size();
}

// ===================================================================== фон (Web Worker)
EXPORT(shka_create) int shka_create (double sr)
{
    if (! eng) eng = new SwellEngine();
    eng->prepare (sr);
    values = defaults();
    eng->setGlobal (values, 120.0);
    eng->pump();
    return (int) values.size();
}
EXPORT(shka_values) float* shka_values() { return values.data(); }
EXPORT(shka_set_global) void shka_set_global (double bpm) { if (eng) eng->setGlobal (values, bpm); }
EXPORT(shka_capture) void shka_capture (double pos, const float* data, int n)
{
    if (eng && n > 0) eng->captureBlock (data, data, n, (int64_t) pos, true, true);
}
// одна итерация фоновой работы; 1 — изменились готовые хвосты
EXPORT(shka_pump) int shka_pump()
{
    if (! eng) return 0;
    eng->pump();
    const void* l = eng->live.load();
    if (l != lastLive) { lastLive = l; return 1; }
    return 0;
}
EXPORT(shka_tails_count) int shka_tails_count() { auto* t = eng ? eng->live.load() : nullptr; return t ? (int) t->items.size() : 0; }
EXPORT(shka_tail_start) double shka_tail_start (int i) { return (double) eng->live.load()->items[(size_t) i].start; }
EXPORT(shka_tail_len) int shka_tail_len (int i) { return (int) eng->live.load()->items[(size_t) i].l.size(); }
EXPORT(shka_tail_l) const float* shka_tail_l (int i) { return eng->live.load()->items[(size_t) i].l.data(); }
EXPORT(shka_tail_r) const float* shka_tail_r (int i) { return eng->live.load()->items[(size_t) i].r.data(); }
EXPORT(shka_change_counter) unsigned shka_change_counter() { return eng ? eng->getChangeCounter() : 0; }
EXPORT(shka_region_counter) unsigned shka_region_counter() { return eng ? eng->getRegionCounter() : 0; }
EXPORT(shka_file_mode) int shka_file_mode() { return eng && eng->isFileMode() ? 1 : 0; }

// список выделений как в событии lf_regions
EXPORT(shka_regions_json) int shka_regions_json()
{
    str = "{\"regions\":[";
    bool first = true;
    for (const auto& r : eng->getRegions())
    {
        if (! first) str += ',';
        first = false;
        str += "{\"id\":"; jnum (str, r.id);
        str += ",\"type\":"; jnum (str, (int) r.type);
        str += ",\"start\":"; jnum (str, r.startSec);
        str += ",\"end\":"; jnum (str, r.endSec);
        str += ",\"tailStart\":"; jnum (str, r.tailStartSec);
        str += ",\"tailEnd\":"; jnum (str, r.tailEndSec);
        str += ",\"status\":"; jnum (str, (int) r.status);
        str += ",\"gainDb\":"; jnum (str, r.gainDb);
        str += ",\"pan\":"; str += r.pan ? "true" : "false";
        str += ",\"fadeIn\":"; jnum (str, r.fadeInMs);
        str += ",\"fadeOut\":"; jnum (str, r.fadeOutMs);
        str += ",\"echoBeats\":"; jnum (str, r.echoBeats);
        str += ",\"echoFb\":"; jnum (str, r.echoFb);
        str += "}";
    }
    str += "],\"capturedEnd\":"; jnum (str, eng->getCapturedEndSec());
    str += ",\"fileMode\":"; str += eng->isFileMode() ? "true" : "false";
    str += ",\"sourceName\":"; jstr (str, eng->getSourceName());
    str += "}";
    return (int) str.size();
}

EXPORT(shka_add_region) int shka_add_region (double a, double b, int type) { return eng->addRegion (a, b, (SwellEngine::RegionType) (type < 0 ? 0 : type > 2 ? 2 : type)); }
EXPORT(shka_update_region) void shka_update_region (int id, double a, double b) { eng->updateRegion (id, a, b); }
EXPORT(shka_set_region_props) void shka_set_region_props (int id, double gainDb, int pan) { eng->setRegionProps (id, gainDb, pan != 0); }
EXPORT(shka_set_region_fades) void shka_set_region_fades (int id, double fi, double fo) { eng->setRegionFades (id, fi, fo); }
EXPORT(shka_set_region_param) void shka_set_region_param (int id, int idx, float v) { eng->setRegionParam (id, idx, v); }
EXPORT(shka_region_vals) int shka_region_vals (int id) { fbuf = eng->getRegionValues (id); return (int) fbuf.size(); }
EXPORT(shka_apply_all) void shka_apply_all() { eng->applyGlobalToAll(); }
EXPORT(shka_reset_region_values) void shka_reset_region_values (int id, int resetGain) { eng->resetRegionValues (id, defaults(), resetGain != 0); }
EXPORT(shka_remove_region) void shka_remove_region (int id) { eng->removeRegion (id); }
EXPORT(shka_clear_regions) void shka_clear_regions() { eng->clearRegions(); }
EXPORT(shka_clear_capture) void shka_clear_capture() { eng->clearCapture(); }

EXPORT(shka_peaks) int shka_peaks (double a, double b, int cols)
{
    const auto pk = eng->getPeaks (a, b, cols);
    fbuf.resize (pk.size() * 2);
    for (size_t i = 0; i < pk.size(); ++i) { fbuf[i * 2] = pk[i].mn; fbuf[i * 2 + 1] = pk[i].mx; }
    return (int) fbuf.size();
}

// свой файл (уже в частоте студии); name — UTF-8 в str-буфере, заданном через shka_alloc
EXPORT(shka_load_source) void shka_load_source (const float* L, const float* R, int n, const char* name, int keepRegions)
{
    std::vector<float> l (L, L + n), r (R, R + n);
    eng->loadSource (l, r, name ? name : "vocal.wav", name ? name : "vocal.wav", keepRegions != 0);
}
EXPORT(shka_use_project) void shka_use_project() { eng->useProject(); }

EXPORT(shka_render) int shka_render (int includeVocal, int onlyRegion, double bpm, int alignToBar, double rangeStart, double rangeEnd)
{
    SwellEngine::OfflineRequest rq;
    rq.includeVocal = includeVocal != 0; rq.onlyRegionId = onlyRegion; rq.bpm = bpm; rq.alignToBar = alignToBar != 0;
    rq.rangeStart = (int64_t) rangeStart; rq.rangeEnd = (int64_t) rangeEnd;
    res = eng->renderOffline (rq);
    str = res.error;
    return res.ok ? 1 : 0;
}
EXPORT(shka_res_start) double shka_res_start() { return (double) res.startSample; }
EXPORT(shka_res_len) int shka_res_len() { return (int) res.fxL.size(); }
EXPORT(shka_res_fxl) const float* shka_res_fxl() { return res.fxL.data(); }
EXPORT(shka_res_fxr) const float* shka_res_fxr() { return res.fxR.data(); }
EXPORT(shka_res_voxlen) int shka_res_voxlen() { return (int) res.voxL.size(); }
EXPORT(shka_res_voxl) const float* shka_res_voxl() { return res.voxL.data(); }
EXPORT(shka_res_voxr) const float* shka_res_voxr() { return res.voxR.data(); }
EXPORT(shka_res_free) void shka_res_free() { res = SwellEngine::OfflineResult(); }

// отмена: снимки выделений
EXPORT(shka_snap) int shka_snap() { const int id = snapSeq++; snaps[id] = eng->snapshotRegions(); return id; }
EXPORT(shka_restore) void shka_restore (int id) { auto it = snaps.find (id); if (it != snaps.end() && it->second) eng->restoreRegions (*it->second); }
EXPORT(shka_free_snap) void shka_free_snap (int id) { snaps.erase (id); }

// сохранение в проекте
EXPORT(shka_serialise) int shka_serialise() { str = eng->serialise(); return (int) str.size(); }
EXPORT(shka_deserialise) void shka_deserialise (const char* data, int n) { eng->deserialise (std::string (data, (size_t) n)); }

// ===================================================================== звук (AudioWorklet)
namespace
{
ThrowDelay* dA = nullptr;
ThrowDelay* dB = nullptr;
std::vector<float> rtVals;
constexpr int kMaxBlock = 2048;
float rtL[kMaxBlock], rtR[kMaxBlock];
}
EXPORT(rt_create) int rt_create (double sr)
{
    if (! dA) { dA = new ThrowDelay(); dB = new ThrowDelay(); }
    dA->prepare (sr); dB->prepare (sr);
    rtVals = defaults();
    return (int) rtVals.size();
}
EXPORT(rt_values) float* rt_values() { return rtVals.data(); }
EXPORT(rt_buf_l) float* rt_buf_l() { return rtL; }
EXPORT(rt_buf_r) float* rt_buf_r() { return rtR; }
// пересчитать настройки delay из ручек; возвращает выходную громкость в дБ
EXPORT(rt_apply) double rt_apply (double hostBpm)
{
    const auto s = toSettings (rtVals.data());
    const double bpm = (s.manualBpm || hostBpm <= 0.0) ? s.manualBpmValue : hostBpm;
    dA->setParams (s.a, bpm);
    dB->setParams (s.b, bpm);
    return s.outGainDb;
}
EXPORT(rt_bpm) double rt_bpm (double hostBpm)
{
    const auto s = toSettings (rtVals.data());
    return (s.manualBpm || hostBpm <= 0.0) ? s.manualBpmValue : hostBpm;
}
EXPORT(rt_capture_on) int rt_capture_on() { return toSettings (rtVals.data()).capture ? 1 : 0; }
EXPORT(rt_process) void rt_process (int n)
{
    if (n <= 0 || n > kMaxBlock) return;
    dA->process (rtL, rtR, n);
    dB->process (rtL, rtR, n);
}
