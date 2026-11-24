const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');

const results = [];
function record(kind, step, values) {
  const row = { kind, step, ...values };
  results.push(row);
  console.log(JSON.stringify(row));
}

async function readRange(url, kind, step) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('INVALID_DESTINATION');
  const start = Date.now();
  const destination = await dns.lookup(url.hostname, { family: 4 });
  if (ipaddr.process(destination.address).range() !== 'unicast') throw new Error('NON_PUBLIC_DESTINATION');
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let connected = false;
    const req = transport.get(url, {
      agent: false, family: 4, autoSelectFamily: false,
      lookup: (_host, _opts, cb) => cb(null, destination.address, 4),
      headers: { Range: 'bytes=0-31', Accept: 'video/mp4, */*', 'User-Agent': 'NeguedriStream/1.0' },
      signal: AbortSignal.timeout(35000)
    }, res => {
      record(kind, step, { status: res.statusCode, headersMs: Date.now()-start });
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, url);
        resolve({ next });
        res.destroy();
      } else if (res.statusCode === 206 || res.statusCode === 200) {
        let sample = Buffer.alloc(0);
        res.on('data', chunk => {
          sample = Buffer.concat([sample, chunk.subarray(0,32-sample.length)]);
          if (sample.length >= 12) {
            const mp4 = sample.subarray(4,8).toString() === 'ftyp';
            record(kind, step, { mp4, range: res.statusCode === 206 && /^bytes 0-31\//.test(res.headers['content-range'] || '') });
            resolve({});
            res.destroy();
          }
        });
        res.once('end', () => resolve({}));
        res.once('error', reject);
      } else {
        resolve({});
        res.destroy();
      }
    });
    req.on('socket', socket => socket.once('connect', () => {
      connected = true;
      record(kind, step, { tcpMs: Date.now()-start });
    }));
    req.on('error', err => {
      record(kind, step, { error: err.code || err.name, connected, elapsedMs: Date.now()-start });
      reject(err);
    });
  });
}

async function run() {
  const data = require(process.env.NEGUEDRI_TEST_CONFIG || './dados.json');
  const account = Array.isArray(data) ? data.find(d => String(d.id) === '1') : data;
  const origin = new URL(account.url);
  if (origin.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
  for (const [kind, id] of [['movie',17147720], ['series',16880750]]) {
    let url = new URL([kind,account.usuario,account.senha,id+'.mp4'].map(encodeURIComponent).join('/'), origin.origin + '/');
    for (let step=0; step<4; step++) {
      const { next } = await readRange(url, kind, step).catch(() => ({}));
      if (!next) break;
      if (next.hostname === 'google.com' || next.hostname.endsWith('.google.com')) {
        record(kind, step, { redirect: 'non-media' });
        break;
      }
      if (next.origin !== origin.origin &&
          [account.usuario,account.senha].some(value => decodeURIComponent(next.href).includes(value))) {
        record(kind, step, { redirect: 'contains-credentials' });
        break;
      }
      url = next;
    }
  }
  record('all','done',{});
}
if (process.env.IS_PULL_REQUEST === 'true') {
  http.createServer((req,res) => {
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(results));
  }).listen(process.env.PORT || 10000);
}
run().catch(() => record('all','setup-error',{}));
