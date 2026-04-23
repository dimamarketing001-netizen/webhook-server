import express from 'express';
import dotenv from 'dotenv';
import {
  handleDealUpdate,
  handleInvoiceAdd,
  handleInvoiceUpdate,
  validateToken,
} from './handlers/bitrix.js';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[SERVER] ${new Date().toISOString()}`);
  console.log(`[SERVER] ${req.method} ${req.url}`);
  console.log(`[SERVER] Body:`, JSON.stringify(req.body, null, 2));
  console.log(`${'='.repeat(50)}`);
  next();
});

app.get('/webhook/', (req, res) => {
  res.json({ status: 'ok', server: 'webhook-server', port: PORT });
});

app.post('/webhook/bitrix', async (req, res) => {
  console.log('\n[WEBHOOK] ← Запрос от Битрикс24');

  const auth = req.body?.auth;
  if (!validateToken(auth)) {
    console.log('[WEBHOOK] ❌ Отклонён — неверный токен');
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Сразу отвечаем Б24
  res.json({ status: 'ok' });

  try {
    const event = req.body?.event;
    const data = req.body?.data;

    console.log(`[WEBHOOK] Событие: "${event}"`);

    switch (event) {
      case 'ONCRMDEALUPDATE':
        await handleDealUpdate(data);
        break;

      case 'ONCRMINVOICEADD':
        await handleInvoiceAdd(data);
        break;

      case 'ONCRMINVOICEUPDATE':
        await handleInvoiceUpdate(data);
        break;

      default:
        console.log(`[WEBHOOK] ℹ️ Событие "${event}" не обрабатывается`);
    }
  } catch (error) {
    console.error('[WEBHOOK] ❌ Ошибка:', error.message);
    console.error('[WEBHOOK] Stack:', error.stack);
  }
});

app.use((req, res) => {
  console.log(`[SERVER] 404: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not found', path: req.url });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Webhook сервер запущен на порту ${PORT}`);
  console.log(`🔑 Поле договора: ${process.env.DEAL_CONTRACT_FIELD}`);
  console.log(`🛡️  Проверка токена: ${process.env.BITRIX_APP_TOKEN ? 'включена' : 'отключена'}`);
  console.log(`${'='.repeat(50)}\n`);
});