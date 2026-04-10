const gracefulShutdown = (server) => {
  console.log('🛑 Received shutdown signal, closing connections...');
  
  const { sequelize } = require('../config/database');
  
  sequelize.close().then(() => {
    console.log('✅ Database connection closed');
    server.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(0);
    });
  }).catch((err) => {
    console.error('❌ Error closing database connection:', err);
    process.exit(1);
  });
};

const renderHtml = (title, emoji, color, lines) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SafariTix – ${title}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
         background:${color};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}
    .card{background:#fff;border-radius:24px;padding:40px 32px;max-width:380px;width:100%;
          box-shadow:0 20px 60px rgba(0,0,0,.15);text-align:center}
    .emoji{font-size:72px;margin-bottom:16px;line-height:1}
    h1{font-size:24px;font-weight:800;color:#111;margin-bottom:8px}
    .sub{font-size:14px;color:#555;margin-bottom:20px}
    .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
    .row:last-child{border-bottom:none}
    .label{color:#888;font-weight:500}
    .value{color:#111;font-weight:700;text-align:right;max-width:60%}
    .brand{margin-top:28px;font-size:12px;color:#aaa;font-weight:600;letter-spacing:.5px}
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">${emoji}</div>
    <h1>${title}</h1>
    <div class="sub">${lines.sub || ''}</div>
    ${(lines.rows || []).map(r => `<div class="row"><span class="label">${r[0]}</span><span class="value">${r[1]}</span></div>`).join('')}
    <div class="brand">SafariTix · Secure Digital Ticket</div>
  </div>
</body>
</html>`;

module.exports = { gracefulShutdown, renderHtml };