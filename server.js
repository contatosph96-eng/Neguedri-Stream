const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const net = require('net');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

const JSON_PATH = path.join(__dirname, 'dados.json');
const USERS_AUTH_PATH = path.join(__dirname, 'usuarios_sistema.json');
const FAV_PATH = path.join(__dirname, 'favoritos.json');
const HIST_PATH = path.join(__dirname, 'historico.json');
const PROGRESS_PATH = path.join(__dirname, 'progresso.json');

const ADMIN_USER = process.env.ADMIN_USER || 'Neguedri';
const ADMIN_PASS = String(process.env.ADMIN_PASS || '281219').trim();
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASS || ADMIN_PASS;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const UM_MES_MS = 30 * 24 * 60 * 60 * 1000;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

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
  const temporario = `${caminho}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(dados, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporario, caminho);
}

function gerarTokenAdmin() {
  const payload = Buffer.from(JSON.stringify({ sub: '1', exp: Date.now() + ADMIN_SESSION_TTL_MS })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${assinatura}`;
}

function validarTokenAdmin(token) {
  try {
    const [payload, assinatura, extra] = String(token || '').split('.');
    if (!payload || !assinatura || extra) return false;
    const esperada = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest();
    const recebida = Buffer.from(assinatura, 'base64url');
    if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) return false;
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return dados.sub === '1' && Number(dados.exp) > Date.now();
  } catch (_) { return false; }
}

function lerUsuariosIPTV() {
  const data = lerArquivoJSON(JSON_PATH, []);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return [{ id: '1', ...data }];
  }
  return Array.isArray(data) ? data : [];
}

function obterContaPrincipalIPTV() {
  const usuarios = lerUsuariosIPTV();
  return usuarios.find(u => u.id === '1' && u.url && u.usuario && u.senha)
    || usuarios.find(u => u.url && u.usuario && u.senha)
    || null;
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
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!validarTokenAdmin(token)) return res.status(401).json({ erro: 'Sessão administrativa inválida ou expirada. Entre novamente.' });
  return next();
}

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Diagnóstico seguro da configuração de autenticação (não revela senhas).
app.get('/api/auth/diagnostico', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({
    sucesso: true,
    usuarioPrincipal: ADMIN_USER,
    senhaConfigurada: Boolean(ADMIN_PASS),
    origemSenha: process.env.ADMIN_PASS ? 'variavel ADMIN_PASS do Render' : 'senha padrão do código',
    variavelAdminPassDefinida: Boolean(process.env.ADMIN_PASS)
  });
});

