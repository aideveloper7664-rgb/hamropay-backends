const express = require('express');
const cors = require('cors');
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

// Health check
app.get('/', (req, res) => {
  res.json({ name: 'HamroPay API', version: '1.0.0', status: 'running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HamroPay API running on port ${PORT}`);
});