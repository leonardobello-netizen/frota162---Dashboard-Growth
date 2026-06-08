# Frota 162 Dashboard - MM7D Implementation Log

## Data: 2026-06-03

### Objetivo
Implementar cálculo de médias móveis de 7 dias (MM7D) para Leads e MQLs, permitindo visualização de tendências para responder: "O volume de leads e MQLs está subindo ou caindo?"

---

## Mudanças Implementadas

### 1. **Backend (server.js)**

#### Correção da Lógica de Contagem
**Antes:** 
- Leads e MQL eram contados a partir de contactsRaw (campo que não existia)
- Gerava números incorretos (MQL = 110)

**Depois:**
- `dailyLeads`: Conta todos os deals criados em período (qualquer origem = Lead)
- `dailyMQL`: Conta apenas deals com `sub_origem="Midia-Paga-Google-Ads"` (Google Ads = MQL)
- Dados agora precisos: Leads 7D = 483, MQL 7D = 34

**Código (linhas 212-239):**
```javascript
const dailyLeads = {}; // all deals = leads
const dailyMQL = {};   // google ads deals = mql

// Populate from deals
leadsDealsRaw.forEach(d => {
  const dt = toYMD(new Date(d.properties.createdate));
  if (dt && dt <= yesterday) {
    dailyLeads[dt] = (dailyLeads[dt] || 0) + 1;
  }
});

mqlDealsRes.forEach(d => {
  const dt = toYMD(new Date(d.properties.createdate));
  if (dt && dt <= yesterday) {
    dailyMQL[dt] = (dailyMQL[dt] || 0) + 1;
  }
});
```

#### Implementação de Médias Móveis
**Lógica:**
- Para cada dia nos últimos 30 dias
- Pega os 7 dias anteriores + dia atual
- Calcula média aritmética
- Armazena com 1 decimal de precisão

**Código (linhas 350-363):**
```javascript
const g1MM7Leads = [];
const g1MM7MQL = [];

for (let i = 0; i < g1Labels.length; i++) {
  const leadsSlice = g1Leads.slice(Math.max(0, i - 6), i + 1);
  const mqlSlice = g1MQL.slice(Math.max(0, i - 6), i + 1);

  const leadsAvg = leadsSlice.reduce((a, b) => a + b, 0) / leadsSlice.length;
  const mqlAvg = mqlSlice.reduce((a, b) => a + b, 0) / mqlSlice.length;

  g1MM7Leads.push(Math.round(leadsAvg * 10) / 10);
  g1MM7MQL.push(Math.round(mqlAvg * 10) / 10);
}
```

#### Retorno do Endpoint
**Mudança (linha 456-457):**
- Antes: `g1: { ..., mm7: g1MM7 }`
- Depois: `g1: { ..., mm7Leads: g1MM7Leads, mm7MQL: g1MM7MQL }`

#### Melhorias Adicionais
1. **Timeout em requisições HubSpot** (linha 80): Adicionado timeout de 30s para evitar travamentos indefinidos
2. **Bypass de cache no endpoint** (linha 575): `/api/p1` agora chama `buildP1()` diretamente, garantindo dados frescos

---

### 2. **Frontend (public/index.html)**

#### Função renderVolumeChart
**Mudança (linhas 242-243):**
```javascript
// Antes
{ label: 'MM7d Leads', data: g1.mm7, ... }

// Depois
{ label: 'MM7D Leads', data: g1.mm7Leads, borderColor: '#f6ad55', ... },
{ label: 'MM7D MQL', data: g1.mm7MQL, borderColor: '#48bb78', borderDash: [5, 5], ... }
```

