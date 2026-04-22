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

// Проверка подключения
try {
  const conn = await pool.getConnection();
  console.log('✅ [DB] Подключение успешно');
  conn.release();
} catch (err) {
  console.error('❌ [DB] Ошибка подключения:', err.message);
}

/**
 * Проверить существует ли уже уведомление
 */
export async function notificationExists(dealId, type) {
  try {
    const [rows] = await pool.execute(
      'SELECT id, status FROM notifications WHERE deal_id = ? AND type = ?',
      [dealId, type]
    );
    if (rows.length > 0) {
      console.log(`[DB] Уведомление уже существует: deal_id=${dealId}, type=${type}, status=${rows[0].status}`);
      return rows[0];
    }
    return null;
  } catch (err) {
    console.error('[DB] Ошибка notificationExists:', err.message);
    return null;
  }
}

/**
 * Создать уведомление со статусом pending
 */
export async function createNotification({ dealId, type, contactId, leadId, dealTitle }) {
  try {
    console.log(`[DB] Создание уведомления:`, { dealId, type, contactId, leadId, dealTitle });

    const [result] = await pool.execute(
      `INSERT INTO notifications 
        (deal_id, type, status, contact_id, lead_id, deal_title)
       VALUES (?, ?, 'pending', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = 'pending',
         contact_id = VALUES(contact_id),
         lead_id = VALUES(lead_id),
         deal_title = VALUES(deal_title),
         updated_at = CURRENT_TIMESTAMP`,
      [dealId, type, contactId || null, leadId || null, dealTitle || null]
    );

    console.log(`✅ [DB] Уведомление создано: id=${result.insertId}`);
    return result;
  } catch (err) {
    console.error('[DB] Ошибка createNotification:', err.message);
    throw err;
  }
}

export default pool;