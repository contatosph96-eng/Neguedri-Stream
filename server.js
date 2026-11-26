const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('node:stream/promises');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = process.env.PORT || 1219;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.NEGUEDRI_DATA_DIR || __dirname;
const SHEETDB_API_URL = process.env.SHEETDB_API_URL || 'https://sheetdb.io/api/v1/ds6y8emd7rcda';
const SHEETDB_SHEET_NAME = process.env.SHEETDB_SHEET_NAME || 'BancodeDados';
const SHEETDB_ADM_SHEET_NAME = process.env.SHEETDB_ADM_SHEET_NAME || 'Adm';
const SHEETDB_BEARER_TOKEN = process.env.SHEETDB_BEARER_TOKEN || '';
const SHEETDB_SYNC_WEBHOOK_SECRET = process.env.SHEETDB_SYNC_WEBHOOK_SECRET || '';

const JSON_PATH = path.join(DATA_DIR, 'dados.json');
const USERS_AUTH_PATH = path.join(DATA_DIR, 'usuarios_sistema.json');
const FAV_PATH = path.join(DATA_DIR, 'favoritos.json');
const HIST_PATH = path.join(DATA_DIR, 'historico.json');
const PROGRESS_PATH = path.join(DATA_DIR, 'progresso.json');

let CONFIGURACAO_ADM = null;
const sincronizacoesPlanilhaAtivas = new Map();
const sincronizacoesPlanilhaPendentes = new Set();
const UM_MES_MS = 30 * 24 * 60 * 60 * 1000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Arquivos estáticos e PWA
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'manifest.webmanifest'));
});
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/neguedri.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'neguedri.png'));
});
app.get('/2neguedri.png', (req, res) => {
  res.sendFile(path.join(__dirname, '2neguedri.png'));
});
app.get('/player.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'player.html'));
});

function lerArquivoJSON(caminho, fallback = {}) {
  if (fs.existsSync(caminho)) {
    try {
      const conteudo = fs.readFileSync(caminho, 'utf8');
      return JSON.parse(conteudo);
    } catch (e) {
      return fallback;
    }
  }
  return fallback;
}

function salvarArquivoJSON(caminho, dados) {
  fs.writeFileSync(caminho, JSON.stringify(dados, null, 2));
}

function lerUsuariosIPTV() {
  const data = lerArquivoJSON(JSON_PATH, []);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return [{ id: '1', ...data }];
  }
  return Array.isArray(data) ? data : [];
}

function obterContaPrincipalIPTV() {
  if (!CONFIGURACAO_ADM) return null;

  return {
    id: '1',
    url: CONFIGURACAO_ADM.urlIptv,
    usuario: CONFIGURACAO_ADM.usuarioIptv,
    senha: CONFIGURACAO_ADM.senhaIptv
  };
}

function formatarUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function lerUsuariosSistema() {
  const lista = lerArquivoJSON(USERS_AUTH_PATH, []);
  return Array.isArray(lista) ? lista : [];
}

function salvarUsuariosSistema(lista) {
  salvarArquivoJSON(USERS_AUTH_PATH, lista);
}

function sheetDbUrl(suffix = '', sheetName = SHEETDB_SHEET_NAME) {
  const url = new URL(`${SHEETDB_API_URL.replace(/\/+$/, '')}${suffix}`);
  url.searchParams.set('sheet', sheetName);
  return url;
}

