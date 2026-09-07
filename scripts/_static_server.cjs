/** _static_server.cjs — 临时静态服务器（预览 xieyin_demo 用，验证后可删） */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'res', 'xieyin_demo');
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === path.join(ROOT, '/') || req.url === '/' ? 'preview.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8377, () => console.log('serving on http://localhost:8377'));
