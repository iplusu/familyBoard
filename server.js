// PC에서 켜기: node server.js  (Vercel에서는 이 파일 대신 api/index.js + public/ 가 쓰임)
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api');

const PORT = process.env.PORT || 3000;
const FILES = { // public/ 의 파일만, 이름을 정해서 제공
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
};

http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/api') return handler(req, res);
  const f = req.method === 'GET' && FILES[p];
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(path.join(__dirname, 'public', f[0])));
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(require('os').networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`가족 대시보드: http://localhost:${PORT}  (저장소: ${process.env.FIREBASE_DB_URL ? 'Firebase' : 'data.json'})`);
  for (const a of ips) console.log(`  같은 와이파이의 태블릿·폰: http://${a}:${PORT}`);
});