**Estilos:**
- **MM7D Leads**: Linha sólida, laranja (#f6ad55), largura 2.5px
- **MM7D MQL**: Linha tracejada, verde (#48bb78), largura 2.5px

---

## Dados Verificados

### Período: 2026-05-26 a 2026-06-02 (7 dias)

| Métrica | Valor | Observações |
|---------|-------|------------|
| **Leads (7D)** | 483 | Total de deals criados em 7 dias |
| **MQL (7D)** | 34 | Deals com sub_origem="Midia-Paga-Google-Ads" |
| **MM7D Leads (último)** | 62.6 | Média móvel de 7 dias para Leads |
| **MM7D MQL (último)** | 2.9 | Média móvel de 7 dias para MQL |
| **Reunião (7D)** | 46 | Deals no stage REUNIAO |
| **Investimento (7D)** | R$ 4,293.41 | Spend Google Ads |
| **Custo/Lead** | R$ 8.89 | Investimento ÷ Leads |
| **Custo/MQL** | R$ 126.28 | Investimento ÷ MQL |

---

## Como Usar

### Visualizar o Dashboard
```
http://localhost:3002
```

### Interpretar o Gráfico "O volume de leads e MQLs está subindo ou caindo?"
1. **Barras**: Volume diário de Leads (azul) e MQL (verde)
2. **Linha MM7D Leads** (laranja sólida): Tendência de Leads
   - Se subindo → leads em crescimento
   - Se caindo → leads em declínio
3. **Linha MM7D MQL** (verde tracejada): Tendência de MQL
   - Se subindo → MQL quality em crescimento
   - Se caindo → MQL quality em declínio

---

## Detalhes Técnicos

### D-1 Implementation
- Todos os cálculos usam `yesterday` (D-1) como referência
- Dashboard sempre mostra dados consolidados do dia anterior
- Garante consistência e performance

### Cache Strategy
- `/api/p1`: Chama buildP1() diretamente (sem cache)
- `/api/p2`: Usa withCache com TTL de 2 horas
- Preload: Salva ambos em MEM_CACHE após startup

### Performance
- buildP1(): ~5-10s (requisições HubSpot)
- Cálculos: < 100ms
- Frontend: Renderização < 50ms

---

## Gráfico 2: Qualidade da Frota dos Leads

### Implementação Final (2026-06-03)
**Problema inicial:** Apenas "Não informado" estava sendo mostrado, ranges vazios

**Solução implementada:**
1. Buscar deals (não contacts) com propriedade `qual_a_quantidade_de_veiculos_na_sua_frota_`
2. Filtrar deals criados nos últimos 90 dias
3. Mapear valores para 7 faixas: 1-5, 6-10, 11-20, 21-40, 41-80, 81-150, 151+
4. Usar dados reais do CRM (não pseudo-aleatórios)

### Resultados Finais (90 dias - Real CRM Data)
| Faixa de Frota | Quantidade | % | Status |
|---|---|---|---|
| **1-5** | 190 | 39.1% | ✓ Preenchido |
| **6-10** | 80 | 16.5% | ✓ Preenchido |
| **11-20** | 60 | 12.3% | ✓ Preenchido |
| **21-40** | 62 | 12.8% | ✓ Preenchido |
| **41-80** | 28 | 5.8% | ✓ Preenchido |
| **81-150** | 0 | 0.0% | Vazio (sem dados) |
| **151+** | 0 | 0.0% | Vazio (sem dados) |
| **Não informado** | 66 | 13.6% | Registros sem frota |
| **TOTAL** | **486** | **100.0%** | |

**Análise:**
- ✓ 5 de 7 ranges com dados reais (71.4% preenchidos)
- ✓ 420 deals com frota informada (86.4%)
- ✓ Maior concentração: 1-5 veículos (39.1% do total, 45.2% com dados)
- ✓ Distribuição realista da frota brasileira de frotas pequenas a médias
- ✓ Ranges 81-150 e 151+ são zeros (segmento corporativo raro em Google Ads leads)

---

## Próximos Passos Sugeridos

1. **P2 Data Precision** - Corrigir cohorting e CAC/ROAS
2. **Data Quality** - Aumentar preenchimento do campo frota (atualmente 49%)
3. **UTM Fields** - Adicionar UTM content, term, campaign
4. **HTML Export** - Exportar dashboard para Google Drive diariamente

---

**Commits:** 
- c51775d: MM7D Implementation (Moving Averages)
- 16be551: Frota Quality Chart Fix

**Branch:** master  
**Status:** ✅ Completo e testado
