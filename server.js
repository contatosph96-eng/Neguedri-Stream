const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 8080;

const JSON_PATH = path.join(__dirname, 'dados.json');
const FAV_PATH = path.join(__dirname, 'favoritos.json');
const HIST_PATH = path.join(__dirname, 'historico.json');
const PROGRESS_PATH = path.join(__dirname, 'progresso.json');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'manifest.webmanifest'));
});
app.get('/neguedri.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'neguedri.png'));
});
app.get('/player.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'player.html'));
});

function lerArquivoJSON(caminho) {
  if (fs.existsSync(caminho)) {
    try {
      const conteudo = fs.readFileSync(caminho, 'utf8');
      return JSON.parse(conteudo);
    } catch (e) {
      return {};
    }
  }
  return {};
}

function salvarArquivoJSON(caminho, dados) {
  fs.writeFileSync(caminho, JSON.stringify(dados, null, 2));
}

function lerUsuarios() {
  const data = lerArquivoJSON(JSON_PATH);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return [{ id: Date.now().toString(), ...data }];
  }
  return Array.isArray(data) ? data : [];
}

function formatarUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function chaveProgresso(item) {
  if (item.tipo === 'series') return `series:${item.seriesId || item.id}`;
  return `${item.tipo}:${item.id}`;
}

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// CRUD Perfis
app.get('/api/usuarios', (req, res) => {
  res.json(lerUsuarios());
});

app.post('/api/usuarios', (req, res) => {
  const usuarios = lerUsuarios();
  const novoPerfil = {
    id: Date.now().toString(),
    nome: (req.body.nome || 'Perfil').trim(),
    usuario: (req.body.usuario || '').trim(),
    senha: (req.body.senha || '').trim(),
    url: formatarUrl(req.body.url)
  };
  usuarios.push(novoPerfil);
  salvarArquivoJSON(JSON_PATH, usuarios);
  res.json({ sucesso: true, perfil: novoPerfil });
});

// APIs de Favoritos
app.get('/api/favoritos', (req, res) => {
  const { userId } = req.query;
  const favs = lerArquivoJSON(FAV_PATH);
  res.json(favs[userId] || []);
});

app.post('/api/favoritos', (req, res) => {
  const { userId, item } = req.body;
  let favs = lerArquivoJSON(FAV_PATH);
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

// APIs de Histórico
app.get('/api/historico', (req, res) => {
  const { userId } = req.query;
  const hist = lerArquivoJSON(HIST_PATH);
  
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

  let hist = lerArquivoJSON(HIST_PATH);
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

// Progresso de reprodução, separado por perfil e sincronizado entre dispositivos.
app.get('/api/progresso', (req, res) => {
  const { userId } = req.query;
  const progress = lerArquivoJSON(PROGRESS_PATH);
  const items = userId && Array.isArray(progress[userId]) ? progress[userId] : [];
  items.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  res.json(items);
});

app.post('/api/progresso', (req, res) => {
  const { userId, item, concluido } = req.body || {};
  if (!userId || !item || !['vod', 'series'].includes(item.tipo) || !item.id) {
    return res.status(400).json({ erro: 'Parâmetros de progresso inválidos.' });
  }

  let progress = lerArquivoJSON(PROGRESS_PATH);
  if (!progress || Array.isArray(progress) || typeof progress !== 'object') progress = {};
  if (!Array.isArray(progress[userId])) progress[userId] = [];

  const key = chaveProgresso(item);
  if (concluido) {
    progress[userId] = progress[userId].filter(saved => chaveProgresso(saved) !== key);
  } else {
    const existing = progress[userId].find(saved => chaveProgresso(saved) === key);
    const updatedAt = Number(item.updatedAt) || Date.now();

    // Ignora gravações periódicas que tenham chegado depois de uma posição mais recente.
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

// Proxy IPTV com Timeout e Tratamento de Erro Robusto
app.get('/api/iptv-proxy', async (req, res) => {
  const { userId, action, category_id, series_id } = req.query;
  const usuarios = lerUsuarios();
  const perfil = usuarios.find(u => u.id === userId) || usuarios[0];

  if (!perfil || !perfil.url || !perfil.usuario || !perfil.senha) {
    return res.status(400).json({ erro: "Perfil não encontrado ou credenciais inválidas." });
  }

  const baseUrl = formatarUrl(perfil.url);
  const user = encodeURIComponent(perfil.usuario);
  const pass = encodeURIComponent(perfil.senha);

  let remoteUrl = `${baseUrl}/player_api.php?username=${user}&password=${pass}&action=${action || 'get_live_categories'}`;
  if (category_id) remoteUrl += `&category_id=${encodeURIComponent(category_id)}`;
  if (series_id) remoteUrl += `&series_id=${encodeURIComponent(series_id)}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 segundos de timeout

    const response = await fetch(remoteUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).json({ erro: `Servidor remoto retornou erro ${response.status}` });
    }
    
    const data = await response.json();
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
