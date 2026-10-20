// VocalChain → WebAssembly: тонкая обёртка над VocalChainDSP для AudioWorklet.
#include "ParamTable.h"
#include <vector>
using namespace vc;

namespace {
VocalChainDSP* dsp = nullptr;
DynamicEQ* uiEq[2] = { nullptr, nullptr };
std::vector<float> values;
constexpr int kMaxBlock = 2048;
float bufL[kMaxBlock], bufR[kMaxBlock];
float meters[10];
ChainMeters acc;
double sr = 48000.0;
}

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

EXPORT(vc_create) int vc_create (double sampleRate)
{
    sr = sampleRate;
    if (! dsp) { dsp = new VocalChainDSP(); uiEq[0] = new DynamicEQ(); uiEq[1] = new DynamicEQ(); }
    dsp->prepare (sr, kMaxBlock);
    uiEq[0]->prepare (sr); uiEq[1]->prepare (sr);
    values = presetValues (0, 0);
    dsp->setParams (toChainParams (values.data()));
    return (int) values.size();
}
EXPORT(vc_num_params) int vc_num_params() { return (int) paramTable().size(); }
EXPORT(vc_values) float* vc_values() { return values.data(); }
EXPORT(vc_apply) void vc_apply() { if (dsp) dsp->setParams (toChainParams (values.data())); }
EXPORT(vc_reset) void vc_reset() { if (dsp) dsp->reset(); }
EXPORT(vc_buf_l) float* vc_buf_l() { return bufL; }
EXPORT(vc_buf_r) float* vc_buf_r() { return bufR; }
EXPORT(vc_latency) int vc_latency() { return dsp ? dsp->getLatencySamples() : 0; }
EXPORT(vc_set_transport) void vc_set_transport (double bpm, int hasPpq, double ppq)
{
    if (! dsp) return;
    Transport t; t.bpm = bpm > 1.0 ? bpm : 120.0; t.hasPpq = hasPpq != 0; t.ppq = ppq;
    dsp->setTransport (t);
}
EXPORT(vc_process) void vc_process (int n)
{
    if (! dsp || n <= 0 || n > kMaxBlock) return;
    dsp->process (bufL, bufR, n, acc);
}
// индикаторы: in, out, nsVoice, ds, sslComp, sslGate, rc, fet, vox, voxGate; после чтения сбрасываются
EXPORT(vc_meters) float* vc_meters()
{
    meters[0] = acc.inPeak; meters[1] = acc.outPeak; meters[2] = acc.nsVoice; meters[3] = acc.dsGr;
    meters[4] = acc.sslComp; meters[5] = acc.sslGate; meters[6] = acc.rcGr; meters[7] = acc.fetGr;
    meters[8] = acc.voxGr; meters[9] = acc.voxGate;
    acc = ChainMeters();
    return meters;
}
EXPORT(vc_eq_dyn) float vc_eq_dyn (int which, int band)
{
    if (! dsp) return 0.0f;
    return which == 0 ? dsp->getEQ1().getDynamicGain (band) : dsp->getEQ2().getDynamicGain (band);
}
// АЧХ эквалайзера (как sendEQCurves в редакторе): freqs[n] -> out[n] в дБ, dyn[8] — текущий ход динамики
EXPORT(vc_eq_curve) void vc_eq_curve (int which, const float* freqs, int n, float* out, const float* dyn)
{
    if (! uiEq[which]) return;
    const auto cp = toChainParams (values.data());
    uiEq[which]->setParams (which == 0 ? cp.eq1 : cp.eq2);
    for (int b = 0; b < DynamicEQ::kBands; ++b) uiEq[which]->setDisplayDynGain (b, dyn ? dyn[b] : 0.0f);
    for (int i = 0; i < n; ++i) out[i] = (float) uiEq[which]->responseDb (freqs[i]);
}
EXPORT(vc_alloc) float* vc_alloc (int n) { return new float[(size_t) n]; }
