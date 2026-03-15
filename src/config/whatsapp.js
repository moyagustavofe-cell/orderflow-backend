const WA_API_VERSION = 'v21.0';
const WA_API_BASE    = `https://graph.facebook.com/${WA_API_VERSION}`;

// Lee las vars en tiempo de ejecución (no al cargar el módulo)
// para garantizar que dotenv ya procesó el .env
function getCredentials() {
  return {
    token:         process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  };
}

/**
 * Retorna true si el token está configurado con un valor real.
 */
function isConfigured() {
  const { token } = getCredentials();
  return !!token && token !== 'TU_TOKEN_AQUI';
}

/**
 * Envía un mensaje de texto a un número de WhatsApp.
 * @param {string} to   Número en formato internacional sin +: "5491112345678"
 * @param {string} text Texto del mensaje
 */
async function sendTextMessage(to, text) {
  const { token, phoneNumberId } = getCredentials();

  console.log(`[WhatsApp] sendTextMessage → to=${to}, phoneNumberId=${phoneNumberId}, tokenPresente=${!!token && token !== 'TU_TOKEN_AQUI'}`);

  if (!token || token === 'TU_TOKEN_AQUI') {
    console.warn('[WhatsApp] WHATSAPP_TOKEN no configurado — mensaje no enviado a', to);
    return null;
  }

  const url = `${WA_API_BASE}/${phoneNumberId}/messages`;
  console.log(`[WhatsApp] POST ${url}`);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      }),
    });
  } catch (networkErr) {
    console.error('[WhatsApp] Error de red al enviar mensaje:', networkErr.message);
    throw networkErr;
  }

  const responseBody = await response.text();
  console.log(`[WhatsApp] Respuesta API — status: ${response.status}, body: ${responseBody}`);

  if (!response.ok) {
    throw new Error(`WhatsApp API ${response.status}: ${responseBody}`);
  }

  return JSON.parse(responseBody);
}

/**
 * Marca un mensaje como leído en WhatsApp.
 * @param {string} messageId   wamid.xxx recibido en el webhook
 */
async function markAsRead(messageId) {
  const { token, phoneNumberId } = getCredentials();
  if (!token || token === 'TU_TOKEN_AQUI') return;

  await fetch(`${WA_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  }).catch(err => console.error('[WhatsApp] markAsRead error:', err.message));
}

module.exports = { sendTextMessage, markAsRead, isConfigured };