async function sheetDbRequest(
  method,
  suffix = '',
  body = undefined,
  rawValues = false,
  sheetName = SHEETDB_SHEET_NAME,
  ignoreCache = false
) {
  if (!SHEETDB_BEARER_TOKEN) {
    throw new Error('Token Bearer do SheetDB não foi configurado.');
  }
  const options = {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${SHEETDB_BEARER_TOKEN}`
    }
  };
  const url = sheetDbUrl(suffix, sheetName);
  if (rawValues) url.searchParams.set('mode', 'RAW');
  if (ignoreCache) url.searchParams.set('ignore_cache', '1');
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(`Não foi possível conectar ao SheetDB: ${error.message}`);
  }

  const responseText = await response.text();
  let result = {};
  if (responseText) {
    try {
      result = JSON.parse(responseText);
    } catch (_) {
      throw new Error(`O SheetDB retornou uma resposta inválida (HTTP ${response.status}).`);
    }
  }
  if (!response.ok) {
    const detail = result && typeof result.error === 'string' ? `: ${result.error}` : '';
    throw new Error(`SheetDB respondeu HTTP ${response.status}${detail}`);
  }
  return result;
}

async function buscarConfiguracaoAdmDaPlanilha() {
  const rows = await sheetDbRequest('GET', '', undefined, false, SHEETDB_ADM_SHEET_NAME, true);
  if (!Array.isArray(rows)) throw new Error('A guia Adm não retornou uma lista de configurações.');
  const row = rows.find(item => item && Object.values(item).some(value => String(value ?? '').trim() !== ''));
  if (!row) throw new Error('Preencha uma linha de dados na guia Adm.');

  const configuracao = {
    usuarioAdmin: String(row.usuarioAdmin || '').trim(),
    senhaAdmin: String(row.senhaAdmin || '').trim(),
    urlIptv: formatarUrl(String(row.urlIptv || '').trim()),
    usuarioIptv: String(row.usuarioIptv || '').trim(),
    senhaIptv: String(row.senhaIptv || '').trim()
  };
  const camposFaltando = Object.entries(configuracao)
    .filter(([, valor]) => !valor)
    .map(([campo]) => campo);
  if (camposFaltando.length) throw new Error(`Preencha na guia Adm: ${camposFaltando.join(', ')}.`);
  return configuracao;
}

function parseDataPlanilha(value, nomeCampo) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const texto = String(value).trim();
  const serial = Number(texto);
  if (Number.isFinite(serial) && serial >= 20000 && serial <= 100000) {
    return Date.UTC(1899, 11, 30) + Math.round(serial) * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;
  }

  let match = texto.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  match = texto.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12);

  const timestamp = Date.parse(texto);
  if (!Number.isFinite(timestamp)) throw new Error(`A data da coluna ${nomeCampo} não é válida: ${texto}`);
  return timestamp;
}

function dataParaPlanilha(timestamp) {
  if (!timestamp) return '';
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(Number(timestamp)));
  const valores = Object.fromEntries(partes.map(parte => [parte.type, parte.value]));
  return `${valores.year}-${valores.month}-${valores.day}`;
}

function booleanoPlanilha(value) {
  const texto = String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return ['sim', 's', 'true', '1', 'yes', 'bloqueado'].includes(texto);
}

function usuarioDaPlanilha(row) {
  const usuario = String(row.usuario || '').trim();
  const senha = String(row.senha || '').trim();
  const id = String(row.id || '').trim();
  if (!id || id === '1') throw new Error('Cada cliente precisa de um id único, diferente de 1 (reservado ao administrador).');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`O id ${id} só pode conter letras, números, hífen e sublinhado.`);
  if (!usuario || !senha || !String(row.nomeCliente || '').trim()) {
    throw new Error(`A linha do usuário ${id} precisa conter nomeCliente, usuario e senha.`);
  }
  return {
    id,
    nomeCliente: String(row.nomeCliente).trim(),
    usuario,
    senha,
    telefone: String(row.telefone || '').trim(),
    criadoEm: null,
    startedAt: parseDataPlanilha(row.dataInicio, 'dataInicio'),
    expiresAt: parseDataPlanilha(row.dataVencimento, 'dataVencimento'),
    bloqueadoManual: booleanoPlanilha(row.bloqueado)
  };
}

async function buscarUsuariosDaPlanilha() {
  const rows = await sheetDbRequest('GET', '', undefined, false, SHEETDB_SHEET_NAME, true);
  if (!Array.isArray(rows)) throw new Error('A aba BancodeDados precisa retornar uma lista de usuários.');
  const usuarios = rows
    .filter(row => row && Object.values(row).some(value => String(value ?? '').trim() !== ''))
    .map(usuarioDaPlanilha);
  const ids = new Set();
  const logins = new Set();
  for (const user of usuarios) {
    const login = user.usuario.toLocaleLowerCase('pt-BR');
    if (ids.has(user.id)) throw new Error(`O id ${user.id} está repetido na planilha.`);
    if (logins.has(login)) throw new Error(`O usuário ${user.usuario} está repetido na planilha.`);
    ids.add(user.id);
    logins.add(login);
  }
  return usuarios;
}

async function sincronizarAbaPlanilhaUmaVez(nomeAba) {
  if (nomeAba === SHEETDB_ADM_SHEET_NAME) {
    const configuracao = await buscarConfiguracaoAdmDaPlanilha();
    CONFIGURACAO_ADM = configuracao;
    return { aba: nomeAba, registros: 1 };
  }
  if (nomeAba === SHEETDB_SHEET_NAME) {
    const usuarios = await buscarUsuariosDaPlanilha();
    salvarUsuariosSistema(usuarios);
    return { aba: nomeAba, registros: usuarios.length };
  }
  throw new Error('A guia solicitada não está habilitada para sincronização.');
}

async function sincronizarAbaPlanilha(nomeAba) {
  if (![SHEETDB_ADM_SHEET_NAME, SHEETDB_SHEET_NAME].includes(nomeAba)) {
    throw new Error('A guia solicitada não está habilitada para sincronização.');
  }
  if (sincronizacoesPlanilhaAtivas.has(nomeAba)) {
    sincronizacoesPlanilhaPendentes.add(nomeAba);
    return sincronizacoesPlanilhaAtivas.get(nomeAba);
  }

  const sincronizacao = (async () => {
    let resultado;
    do {
      sincronizacoesPlanilhaPendentes.delete(nomeAba);
      resultado = await sincronizarAbaPlanilhaUmaVez(nomeAba);
    } while (sincronizacoesPlanilhaPendentes.has(nomeAba));
    return resultado;
  })();

  sincronizacoesPlanilhaAtivas.set(nomeAba, sincronizacao);
  try {
    return await sincronizacao;
  } finally {
    sincronizacoesPlanilhaAtivas.delete(nomeAba);
    sincronizacoesPlanilhaPendentes.delete(nomeAba);
  }
}

async function sincronizarPlanilhaCompleta() {
  if (SHEETDB_ADM_SHEET_NAME === SHEETDB_SHEET_NAME) {
    throw new Error('As guias de administração e usuários precisam ter nomes diferentes.');
  }
  const resultados = [];
  resultados.push(await sincronizarAbaPlanilha(SHEETDB_ADM_SHEET_NAME));
  resultados.push(await sincronizarAbaPlanilha(SHEETDB_SHEET_NAME));
  return resultados;
}

function webhookPlanilhaAutorizado(req) {
  const correspondencia = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!SHEETDB_SYNC_WEBHOOK_SECRET || !correspondencia) return false;
  const esperado = Buffer.from(SHEETDB_SYNC_WEBHOOK_SECRET, 'utf8');
  const recebido = Buffer.from(correspondencia[1], 'utf8');
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

async function atualizarLinhaPlanilha(id, campos) {
  const result = await sheetDbRequest('PATCH', `/id/${encodeURIComponent(String(id))}`, { data: campos }, true);
  if (Number(result.updated) !== 1) {
    throw new Error('A planilha não confirmou a atualização de exatamente um usuário.');
  }
  return result;
}

function formatarMesPtBr(timestamp) {
  const data = new Date(Number(timestamp || Date.now()));
  const nomeMes = data.toLocaleDateString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });
  return nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1);
}

function formatarDataPtBr(timestamp) {
  const data = new Date(Number(timestamp || Date.now()));
  return data.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function statusAssinatura(user) {
  if (!user) {
    return {
      vencido: true,
      bloqueadoManual: false,
      expiradoPorTempo: false,
      expiresAt: null,
      diasRestantes: 0
    };
  }
  if (user.role === 'admin') {
    return {
      vencido: false,
      bloqueadoManual: false,
      expiradoPorTempo: false,
      expiresAt: null,
      diasRestantes: null
    };
  }
  const bloqueadoManual = Boolean(user.bloqueadoManual);
  if (!user.expiresAt) {
    return {
      vencido: bloqueadoManual,
      bloqueadoManual,
      expiradoPorTempo: false,
      expiresAt: null,
      diasRestantes: 30
    };
  }
  const agora = Date.now();
  const restante = Number(user.expiresAt) - agora;
  const expiradoPorTempo = restante <= 0;
  return {
    vencido: bloqueadoManual || expiradoPorTempo,
    bloqueadoManual,
    expiradoPorTempo,
    expiresAt: Number(user.expiresAt),
    diasRestantes: Math.max(0, Math.ceil(restante / (24 * 60 * 60 * 1000)))
  };
}

function montarPayloadBloqueio(user, info) {
  const refData = info.expiresAt || Date.now();
  return {
    id: user.id,
    nomeCliente: user.nomeCliente || user.usuario,
    usuario: user.usuario,
    telefone: user.telefone || '',
    bloqueadoManual: Boolean(info.bloqueadoManual),
    expiradoPorTempo: Boolean(info.expiradoPorTempo),
    expiresAt: info.expiresAt,
    mesReferencia: formatarMesPtBr(refData),
    dataVencimento: formatarDataPtBr(refData)
  };
}

function chaveProgresso(item) {
  if (item.tipo === 'series') return `series:${item.seriesId || item.id}`;
  return `${item.tipo}:${item.id}`;
}

// Middleware que bloqueia acesso ao Gerenciador para qualquer conta que não seja o Usuário Principal
function exigirAdmin(req, res, next) {
  const userId = String(req.headers['x-user-id'] || req.query.userId || req.body?.adminUserId || '').trim();
  const userNome = String(req.headers['x-user-name'] || req.query.userName || req.body?.adminUserName || '').trim().toLowerCase();
  const userPass = String(req.headers['x-user-pass'] || '').trim();

  const admin = CONFIGURACAO_ADM;
  const ehPrincipal = Boolean(admin)
    && userId === '1'
    && userNome === admin.usuarioAdmin.toLowerCase()
    && userPass === admin.senhaAdmin;

  if (!ehPrincipal) {
    return res.status(403).json({ erro: 'Acesso restrito exclusivamente ao usuário principal.' });
  }
  return next();
}

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Login do sistema (Principal ou Usuário criado no Gerenciador)
app.post('/api/auth/login', async (req, res) => {
  const usuarioDigitado = String(req.body.usuario || '').trim();
  const senhaDigitada = String(req.body.senha || '').trim();

  if (!usuarioDigitado || !senhaDigitada) {
    return res.status(400).json({ erro: 'Informe usuário e senha.' });
  }

  const iptvPrincipal = obterContaPrincipalIPTV();
  const admin = CONFIGURACAO_ADM;

  // Usuário Principal, carregado da guia Adm
  if (
    usuarioDigitado.toLowerCase() === admin.usuarioAdmin.toLowerCase()
    && senhaDigitada === admin.senhaAdmin
  ) {
    return res.json({
      sucesso: true,
      usuario: {
        id: '1',
        nome: admin.usuarioAdmin,
        nomeCliente: admin.usuarioAdmin,
        senha: admin.senhaAdmin,
        role: 'admin',
        vencido: false,
        iptv: iptvPrincipal ? {
          url: formatarUrl(iptvPrincipal.url),
          usuario: iptvPrincipal.usuario,
          senha: iptvPrincipal.senha
        } : null
      }
    });
  }

  // Usuários criados no Gerenciador
  const usuarios = lerUsuariosSistema();
  const idx = usuarios.findIndex(
    u => String(u.usuario || '').trim().toLowerCase() === usuarioDigitado.toLowerCase()
      && String(u.senha || '').trim() === senhaDigitada
  );

  if (idx === -1) {
    return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
  }

  const agora = Date.now();
  if (!usuarios[idx].startedAt) {
    const startedAt = agora;
    const expiresAt = agora + UM_MES_MS;
    try {
      await atualizarLinhaPlanilha(usuarios[idx].id, {
        dataInicio: dataParaPlanilha(startedAt),
        dataVencimento: dataParaPlanilha(expiresAt)
      });
    } catch (error) {
      return res.status(502).json({ sucesso: false, erro: `Não foi possível registrar o primeiro acesso na planilha: ${error.message}` });
    }
    usuarios[idx].startedAt = startedAt;
    usuarios[idx].expiresAt = expiresAt;
    salvarUsuariosSistema(usuarios);
  }

  const info = statusAssinatura(usuarios[idx]);
  if (info.vencido) {
    return res.status(403).json({
      sucesso: false,
      vencido: true,
      bloqueadoManual: info.bloqueadoManual,
      expiradoPorTempo: info.expiradoPorTempo,
      erro: info.bloqueadoManual
        ? 'Bloqueio por restrição regional, uso de VPN ou proxy, violação de regras, falha técnica ou bloqueio pelo Usuário Administrador!'
        : 'Mensalidade vencida.',
      bloqueio: montarPayloadBloqueio(usuarios[idx], info)
    });
  }

  return res.json({
    sucesso: true,
    usuario: {
      id: usuarios[idx].id,
      nome: usuarios[idx].usuario,
      nomeCliente: usuarios[idx].nomeCliente || usuarios[idx].usuario,
      telefone: usuarios[idx].telefone || '',
      role: 'user',
      vencido: false,
      bloqueadoManual: false,
      startedAt: usuarios[idx].startedAt,
      expiresAt: info.expiresAt,
      diasRestantes: info.diasRestantes,
      iptv: iptvPrincipal ? {
        url: formatarUrl(iptvPrincipal.url),
        usuario: iptvPrincipal.usuario,
        senha: iptvPrincipal.senha
      } : null
    }
  });
});

// Verifica status do usuário em tempo real
app.get('/api/auth/status', (req, res) => {
  const { userId } = req.query;
  if (!userId || String(userId) === '1') {
    return res.json({ ativo: true, vencido: false, bloqueadoManual: false, expiradoPorTempo: false });
  }
  const usuarios = lerUsuariosSistema();
  const user = usuarios.find(u => String(u.id) === String(userId));
  if (!user) {
    return res.status(404).json({ ativo: false, vencido: true, bloqueadoManual: false, expiradoPorTempo: true });
  }
  const info = statusAssinatura(user);
  return res.json({
    ativo: !info.vencido,
    vencido: info.vencido,
    bloqueadoManual: info.bloqueadoManual,
    expiradoPorTempo: info.expiradoPorTempo,
    expiresAt: info.expiresAt,
    diasRestantes: info.diasRestantes,
    bloqueio: montarPayloadBloqueio(user, info)
  });
});

app.post('/api/sync/sheetdb', async (req, res) => {
  if (!SHEETDB_SYNC_WEBHOOK_SECRET) return res.status(503).json({ erro: 'Sincronização externa não está configurada.' });
  if (!webhookPlanilhaAutorizado(req)) return res.status(401).json({ erro: 'Não autorizado.' });

  const valorAba = req.body?.sheet;
  if (valorAba !== undefined && typeof valorAba !== 'string') {
    return res.status(400).json({ erro: 'A guia informada é inválida.' });
  }
  const nomeAba = valorAba === undefined ? null : valorAba.trim();
  if (valorAba !== undefined && !nomeAba) {
    return res.status(400).json({ erro: 'A guia informada é inválida.' });
  }

  try {
    const resultados = nomeAba
      ? [await sincronizarAbaPlanilha(nomeAba)]
      : await sincronizarPlanilhaCompleta();
    return res.json({
      sucesso: true,
      sincronizadas: resultados.map(({ aba, registros }) => ({ aba, registros }))
    });
  } catch (error) {
    console.error('Falha na sincronização SheetDB via webhook:', error.message);
    return res.status(502).json({ erro: 'Não foi possível sincronizar a planilha.' });
  }
});

// Gerenciador de Usuários (somente para o Usuário Principal)
app.get('/api/gerenciador/usuarios', exigirAdmin, (req, res) => {
  const usuarios = lerUsuariosSistema().map(u => {
    const info = statusAssinatura(u);
    return {
      id: u.id,
      nomeCliente: u.nomeCliente || u.usuario,
      usuario: u.usuario,
      senha: u.senha,
      telefone: u.telefone || '',
      criadoEm: u.criadoEm || null,
      startedAt: u.startedAt || null,
      expiresAt: info.expiresAt,
      diasRestantes: info.diasRestantes,
      vencido: info.vencido,
      bloqueadoManual: info.bloqueadoManual
    };
  });
  res.json({ sucesso: true, usuarios });
});

app.post('/api/gerenciador/usuarios', exigirAdmin, async (req, res) => {
  const nomeCliente = String(req.body.nomeCliente || '').trim();
  const usuario = String(req.body.usuario || '').trim();
  const senha = String(req.body.senha || '').trim();
  const telefone = String(req.body.telefone || '').trim();

  if (!nomeCliente || !usuario || !senha || !telefone) {
    return res.status(400).json({ erro: 'Preencha Nome Completo, Usuário, Senha e Telefone.' });
  }

  if (usuario.toLowerCase() === CONFIGURACAO_ADM.usuarioAdmin.toLowerCase()) {
    return res.status(400).json({ erro: 'Este nome de usuário é reservado ao principal.' });
  }

  const usuarios = lerUsuariosSistema();
  const jaExiste = usuarios.some(u => String(u.usuario || '').trim().toLowerCase() === usuario.toLowerCase());
  if (jaExiste) {
    return res.status(409).json({ erro: 'Já existe um usuário com esse nome.' });
  }

  const novoUsuario = {
    id: `u_${crypto.randomUUID()}`,
    nomeCliente,
    usuario,
    senha,
    telefone,
    criadoEm: Date.now(),
    startedAt: null,
    expiresAt: null,
    bloqueadoManual: false
  };

  try {
    const result = await sheetDbRequest('POST', '', {
      data: [{
        id: novoUsuario.id,
        nomeCliente: novoUsuario.nomeCliente,
        usuario: novoUsuario.usuario,
        senha: novoUsuario.senha,
        telefone: novoUsuario.telefone,
        dataInicio: '',
        dataVencimento: '',
        bloqueado: 'NAO'
      }]
    }, true);
    if (Number(result.created) !== 1) throw new Error('A planilha não confirmou a inclusão do usuário.');
    usuarios.unshift(novoUsuario);
    salvarUsuariosSistema(usuarios);
    res.json({ sucesso: true, usuario: novoUsuario });
  } catch (error) {
    res.status(502).json({ erro: `Não foi possível gravar o usuário na planilha: ${error.message}` });
  }
});

app.patch('/api/gerenciador/usuarios/:id', exigirAdmin, async (req, res) => {
  const { id } = req.params;
  const nomeCliente = String(req.body.nomeCliente || '').trim();
  const usuario = String(req.body.usuario || '').trim();
  const senha = String(req.body.senha || '').trim();
  const telefone = String(req.body.telefone || '').trim();
  if (!nomeCliente || !usuario || !senha || !telefone) {
    return res.status(400).json({ erro: 'Preencha nome, usuário, senha e telefone.' });
  }
  if (usuario.toLowerCase() === CONFIGURACAO_ADM.usuarioAdmin.toLowerCase()) {
    return res.status(400).json({ erro: 'Este nome de usuário é reservado ao principal.' });
  }

  const usuarios = lerUsuariosSistema();
  const idx = usuarios.findIndex(u => String(u.id) === String(id));
  if (idx === -1) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  const duplicado = usuarios.some((u, i) => i !== idx && String(u.usuario || '').trim().toLowerCase() === usuario.toLowerCase());
  if (duplicado) return res.status(409).json({ erro: 'Já existe um usuário com esse nome.' });

  try {
    await atualizarLinhaPlanilha(id, { nomeCliente, usuario, senha, telefone });
    Object.assign(usuarios[idx], { nomeCliente, usuario, senha, telefone });
    salvarUsuariosSistema(usuarios);
    res.json({ sucesso: true, usuario: usuarios[idx] });
  } catch (error) {
    res.status(502).json({ erro: `Não foi possível editar o usuário na planilha: ${error.message}` });
  }
});

// Bloquear ou desbloquear usuário manualmente
app.post('/api/gerenciador/usuarios/:id/bloquear', exigirAdmin, async (req, res) => {
  const { id } = req.params;
  const usuarios = lerUsuariosSistema();
  const idx = usuarios.findIndex(u => String(u.id) === String(id));
  if (idx === -1) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }
  const novoEstado = typeof req.body?.bloqueado === 'boolean'
    ? req.body.bloqueado
    : !Boolean(usuarios[idx].bloqueadoManual);

  try {
    await atualizarLinhaPlanilha(id, { bloqueado: novoEstado ? 'SIM' : 'NAO' });
    usuarios[idx].bloqueadoManual = novoEstado;
    salvarUsuariosSistema(usuarios);
    res.json({ sucesso: true, bloqueadoManual: novoEstado, usuario: usuarios[idx] });
  } catch (error) {
    res.status(502).json({ erro: `Não foi possível atualizar o bloqueio na planilha: ${error.message}` });
  }
});

// Renovar +30 dias a partir de agora e remover bloqueio manual
app.post('/api/gerenciador/usuarios/:id/renovar', exigirAdmin, async (req, res) => {
  const { id } = req.params;
  const usuarios = lerUsuariosSistema();
  const idx = usuarios.findIndex(u => String(u.id) === String(id));
  if (idx === -1) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }
  const agora = Date.now();
  const venceEm = agora + UM_MES_MS;
  try {
    await atualizarLinhaPlanilha(id, {
      dataInicio: dataParaPlanilha(agora),
      dataVencimento: dataParaPlanilha(venceEm),
      bloqueado: 'NAO'
    });
    usuarios[idx].startedAt = agora;
    usuarios[idx].expiresAt = venceEm;
    usuarios[idx].bloqueadoManual = false;
    salvarUsuariosSistema(usuarios);
    res.json({ sucesso: true, usuario: usuarios[idx] });
  } catch (error) {
    res.status(502).json({ erro: `Não foi possível renovar na planilha: ${error.message}` });
  }
});

// Excluir usuário
app.delete('/api/gerenciador/usuarios/:id', exigirAdmin, async (req, res) => {
  const { id } = req.params;
  const usuarios = lerUsuariosSistema();
  try {
    const result = await sheetDbRequest('DELETE', `/id/${encodeURIComponent(String(id))}`);
    if (!Number(result.deleted)) return res.status(404).json({ erro: 'O usuário não foi encontrado na planilha.' });
    const filtrados = usuarios.filter(u => String(u.id) !== String(id));
    salvarUsuariosSistema(filtrados);
    res.json({ sucesso: true });
  } catch (error) {
    res.status(502).json({ erro: `Não foi possível excluir o usuário da planilha: ${error.message}` });
  }
});

// APIs de Favoritos Individuais por Perfil
app.get('/api/favoritos', (req, res) => {
  const { userId } = req.query;
  const favs = lerArquivoJSON(FAV_PATH, {});
  res.json(Array.isArray(favs[userId]) ? favs[userId] : []);
});

app.post('/api/favoritos', (req, res) => {
  const { userId, item } = req.body;
  if (!userId || !item) {
    return res.status(400).json({ erro: 'Parâmetros inválidos.' });
  }
  let favs = lerArquivoJSON(FAV_PATH, {});
  if (Array.isArray(favs) || typeof favs !== 'object') favs = {};
  if (!favs[userId]) favs[userId] = [];

  const index = favs[userId].findIndex(i => String(i.id) === String(item.id) && i.tipo === item.tipo);
  if (index >= 0) {
    favs[userId].splice(index, 1);
  } else {
    favs[userId].push(item);
  }

  salvarArquivoJSON(FAV_PATH, favs);
  res.json({ sucesso: true, favoritos: favs[userId] });
});

// APIs de Histórico Individual
app.get('/api/historico', (req, res) => {
  const { userId } = req.query;
  const hist = lerArquivoJSON(HIST_PATH, {});
  if (!userId || !hist[userId] || !Array.isArray(hist[userId])) {
    return res.json([]);
  }
  res.json(hist[userId]);
});

app.post('/api/historico', (req, res) => {
  const { userId, item } = req.body;
  if (!userId || !item) {
    return res.status(400).json({ erro: "Parâmetros inválidos." });
  }

  let hist = lerArquivoJSON(HIST_PATH, {});
  if (Array.isArray(hist) || typeof hist !== 'object') hist = {};
  if (!hist[userId] || !Array.isArray(hist[userId])) {
    hist[userId] = [];
  }

  hist[userId] = hist[userId].filter(i => String(i.id) !== String(item.id));
  hist[userId].unshift(item);

  if (hist[userId].length > 30) {
    hist[userId].pop();
  }

  salvarArquivoJSON(HIST_PATH, hist);
  res.json({ sucesso: true, historico: hist[userId] });
});

// Progresso de reprodução individual por perfil
app.get('/api/progresso', (req, res) => {
  const { userId } = req.query;
  const progress = lerArquivoJSON(PROGRESS_PATH, {});
  const items = userId && Array.isArray(progress[userId]) ? progress[userId] : [];
  items.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  res.json(items);
});

app.post('/api/progresso', (req, res) => {
  const { userId, item, concluido } = req.body || {};
  if (!userId || !item || !['vod', 'series'].includes(item.tipo) || !item.id) {
    return res.status(400).json({ erro: 'Parâmetros de progresso inválidos.' });
  }

  let progress = lerArquivoJSON(PROGRESS_PATH, {});
  if (!progress || Array.isArray(progress) || typeof progress !== 'object') progress = {};
  if (!Array.isArray(progress[userId])) progress[userId] = [];

  const key = chaveProgresso(item);
  if (concluido) {
    progress[userId] = progress[userId].filter(saved => chaveProgresso(saved) !== key);
  } else {
    const existing = progress[userId].find(saved => chaveProgresso(saved) === key);
    const updatedAt = Number(item.updatedAt) || Date.now();

    if (!existing || Number(existing.updatedAt || 0) <= updatedAt) {
      const currentTime = Number(item.currentTime);
      const duration = Number(item.duration);
      const saved = {
        id: String(item.id),
        tipo: item.tipo,
        name: String(item.name || item.title || 'Sem título'),
        streamUrl: String(item.streamUrl || ''),
        stream_icon: String(item.stream_icon || ''),
        currentTime: Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0,
        duration: Number.isFinite(duration) ? Math.max(0, duration) : 0,
        updatedAt
      };

      if (item.tipo === 'series') {
        saved.seriesId = String(item.seriesId || item.id);
        saved.seriesTitle = String(item.seriesTitle || item.name || item.title || 'Série');
        saved.season = String(item.season || '1');
        saved.episodeNumber = String(item.episodeNumber || '1');
        saved.episodeIndex = Math.max(0, Number(item.episodeIndex) || 0);
      }

      progress[userId] = progress[userId].filter(savedItem => chaveProgresso(savedItem) !== key);
      progress[userId].unshift(saved);
      progress[userId] = progress[userId].slice(0, 50);
    }
  }

  salvarArquivoJSON(PROGRESS_PATH, progress);
  res.json({ sucesso: true, progresso: progress[userId] });
});

// Proxy de mídia compatível com redirecionamentos HLS e intervalos de MP4.
const HLS_SIGNING_KEY = process.env.HLS_SIGNING_KEY || crypto.randomBytes(32);

function assinarRecursoHls(url, origem, expira) {
  return crypto.createHmac('sha256', HLS_SIGNING_KEY)
    .update(JSON.stringify([origem, url, expira]))
    .digest('base64url');
}

function recursoHlsAutorizado(url, origem, query) {
  if (typeof query.exp !== 'string' || !/^\d{10}$/.test(query.exp) ||
      Number(query.exp) <= Date.now() / 1000 || typeof query.sig !== 'string') {
    return false;
  }

  const assinatura = Buffer.from(query.sig);
  const esperada = Buffer.from(assinarRecursoHls(url, origem, query.exp));
  return assinatura.length === esperada.length && crypto.timingSafeEqual(assinatura, esperada);
}

app.get('/api/stream-proxy', async (req, res) => {
  const { url } = req.query;
  const principal = obterContaPrincipalIPTV();

  if (!url || !principal) {
    return res.status(400).send('URL inválida.');
  }

  let origem;
  let targetUrl;
  try {
    origem = new URL(formatarUrl(principal.url)).origin;
    targetUrl = new URL(url);
  } catch (error) {
    return res.status(400).send('URL malformada.');
  }

  const protocoloPermitido = targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:';
  const possuiCredenciaisNaUrl = Boolean(targetUrl.username || targetUrl.password);
  const mesmaOrigem = targetUrl.origin === origem;
  const recursoAssinado = recursoHlsAutorizado(targetUrl.href, origem, req.query);

  if (!protocoloPermitido || possuiCredenciaisNaUrl || (!mesmaOrigem && !recursoAssinado)) {
    return res.status(403).send('Domínio não autorizado.');
  }

  const controller = new AbortController();
  const cancelarRequisicao = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', cancelarRequisicao);

  try {
    const headers = {
      'Accept-Encoding': 'identity',
      'User-Agent': 'IPTVSmartersPro'
    };
    if (req.headers.range && !targetUrl.pathname.toLowerCase().endsWith('.m3u8')) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(targetUrl, {
      headers,
      signal: controller.signal
    });

    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel();
      console.warn('Servidor de mídia respondeu com erro:', {
        status: upstream.status,
        host: targetUrl.host,
        contentType: upstream.headers.get('content-type') || 'desconhecido'
      });
      return res.status(upstream.status).send('Erro ao obter stream.');
    }

    const contentType = upstream.headers.get('content-type') || '';
    const respostaHls = targetUrl.pathname.toLowerCase().endsWith('.m3u8') ||
      contentType.toLowerCase().includes('mpegurl');

    if (respostaHls) {
      const playlistText = (await upstream.text()).replace(/^\uFEFF/, '');
      if (!playlistText.trimStart().startsWith('#EXTM3U')) {
        return res.status(502).send('Resposta de playlist inválida.');
      }

      const finalUrl = new URL(upstream.url || targetUrl.href);
      const expira = String(Math.floor(Date.now() / 1000) + 86400);

      function urlDoProxy(uri) {
        try {
          const recurso = new URL(uri, finalUrl);
          const protocoloRecursoPermitido = recurso.protocol === 'http:' || recurso.protocol === 'https:';
          if (!protocoloRecursoPermitido || recurso.username || recurso.password) return uri;

          const parametros = new URLSearchParams({ url: recurso.href });
          if (recurso.origin !== origem) {
            parametros.set('exp', expira);
            parametros.set('sig', assinarRecursoHls(recurso.href, origem, expira));
          }
          return '/api/stream-proxy?' + parametros.toString();
        } catch (error) {
          return uri;
        }
      }

      const playlistReescrita = playlistText
        .split(/\r?\n/)
        .map(linha => {
          const linhaTrimada = linha.trim();
          if (!linhaTrimada) return linha;
          if (!linhaTrimada.startsWith('#')) return urlDoProxy(linhaTrimada);

          return linha.replace(/URI="([^"]+)"/g, (correspondencia, uri) => {
            const urlReescrita = urlDoProxy(uri);
            return urlReescrita === uri ? correspondencia : 'URI="' + urlReescrita + '"';
          });
        })
        .join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(playlistReescrita);
    }

    res.status(upstream.status);
    ['content-type', 'content-range', 'accept-ranges'].forEach(cabecalho => {
      const valor = upstream.headers.get(cabecalho);
      if (valor) res.setHeader(cabecalho, valor);
    });

    const contentEncoding = upstream.headers.get('content-encoding');
    const contentLength = upstream.headers.get('content-length');
    if ((!contentEncoding || contentEncoding === 'identity') && contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    if (!upstream.headers.get('content-type') && targetUrl.pathname.toLowerCase().endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }

    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  } catch (error) {
    const causa = error.cause || {};
    console.error('Erro no stream-proxy:', {
      code: causa.code || error.code || error.name,
      host: targetUrl.host
    });
    if (!res.headersSent && !res.destroyed) {
      res.status(502).send('Falha na transmissão.');
    }
  } finally {
    res.off('close', cancelarRequisicao);
  }
});

// Proxy IPTV usando sempre a conta principal Neguedri
app.get('/api/iptv-proxy', async (req, res) => {
  const { action, category_id, series_id } = req.query;
  const perfil = obterContaPrincipalIPTV();

  if (!perfil || !perfil.url || !perfil.usuario || !perfil.senha) {
    return res.status(400).json({ erro: "Perfil principal Neguedri não configurado." });
  }

  const baseUrl = formatarUrl(perfil.url);
  const user = encodeURIComponent(perfil.usuario);
  const pass = encodeURIComponent(perfil.senha);

  let remoteUrl = `${baseUrl}/player_api.php?username=${user}&password=${pass}&action=${action || 'get_live_categories'}`;
  if (category_id) remoteUrl += `&category_id=${encodeURIComponent(category_id)}`;
  if (series_id) remoteUrl += `&series_id=${encodeURIComponent(series_id)}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(remoteUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'IPTVSmartersPro',
        'Accept': 'application/json'
      }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).json({ erro: `Servidor remoto retornou erro ${response.status}` });
    }
    
    let data = await response.json();

    const termosBloqueados = [
      'adulto', 'adult', 'xxx', '+18', '18+', 'erotico', 'erótico', 
      'sexo', 'private', 'brazzers', 'privates', 'playboy', 'venus', 
      'hot', 'lindoas', 'delicias', 'coroa', 'amador', 'porn',
      'bella da semana', 'espermagedom', 'sensual', 'fetiche', 'campeao de pica',
      'slumber party', 'shenannigans', 'shenanigans',
      'a lenda do demônio', 'a size classmate', 'abandon 100 nuki', 
      'accelerando date', 'ai wa kagi no kaz', 'albeya the anim', 
      'aikagi the animat', 'aisai nikki', 'ajin ga osuki man', 
      'shinsei kourin', 'dacryon', 'luna',
      'ajisal no chiru kor', 'akane wa tumari', 'akebi no hane maho', 
      'aki sora', 'aku no onna kanbu', 'allargando the an', 
      'amanane', 'ane koi suki kirai', 'ane kyun joshi ga', 
      'ane wa yanmama', 'anette san e lilian', 'aniki no yome san', 
      'aniyome wa jipperi', 'ano danchi no to', 'aoharu snatch', 
      'arbeit shiyou', 'asgaldh the disto', 'bikyaku seiko koi', 
      'bishoku ke no rule', 'bitch na izanai-san', 'boku dake no hen', 
      'boku ni harem se', 'boku to sensei to', 'bust to bust chik', 
      'buta hime-sama', 'chicchana onaka', 'chisana taubomi', 
      'class de otoko wa', 'colosseum no sen', 'cosplay', 
      'gomu o tsuketeru', 'i can', 'ikuusei', 'lenda do overfiend', 
      'mahou toukei lyris', 'oni chichi harem', 'yumemiru otome',
      'aibeya the animation', 'ajin ga osuki nan desu ne', 'ajisai no chiru koro ni',
      'akane wa tsumare somerareru', 'akebi no hana maho', 'amanee', 
      'aniyome wa ijippari', 'ano danchi no tsuma tachi wa the animation', 
      'arbeit shiyou lets arbeit', 'bikyaku seido kaichou ai', 'bitch na inane-sama', 
      'bust to bust chichi wa chichi ni', 'chiisana tsubomi no sono oku ni', 
      'gomu o tsukete to iimashita yo ne', 'ikusei', 'mahou touki lyristia'
    ];

    if (Array.isArray(data)) {
      data = data.filter(item => {
        const propriedadesItem = [
          item.name,
          item.title,
          item.series_name,
          item.category_name,
          item.plot,
          item.cast,
          item.cover,
          item.num
        ];

        const textoCompleto = propriedadesItem
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
        
        const contemTermo = termosBloqueados.some(termo => {
          const termoNormalizado = termo.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          return textoCompleto.includes(termoNormalizado);
        });

        return !contemTermo;
      });
    }

    res.json({
      sucesso: true,
      server: { baseUrl, usuario: perfil.usuario, senha: perfil.senha },
      data: data
    });
  } catch (error) {
    console.error("Erro no Proxy IPTV para action:", action, error.message);
    res.status(500).json({ erro: "Erro de conexão com o servidor IPTV", detalhes: error.message });
  }
});

async function iniciarServidor() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    await sincronizarPlanilhaCompleta();
    app.listen(PORT, HOST, () => {
      console.log(`\n==================================================`);
      console.log(` Neguedri Streaming Rodando!`);
      console.log(` Configuração principal/IPTV carregada da aba ${SHEETDB_ADM_SHEET_NAME}.`);
      console.log(` Usuários carregados da aba ${SHEETDB_SHEET_NAME}.`);
      console.log(` Acesse: http://localhost:${PORT}`);
      console.log(`==================================================\n`);
    });
  } catch (error) {
    console.error(`Falha ao sincronizar as guias do SheetDB: ${error.message}`);
    process.exit(1);
  }
}

iniciarServidor();
