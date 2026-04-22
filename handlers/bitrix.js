import axios from 'axios';
import dotenv from 'dotenv';
import { notificationExists, createNotification } from '../db.js';
dotenv.config();

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const DEAL_CONTRACT_FIELD = process.env.DEAL_CONTRACT_FIELD;
const APP_TOKEN = process.env.BITRIX_APP_TOKEN;

/**
 * Проверка токена Б24
 */
export function validateToken(auth) {
  if (!APP_TOKEN) {
    console.log('[AUTH] ⚠️ BITRIX_APP_TOKEN не задан в .env — проверка отключена');
    return true;
  }

  const incoming = auth?.application_token;
  if (incoming !== APP_TOKEN) {
    console.log(`[AUTH] ❌ Неверный токен: "${incoming}"`);
    return false;
  }

  console.log('[AUTH] ✅ Токен верный');
  return true;
}

/**
 * Обработчик события ONCRMDEALUPDATE
 */
export async function handleDealUpdate(data) {
  console.log('\n[HANDLER] === Обработка ONCRMDEALUPDATE ===');
  console.log('[HANDLER] Входные данные:', JSON.stringify(data, null, 2));

  const dealId = data?.FIELDS?.ID;
  if (!dealId) {
    console.log('[HANDLER] ❌ Нет ID сделки');
    return;
  }

  console.log(`[HANDLER] Deal ID: ${dealId}`);

  // Получаем данные сделки
  const deal = await getDeal(dealId);
  if (!deal) {
    console.log(`[HANDLER] ❌ Сделка ${dealId} не найдена в Б24`);
    return;
  }

  // Проверяем поле договора
  await checkContractField(deal);
}

/**
 * Проверяем поле договора
 * Б24 возвращает "1" = Да, "0" или "" = Нет
 */
async function checkContractField(deal) {
  const dealId = deal.ID;
  const fieldValue = deal[DEAL_CONTRACT_FIELD];

  console.log(`\n[HANDLER] Проверка поля договора`);
  console.log(`[HANDLER] Поле: ${DEAL_CONTRACT_FIELD}`);
  console.log(`[HANDLER] Значение: "${fieldValue}"`);

  // Б24 поле Да/Нет: "1" = Да, "0" или "" = Нет
  if (fieldValue !== '1') {
    console.log(`[HANDLER] ℹ️ Поле договора не активно (значение="${fieldValue}"), пропускаем`);
    return;
  }

  console.log(`[HANDLER] ✅ Поле договора активно!`);

  // Проверяем нет ли уже такого уведомления
  const existing = await notificationExists(dealId, 'contract_ready');

  if (existing && existing.status === 'sent') {
    console.log(`[HANDLER] ℹ️ Уведомление уже отправлено для сделки ${dealId}, пропускаем`);
    return;
  }

  if (existing && existing.status === 'pending') {
    console.log(`[HANDLER] ℹ️ Уведомление уже в очереди (pending) для сделки ${dealId}, пропускаем`);
    return;
  }

  // Извлекаем данные сделки
  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;
  const dealTitle = deal.TITLE || `Сделка #${dealId}`;

  console.log(`[HANDLER] Данные сделки:`);
  console.log(`  TITLE:      ${dealTitle}`);
  console.log(`  CONTACT_ID: ${contactId}`);
  console.log(`  LEAD_ID:    ${leadId}`);

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID — некому отправлять`);
    return;
  }

  // Создаём уведомление в БД
  await createNotification({
    dealId: parseInt(dealId),
    type: 'contract_ready',
    contactId,
    leadId,
    dealTitle,
  });

  console.log(`✅ [HANDLER] Уведомление добавлено в очередь БД`);
}

/**
 * Получить сделку из Б24
 */
async function getDeal(dealId) {
  try {
    console.log(`\n[B24] crm.deal.get → ID=${dealId}`);
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.deal.get`,
      { id: dealId }
    );
    console.log(`[B24] Ответ:`, JSON.stringify(response.data?.result, null, 2));
    return response.data?.result || null;
  } catch (error) {
    console.error('[B24] Ошибка crm.deal.get:', error.message);
    return null;
  }
}