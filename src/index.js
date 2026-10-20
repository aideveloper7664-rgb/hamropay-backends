const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/order', require('./routes/order'));
app.use('/wallet', require('./routes/wallet'));
app.use('/admin', require('./routes/admin'));
app.use('/api/payment-link', require('./routes/links'));
app.use('/api/developer', require('./routes/developer'));
app.use('/api/cashier', require('./routes/cashier'));
app.use('/api/credits', require('./routes/credits'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/promo', require('./routes/promo'));

// Developer documentation + checkout widget (static files, src/static/)
const STATIC_DIR = path.join(__dirname, 'static');
const sendStatic = (file, type) => (req, res) => {
  res.set('Content-Type', type);
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(STATIC_DIR, file), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
};
app.get('/docs', sendStatic('docs.html', 'text/html; charset=utf-8'));
app.get('/docs.js', sendStatic('docs.js', 'application/javascript; charset=utf-8'));
app.get('/hamropay-pay.js', sendStatic('hamropay-pay.js', 'application/javascript; charset=utf-8'));

// Health check
app.get('/', (req, res) => {
  res.json({ name: 'HamroPay API', version: '2.0.0', status: 'running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HamroPay API running on port ${PORT}`);
});