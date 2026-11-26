/**
 * Sincronização SheetDB -> Neguedri Stream.
 * Propriedades do script:
 *   NEGUEDRI_SYNC_URL = URL base do Render, sem barra final
 *   NEGUEDRI_SYNC_SECRET = mesmo valor de SHEETDB_SYNC_WEBHOOK_SECRET no Render
 */
const ROTA_SINCRONIZACAO = '/api/sync/sheetdb';

function notificarAlteracaoPlanilha(e) {
  if (!e || !e.range) return;
  const nomeAba = e.range.getSheet().getName();
  const propriedades = PropertiesService.getScriptProperties();
  const abas = [
    propriedades.getProperty('NEGUEDRI_ADM_SHEET_NAME') || 'Adm',
    propriedades.getProperty('NEGUEDRI_USERS_SHEET_NAME') || 'BancodeDados'
  ];
  if (!abas.includes(nomeAba)) return;
  enviarSolicitacaoSincronizacao_(nomeAba);
}

function sincronizarPlanilhaDiariamente() {
  enviarSolicitacaoSincronizacao_();
}

function instalarTriggersSincronizacao() {
  const nomes = ['notificarAlteracaoPlanilha', 'sincronizarPlanilhaDiariamente'];
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (nomes.includes(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  });

  const planilha = SpreadsheetApp.getActive();
  if (!planilha) throw new Error('Este script precisa estar vinculado à planilha do sistema.');

  ScriptApp.newTrigger('notificarAlteracaoPlanilha')
    .forSpreadsheet(planilha)
    .onEdit()
    .create();
  ScriptApp.newTrigger('sincronizarPlanilhaDiariamente')
    .timeBased()
    .everyDays(1)
    .atHour(4)
    .create();
}

function enviarSolicitacaoSincronizacao_(nomeAba) {
  const propriedades = PropertiesService.getScriptProperties();
  const urlBase = (propriedades.getProperty('NEGUEDRI_SYNC_URL') || '').replace(/\/+$/, '');
  const segredo = propriedades.getProperty('NEGUEDRI_SYNC_SECRET') || '';
  if (!urlBase || !segredo) {
    throw new Error('Configure NEGUEDRI_SYNC_URL e NEGUEDRI_SYNC_SECRET nas propriedades do script.');
  }

  const payload = nomeAba ? { sheet: nomeAba } : {};
  const resposta = UrlFetchApp.fetch(urlBase + ROTA_SINCRONIZACAO, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + segredo },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = resposta.getResponseCode();
  if (status < 200 || status >= 300) {
    console.error('Sincronização SheetDB falhou. HTTP ' + status);
    throw new Error('A sincronização não foi concluída (HTTP ' + status + ').');
  }
}
