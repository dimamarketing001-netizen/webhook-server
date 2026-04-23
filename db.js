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

/**
 * Проверить существует ли уведомление
 * Для счетов ищем по invoice_id + type
 * Для договоров ищем по deal_id + type
 */
export async function notificationExists(entityId, type) {
  try {
    // Для счётов
    if (type === 'invoice_new' || type === 'invoice_confirmed') {
      const [rows] = await pool.execute(
        'SELECT id, status FROM notifications WHERE invoice_id = ? AND type = ?',
        [entityId, type]
      );
      if (rows.length > 0) {
        console.log(`[DB] Уведомление существует: invoice_id=${entityId}, type=${type}, status=${rows[0].status}`);
        return rows[0];
      }
      return null;
    }

    // Для договоров
    const [rows] = await pool.execute(
      'SELECT id, status FROM notifications WHERE deal_id = ? AND type = ?',
      [entityId, type]
    );
    if (rows.length > 0) {
      console.log(`[DB] Уведомление существует: deal_id=${entityId}, type=${type}, status=${rows[0].status}`);
      return rows[0];
    }
    return null;
  } catch (err) {
    console.error('[DB] Ошибка notificationExists:', err.message);
    return null;
  }
}

/**
 * Создать уведомление
 */
export async function createNotification({
  dealId,
  invoiceId = null,
  invoiceStatus = null,
  type,
  contactId,
  leadId,
  dealTitle,
}) {
  try {
    console.log(`[DB] Создание уведомления:`, {
      dealId, invoiceId, invoiceStatus, type, contactId, leadId, dealTitle,
    });

    const [result] = await pool.execute(
      `INSERT INTO notifications 
        (deal_id, invoice_id, invoice_status, type, status, contact_id, lead_id, deal_title)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        dealId || null,
        invoiceId || null,
        invoiceStatus || null,
        type,
        contactId || null,
        leadId || null,
        dealTitle || null,
      ]
    );

    console.log(`✅ [DB] Уведомление создано: id=${result.insertId}`);
    return result;
  } catch (err) {
    console.error('[DB] Ошибка createNotification:', err.message);
    throw err;
  }
}

export default pool;