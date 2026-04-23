import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

console.log('[DB] Инициализация...');
console.log('[DB] Config:', {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
});

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 10000,
});

try {
  const conn = await pool.getConnection();
  console.log('✅ [DB] Подключение успешно');
  conn.release();
} catch (err) {
  console.error('❌ [DB] Ошибка подключения:', err.message);
}

// ─── Уведомления по договорам ─────────────────────────────────────────────────

export async function notificationExists(dealId, type) {
  try {
    const [rows] = await pool.execute(
      'SELECT id, status FROM notifications WHERE deal_id = ? AND type = ?',
      [dealId, type]
    );
    if (rows.length > 0) {
      console.log(`[DB] Уведомление существует: deal_id=${dealId}, type=${type}, status=${rows[0].status}`);
      return rows[0];
    }
    return null;
  } catch (err) {
    console.error('[DB] Ошибка notificationExists:', err.message);
    return null;
  }
}

export async function createNotification({ dealId, type, contactId, leadId, dealTitle }) {
  try {
    console.log(`[DB] Создание уведомления:`, { dealId, type, contactId, leadId, dealTitle });
    const [result] = await pool.execute(
      `INSERT INTO notifications 
        (deal_id, type, status, contact_id, lead_id, deal_title)
       VALUES (?, ?, 'pending', ?, ?, ?)`,
      [dealId || null, type, contactId || null, leadId || null, dealTitle || null]
    );
    console.log(`✅ [DB] Уведомление создано: id=${result.insertId}`);
    return result;
  } catch (err) {
    console.error('[DB] Ошибка createNotification:', err.message);
    throw err;
  }
}

// ─── Уведомления по счетам ────────────────────────────────────────────────────

/**
 * Проверить существует ли уведомление по счёту + статусу
 */
export async function invoiceNotificationExists(invoiceId, invoiceStatus) {
  try {
    const [rows] = await pool.execute(
      'SELECT id, status FROM invoice_notifications WHERE invoice_id = ? AND invoice_status = ?',
      [invoiceId, invoiceStatus]
    );
    if (rows.length > 0) {
      console.log(`[DB] Invoice уведомление существует: invoice_id=${invoiceId}, invoice_status=${invoiceStatus}, status=${rows[0].status}`);
      return rows[0];
    }
    return null;
  } catch (err) {
    console.error('[DB] Ошибка invoiceNotificationExists:', err.message);
    return null;
  }
}

/**
 * Создать уведомление по счёту
 */
export async function createInvoiceNotification({
  invoiceId,
  dealId,
  contactId,
  leadId,
  invoiceStatus,
  amount,
  currency,
  notificationType,
}) {
  try {
    console.log(`[DB] Создание invoice уведомления:`, {
      invoiceId, dealId, contactId, leadId,
      invoiceStatus, amount, currency, notificationType,
    });

    const [result] = await pool.execute(
      `INSERT INTO invoice_notifications
        (invoice_id, deal_id, contact_id, lead_id, invoice_status, 
         amount, currency, notification_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        invoiceId, dealId || null, contactId || null, leadId || null,
        invoiceStatus, amount || null, currency || null, notificationType,
      ]
    );

    console.log(`✅ [DB] Invoice уведомление создано: id=${result.insertId}`);
    return result;
  } catch (err) {
    console.error('[DB] Ошибка createInvoiceNotification:', err.message);
    throw err;
  }
}

export default pool;