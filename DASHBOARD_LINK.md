# Dashboard Frota 162 — Link Permanente

## Acesso ao Dashboard

### 🔗 **URL Fixa:**
```
http://localhost:3002
```

---

## Dashboard Vivo

Este é um **dashboard vivo** que reflete todas as atualizações em tempo real:

### Características:
- ✅ **D-1 Implementation**: Dados sempre consolidados do dia anterior
- ✅ **Atualização Manual**: Botão "Atualizar" no header
- ✅ **Cache Bust**: Cada refresh força busca de dados frescos
- ✅ **Timestamp**: Mostra hora da última atualização

### Como Usar:
1. **Abrir o Dashboard:**
   - Acesse: `http://localhost:3002`
   - Abra em navegador web moderno (Chrome, Firefox, Safari, Edge)

2. **Atualizar Dados:**
   - Clique no botão **"Atualizar"** no canto superior direito
   - Dashboard fará refresh automático com dados mais recentes
   - Timestamp atualizará mostrando a hora da última atualização

3. **Navegar entre Abas:**
   - **P1 — Operação**: Leads, MQL, Volume, Frota, Custo/MQL
   - **P2 — Resultado**: Efficiency, Cohort Analysis

---

## Dados Exibidos

### Aba P1 — Operação

#### KPIs (7 Dias)
- Leads (7D): Todos os contatos que geraram deals
- MQL (7D): Contatos de deals Google Ads
- Reunião (7D): Deals em estágio de reunião
- Investimento (7D): Spend Google Ads
- Custo/Lead: Investimento ÷ Leads
- Custo/MQL: Investimento ÷ MQL

#### Gráficos
1. **O volume de leads e MQLs está subindo ou caindo?**
   - Barras: Volume diário
   - MM7D Leads (laranja): Tendência de leads
   - MM7D MQL (verde tracejado): Tendência de MQL

2. **A qualidade da frota dos leads está melhorando?**
   - Distribuição por faixas de frota (1-5, 6-10, 11-20, etc)
   - Comparação 30D, 60D, 90D

3. **O custo para gerar um MQL está sob controle?**
   - Rolling 7 dias de Custo/MQL
   - Tendência de variação

4. **Campanhas Google Ads (Últimas 12)**
   - Spend, Leads, MQL, Custo/Lead, Custo/MQL
   - Ordenado por Spend (maior primeiro)

### Aba P2 — Resultado

#### Gráficos & Tabelas
1. **Efficiency (ROAS vs CAC)**: Últimos 12 meses
2. **Cohort Analysis**: Deals por mês com MRR, CAC, ROAS, Payback

---

## Atualização de Dados

### Frequência
- **Manual**: Clique no botão "Atualizar" quando desejar
- **Automática (Backend)**: Cache atualiza a cada 2 horas
- **D-1**: Dados sempre referem-se ao dia anterior (consolidados)

### Quando os dados são atualizados
- ✅ **Imediatamente**: Após clicar "Atualizar"
- ✅ **A cada novo load**: Página sempre busca dados frescos
- ✅ **Cache local**: Navegador mantém último estado em memória

---

## Tecnologia

### Stack
- **Frontend**: HTML5 + JavaScript vanilla + Chart.js
- **Backend**: Node.js + Express
- **API**: RESTful endpoints (`/api/p1`, `/api/p2`)
- **Dados**: HubSpot CRM, Google Ads CSV
- **Caching**: In-memory + Disk (2h TTL)

### Endpoints Disponíveis
```
GET /api/p1       → Dados P1 (KPIs, Gráficos, Campanhas)
GET /api/p2       → Dados P2 (Efficiency, Cohort)
GET /              → Dashboard HTML
```

---

## Histórico de Implementações

### ✅ Completo
- **c51775d**: MM7D Implementation (Moving Averages)
- **16be551**: Frota Quality Chart Fix
- **2a5357f**: Documentation Updates
- **Atual**: Dashboard Vivo + Botão Refresh

### 🔜 Próximos
- P2 Data Precision (Cohort, CAC/ROAS)
- UTM Fields (Content, Term, Campaign)
- HTML Export (Google Drive)
- Data Quality Improvements

---

## Troubleshooting

### Dashboard não carrega
- Verifique se o servidor está rodando: `npm start`
- Acesse `http://localhost:3002`
- Verifique o console do navegador (F12)

### Dados não atualizam
- Clique no botão "Atualizar"
- Se persistir, reinicie o servidor

### Erro ao atualizar
- Verifique conexão com HubSpot API
- Verifique token no arquivo `.env`
- Veja logs do servidor: `npm start`

---

## Contato & Suporte

Para atualizações, mudanças ou sugestões:
- Envie uma mensagem com o ajuste desejado
- Dashboard será atualizado em tempo real
- Use o botão "Atualizar" para ver as mudanças

---

**Status:** ✅ Dashboard Vivo em Produção  
**Última Atualização:** 2026-06-03  
**Próxima Revisão:** Conforme solicitações
