// PC에서 켜기: node server.js  (Vercel에서는 이 파일 대신 api/index.js + public/ 가 쓰임)
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api');

const PORT = process.env.PORT || 3000;
const HTML = path.join(__dirname, 'public', 'index.html');

http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/api') return handler(req, res);
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(HTML));
  }
  res.writeHead(404).end();
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(require('os').networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`가족 대시보드: http://localhost:${PORT}  (저장소: ${process.env.FIREBASE_DB_URL ? 'Firebase' : 'data.json'})`);
  for (const a of ips) console.log(`  같은 와이파이의 태블릿·폰: http://${a}:${PORT}`);
});
