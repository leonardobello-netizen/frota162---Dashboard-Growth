# 🔗 DASHBOARD OFICIAL — FROTA 162 REVOPS

## Link Único Oficial

```
http://localhost:3002
```

**ESTE É O ÚNICO LINK OFICIAL DO DASHBOARD**
- ✅ Sempre com dados atualizados
- ✅ Informações em tempo real
- ✅ Atualiza automaticamente ao carregar a página

---

## Como Acessar

### Opção 1: Iniciar Servidor (Recomendado)

**Windows:**
```powershell
# Abra PowerShell em C:\Users\Leonardo\Downloads\frota162-dash-v2\
.\start-dashboard.bat
```

Ou execute diretamente:
```powershell
cd "C:\Users\Leonardo\Downloads\frota162-dash-v2"
npm start
```

Após iniciar, o dashboard abrirá automaticamente em `http://localhost:3002`

### Opção 2: Abrir no Navegador

Se o servidor já está rodando:
- Chrome/Edge: `http://localhost:3002`
- Firefox: `http://localhost:3002`
- Safari: `http://localhost:3002`

---

## Garantias de Dados Frescos

✅ **Página sempre carrega dados atualizados**
- Cada acesso força busca de dados frescos (cache-busting)
- Timestamp mostra hora da última atualização
- Botão "Atualizar" no header para refresh manual

✅ **Dados consolidados de D-1 (ontem)**
- Dashboard sempre mostra dados de ontem consolidados
- Garante consistência para decisões estratégicas

✅ **Todos os gráficos em tempo real**
- P1 — Operação: Leads, MQL, Frota, Custo/MQL
- P2 — Resultado: Efficiency, Cohort Analysis

---

## O que Ver no Dashboard

### Aba P1 — Operação

**KPIs (últimos 7 dias):**
- Leads: Total de deals criados
- MQL: Deals do Google Ads
- Reunião: Deals em estágio de reunião
- Investimento: Spend Google Ads
- Custo/Lead e Custo/MQL

**Gráficos:**
1. **Volume & Tendência** → Leads e MQLs com MM7D (média móvel 7d)
2. **Qualidade da Frota** → Distribuição por faixa de veículos (1-5, 6-10, etc)
3. **Custo/MQL** → Variação do custo para gerar MQL
4. **Campanhas Google Ads** → Top 12 campanhas por spend

### Aba P2 — Resultado

**Gráficos:**
1. **Efficiency** → ROAS vs CAC por mês
2. **Cohort Analysis** → Deals por mês com MRR, CAC, ROAS, Payback

---

## Troubleshooting

### "Não conseguo acessar http://localhost:3002"

**1. Verificar se o servidor está rodando:**
```powershell
netstat -ano | findstr :3002
```

Se nada aparecer, o servidor não está rodando. Inicie:
```powershell
cd "C:\Users\Leonardo\Downloads\frota162-dash-v2"
npm start
```

**2. Porta 3002 bloqueada?**
Tente alternativa: `http://127.0.0.1:3002`

**3. Firewall do Windows**
- Verifique se porta 3002 está permitida
- Ou reinicie o firewall

### "Dados não atualizam"

1. Clique no botão **"Atualizar"** no header do dashboard
2. Ou recarregue a página (F5 ou Ctrl+R)
3. Dados devem estar frescos em < 5 segundos

### "Erro ao buscar dados"

1. Verifique console do navegador (F12)
2. Verifique se arquivo `.env` tem token HubSpot correto
3. Reinicie o servidor:
```powershell
npm start
```

---

## Informações Técnicas

**URL:** `http://localhost:3002`  
**Servidor:** Node.js + Express  
**Frontend:** HTML5 + Chart.js  
**Cache:** Desativado (sempre dados frescos)  
**Atualização:** Manual via botão ou automática ao carregar  

---

## Resumo Executivo

| Item | Status |
|------|--------|
| **Link Oficial** | ✅ http://localhost:3002 |
| **Dados Frescos** | ✅ Sempre atualizados |
| **Auto-startup** | ✅ Script start-dashboard.bat |
| **Cache-Busting** | ✅ Implementado em P1 e P2 |
| **Timestamp** | ✅ Hora da última atualização |

---

**Última Atualização:** 2026-06-03  
**Status:** ✅ PRONTO PARA PRODUÇÃO