// Login do sistema (Principal ou Usuário criado no Gerenciador)
app.post('/api/auth/login', (req, res) => {
  const usuarioDigitado = String(req.body.usuario || '').trim();
  const senhaDigitada = String(req.body.senha || '').trim();

  if (!usuarioDigitado || !senhaDigitada) {
    return res.status(400).json({ erro: 'Informe usuário e senha.' });
  }

  const iptvPrincipal = obterContaPrincipalIPTV();

  // Usuário Principal
  if (ADMIN_PASS && usuarioDigitado.toLowerCase() === ADMIN_USER.toLowerCase() && senhaDigitada === ADMIN_PASS) {
    return res.json({ sucesso: true, usuario: { id: '1', nome: ADMIN_USER, nomeCliente: ADMIN_USER, role: 'admin', vencido: false, token: gerarTokenAdmin() } });
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
    usuarios[idx].startedAt = agora;
    usuarios[idx].expiresAt = agora + UM_MES_MS;
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
  if (String(userId || '') === '1') {
    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!validarTokenAdmin(token)) return res.status(401).json({ ativo: false, vencido: true, erro: 'Sessão administrativa expirada.' });
    return res.json({ ativo: true, vencido: false, bloqueadoManual: false, expiradoPorTempo: false });
  }
  if (!userId) return res.status(400).json({ erro: 'Informe o usuário.' });
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

// Gerenciador de Usuários (somente para o Usuário Principal)
app.get('/api/gerenciador/usuarios', exigirAdmin, (req, res) => {
  const usuarios = lerUsuariosSistema().map(u => {
    const info = statusAssinatura(u);
    return {
      id: u.id,
      nomeCliente: u.nomeCliente || u.usuario,
      usuario: u.usuario,
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

app.post('/api/gerenciador/usuarios', exigirAdmin, (req, res) => {
  const nomeCliente = String(req.body.nomeCliente || '').trim();
  const usuario = String(req.body.usuario || '').trim();
  const senha = String(req.body.senha || '').trim();
  const telefone = String(req.body.telefone || '').trim();

  if (!nomeCliente || !usuario || !senha || !telefone) {
    return res.status(400).json({ erro: 'Preencha Nome Completo, Usuário, Senha e Telefone.' });
  }

  if (usuario.toLowerCase() === ADMIN_USER.toLowerCase()) {
    return res.status(400).json({ erro: 'Este nome de usuário é reservado ao principal.' });
  }

  const usuarios = lerUsuariosSistema();
  const jaExiste = usuarios.some(u => String(u.usuario || '').trim().toLowerCase() === usuario.toLowerCase());
  if (jaExiste) {
    return res.status(409).json({ erro: 'Já existe um usuário com esse nome.' });
  }

  const novoUsuario = {
    id: `u_${Date.now()}`,
    nomeCliente,
    usuario,
    senha,
    telefone,
    criadoEm: Date.now(),
    startedAt: null,
    expiresAt: null,
    bloqueadoManual: false
  };

  usuarios.unshift(novoUsuario);
  salvarUsuariosSistema(usuarios);
  res.json({ sucesso: true, usuario: { id: novoUsuario.id, nomeCliente: novoUsuario.nomeCliente, usuario: novoUsuario.usuario, telefone: novoUsuario.telefone, criadoEm: novoUsuario.criadoEm } });
});

// Bloquear ou desbloquear usuário manualmente
app.post('/api/gerenciador/usuarios/:id/bloquear', exigirAdmin, (req, res) => {
  const { id } = req.params;
  const usuarios = lerUsuariosSistema();
  const idx = usuarios.findIndex(u => String(u.id) === String(id));
  if (idx === -1) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }
  const novoEstado = typeof req.body?.bloqueado === 'boolean'
    ? req.body.bloqueado
    : !Boolean(usuarios[idx].bloqueadoManual);

  usuarios[idx].bloqueadoManual = novoEstado;
  salvarUsuariosSistema(usuarios);
  res.json({ sucesso: true, bloqueadoManual: novoEstado, usuario: usuarios[idx] });
});

// Renovar +30 dias a partir de agora e remover bloqueio manual
app.post('/api/gerenciador/usuarios/:id/renovar', exigirAdmin, (req, res) => {
  const { id } = req.params;
  const usuarios = lerUsuariosSistema();
  const idx = usuarios.findIndex(u => String(u.id) === String(id));
  if (idx === -1) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }
  const agora = Date.now();
  usuarios[idx].startedAt = agora;
  usuarios[idx].expiresAt = agora + UM_MES_MS;
  usuarios[idx].bloqueadoManual = false;
  salvarUsuariosSistema(usuarios);
  res.json({ sucesso: true, usuario: usuarios[idx] });
});

// Excluir usuário
app.delete('/api/gerenciador/usuarios/:id', exigirAdmin, (req, res) => {
  const { id } = req.params;
  const usuarios = lerUsuariosSistema();
  const filtrados = usuarios.filter(u => String(u.id) !== String(id));
  salvarUsuariosSistema(filtrados);
  res.json({ sucesso: true });
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

// Proxy de Stream HLS e arquivos de mídia.
// Reescreve segmentos e URIs declaradas em tags HLS (KEY, MAP, MEDIA etc.).
app.get('/api/stream-proxy', async (req, res) => {
  const { url } = req.query;
  const principal = obterContaPrincipalIPTV();

  if (!url || !principal || !principal.url) {
    return res.status(400).send('URL inválida ou conta principal não configurada.');
  }

  let baseUrl;
  let targetUrl;
  try {
    baseUrl = new URL(formatarUrl(principal.url));
    targetUrl = new URL(String(url));
  } catch (error) {
    return res.status(400).send('URL malformada.');
  }

  const crypto = require('crypto');
  const dns = require('dns').promises;

  const chaveProxy = () => process.env.STREAM_PROXY_SECRET || principal.senha;

  const assinaturaValida = (url, assinatura) => {
    if (!assinatura || !/^[a-f0-9]{64}$/i.test(String(assinatura))) return false;
    const esperada = crypto.createHmac('sha256', chaveProxy()).update(url.toString()).digest();
    const recebida = Buffer.from(String(assinatura), 'hex');
    return recebida.length === esperada.length && crypto.timingSafeEqual(recebida, esperada);
  };

  const ipv4Publico = (ip) => {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = p;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19)));
  };

  const ipPublico = (ip) => {
    const versao = net.isIP(ip);
    if (versao === 4) return ipv4Publico(ip);
    if (versao === 6) {
      const normalizado = ip.toLowerCase();
      if (normalizado === '::' || normalizado === '::1'
        || normalizado.startsWith('fc') || normalizado.startsWith('fd')
        || normalizado.startsWith('fe8') || normalizado.startsWith('fe9')
        || normalizado.startsWith('fea') || normalizado.startsWith('feb')
        || normalizado.startsWith('ff')) return false;
      const mapeado = normalizado.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      return mapeado ? ipv4Publico(mapeado[1]) : true;
    }
    return false;
  };

  const validarDestinoPublico = async (destino) => {
    if (!['http:', 'https:'].includes(destino.protocol)
      || destino.username || destino.password
      || !destino.hostname || destino.hostname === 'localhost'
      || destino.hostname.endsWith('.localhost') || destino.hostname.endsWith('.local')) {
      throw new Error('Destino externo inválido ou não permitido.');
    }

    const hostname = destino.hostname.replace(/^\\[|\\]$/g, '');
    if (net.isIP(hostname)) {
      if (!ipPublico(hostname)) throw new Error('Destino externo com endereço IP privado ou reservado.');
      return;
    }

    const enderecos = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!enderecos.length || enderecos.some(item => !ipPublico(item.address))) {
      throw new Error('O domínio externo resolve para endereço privado ou não público.');
    }
  };

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(403).send('Protocolo não autorizado.');
  }

  // URLs do provedor podem começar no domínio configurado. Recursos de CDN
  // externos só são aceitos quando assinados pelo próprio servidor.
  if (targetUrl.host !== baseUrl.host) {
    if (!assinaturaValida(targetUrl, req.query.sig)) {
      return res.status(403).send('Destino externo não autorizado.');
    }
    try {
      await validarDestinoPublico(targetUrl);
    } catch (error) {
      return res.status(403).send('Destino externo bloqueado por segurança.');
    }
  }

  let destinoEmUso = targetUrl;

  try {
    const headers = {
      'User-Agent': 'IPTVSmartersPro',
      'Accept': '*/*'
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const normalizarDestinoRedirect = async (candidate) => {
      const destino = candidate instanceof URL ? candidate : new URL(candidate);
      if (destino.host !== baseUrl.host) {
        await validarDestinoPublico(destino);
      }
      return destino;
    };

    const buscarUpstream = async (initialUrl) => {
      let atual = await normalizarDestinoRedirect(initialUrl);
      const visitadas = new Set();

      for (let tentativa = 0; tentativa < 8; tentativa++) {
        if (visitadas.has(atual.toString())) {
          throw new Error('Ciclo de redirecionamento detectado no servidor IPTV.');
        }
        visitadas.add(atual.toString());

        destinoEmUso = atual;
        console.info('[STREAM-UPSTREAM-REQUEST]', JSON.stringify({
          host: atual.host,
          protocol: atual.protocol,
          port: atual.port || '(padrão)',
          path: atual.pathname
        }));

        const resposta = await fetch(atual.toString(), {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(25000)
        });
        });

        const redirecionamentos = [301, 302, 303, 307, 308];
        if (!redirecionamentos.includes(resposta.status)) {
          return { response: resposta, finalUrl: atual };
        }

        const location = resposta.headers.get('location');
        if (!location) return { response: resposta, finalUrl: atual };

        const proximoDestino = new URL(location, atual);
        console.info('[STREAM-UPSTREAM-REDIRECT]', JSON.stringify({
          status: resposta.status,
          fromHost: atual.host,
          toHost: proximoDestino.host,
          toProtocol: proximoDestino.protocol,
          toPort: proximoDestino.port || '(padrão)',
          toPath: proximoDestino.pathname
        }));
        await resposta.body?.cancel().catch(() => {});
        atual = await normalizarDestinoRedirect(proximoDestino);
      }

      throw new Error('O servidor IPTV excedeu o limite de redirecionamentos.');
    };

    const criarUrlProxy = (resourceUrl, origem) => {
      const absolute = new URL(resourceUrl, origem);
      if (!['http:', 'https:'].includes(absolute.protocol) || absolute.username || absolute.password) {
        throw new Error('A playlist contém um recurso com destino inválido.');
      }
      const assinatura = absolute.host === baseUrl.host
        ? ''
        : crypto.createHmac('sha256', chaveProxy()).update(absolute.toString()).digest('hex');
      const query = 'url=' + encodeURIComponent(absolute.toString())
        + (assinatura ? '&sig=' + assinatura : '');
      return '/api/stream-proxy?' + query;
    };

    const resultadoUpstream = await buscarUpstream(targetUrl);
    const upstream = resultadoUpstream.response;
    const finalUrl = resultadoUpstream.finalUrl;

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send('Erro ao obter stream.');
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    console.info('[STREAM-PROXY]', JSON.stringify({
      status: upstream.status,
      contentType: contentType || '(ausente)',
      contentLength: upstream.headers.get('content-length') || '(desconhecido)',
      requestedPath: targetUrl.pathname,
      finalHost: finalUrl.host,
      range: req.headers.range || '(sem Range)'
    }));

    // Alguns provedores respondem com uma página HTML de bloqueio/erro
    // em vez do arquivo de mídia. Evita entregar HTML ao elemento <video>.
    if (contentType.includes('text/html')) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(502).send('O servidor IPTV retornou uma página HTML em vez do vídeo. Verifique os logs do Render.');
    }

    const isPlaylist = /\.m3u8(?:$|[?#])/i.test(targetUrl.pathname)
      || contentType.includes('mpegurl')
      || contentType.includes('x-mpegurl');

    if (isPlaylist) {
      const playlistText = await upstream.text();
      // A playlist pode redirecionar; URLs relativas devem partir do endereço final.
      const playlistBase = finalUrl;

      const rewritten = playlistText
        .split(/\r?\n/)
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          // URI="..." aparece, entre outras, em EXT-X-KEY, EXT-X-MAP,
          // EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF e EXT-X-SESSION-KEY.
          if (trimmed.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/gi, (match, uri) => {
              try {
                return 'URI="' + criarUrlProxy(uri, playlistBase) + '"';
              } catch (error) {
                console.warn('URI HLS ignorada:', error.message);
                return match;
              }
            });
          }

          try {
            return criarUrlProxy(trimmed, playlistBase);
          } catch (error) {
            console.warn('Segmento HLS ignorado:', error.message);
            return line;
          }
        })
        .join('\n');

      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    }

    res.status(upstream.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((header) => {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (!upstream.headers.get('content-type') && targetUrl.pathname.toLowerCase().endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
    if (req.headers.range && upstream.status === 206) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    // Registra a causa de rede sem expor URL completa, usuário ou senha IPTV.
    const causas = [];
    let causa = error;
    while (causa && causas.length < 4) {
      causas.push({
        name: causa.name || 'Error',
        code: causa.code || causa.errno || null,
        message: String(causa.message || '').slice(0, 300)
      });
      causa = causa.cause;
    }
    console.error('[STREAM-PROXY-ERROR]', JSON.stringify({
      requestedHost: targetUrl?.host || '(indisponível)',
      upstreamHost: destinoEmUso?.host || '(indisponível)',
      upstreamProtocol: destinoEmUso?.protocol || '(indisponível)',
      upstreamPort: destinoEmUso?.port || '(padrão)',
      upstreamPath: destinoEmUso?.pathname || '(indisponível)',
      causas
    }));
    if (!res.headersSent) {
      const status = /domínio não autorizado/i.test(error.message) ? 403 : 502;
      res.status(status).send(status === 403 ? error.message : 'Falha na transmissão. Consulte os logs do servidor.');
    } else {
      res.end();
    }
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
    let response;
    try {
      response = await fetch(remoteUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'IPTVSmartersPro', 'Accept': 'application/json' }
      });
    } finally {
      clearTimeout(timeoutId);
    }

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
    const causa = error.cause;
    console.error('[IPTV-API-ERROR]', JSON.stringify({
      action: action || 'get_live_categories',
      name: error.name || 'Error',
      code: error.code || causa?.code || causa?.errno || null,
      message: String(error.message || '').slice(0, 300),
      cause: causa ? {
        name: causa.name || 'Error',
        code: causa.code || causa.errno || null,
        message: String(causa.message || '').slice(0, 300)
      } : null
    }));
    res.status(502).json({ erro: "Falha de conexão com o servidor IPTV. Consulte os logs do servidor." });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter(info => info && !info.internal && (info.family === 'IPv4' || info.family === 4))
    .map(info => info.address);

  console.log(`\n==================================================`);
  console.log(` Neguedri Stream Rodando!`);
  console.log(` Acesse: http://localhost:${PORT}`);
  ips.forEach(ip => console.log(` Na rede local: http://${ip}:${PORT}`));
  console.log(`==================================================\n`);
});
