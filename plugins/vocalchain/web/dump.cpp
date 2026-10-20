// Выгрузка таблицы параметров и пресетов VocalChain в JSON (собирается нативно).
#include "ParamTable.h"
#include <cstdio>
#include <string>
using namespace vc;
static std::string esc(const std::string& s){ std::string o; for(char c: s){ if(c=='"'||c=='\\') o+='\\'; o+=c; } return o; }
int main(){
  const auto& t = paramTable();
  printf("{\"params\":[");
  for(size_t i=0;i<t.size();++i){ const auto& d=t[i];
    printf("%s{\"id\":\"%s\",\"name\":\"%s\",\"group\":\"%s\",\"unit\":\"%s\",\"kind\":\"%s\",\"min\":%.9g,\"max\":%.9g,\"def\":%.9g,\"centre\":%.9g,\"reverse\":%s,\"choices\":[",
      i?",":"", esc(d.id).c_str(), esc(d.name).c_str(), esc(d.group).c_str(), esc(d.unit).c_str(),
      d.kind==Kind::Float?"float":(d.kind==Kind::Bool?"bool":"choice"), d.min,d.max,d.def,d.centre, d.reverse?"true":"false");
    for(size_t k=0;k<d.choices.size();++k) printf("%s\"%s\"", k?",":"", esc(d.choices[k]).c_str());
    printf("]}");
  }
  printf("],\"types\":[");
  for(int ty=0; ty<kNumVoiceTypes; ++ty){
    printf("%s{\"ready\":%s,\"variants\":[", ty?",":"", voiceTypeReady(ty)?"true":"false");
    int nv = numVariants(ty);
    for(int v=0; v<nv; ++v){ auto vals = presetValues(ty, v); printf("%s[", v?",":"");
      for(size_t i=0;i<vals.size();++i) printf("%s%.9g", i?",":"", vals[i]); printf("]"); }
    printf("]}");
  }
  printf("]}\n");
}
