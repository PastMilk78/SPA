/**
 * Configuración del cliente de Twilio
 */
const twilio = require('twilio');

// Inicialización del cliente de Twilio
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Envía un mensaje de WhatsApp usando Twilio
 * @param {string} to - Número de destino en formato WhatsApp (whatsapp:+1234567890)
 * @param {string} body - Contenido del mensaje a enviar
 * @returns {Promise} - Promesa con el resultado del envío
 */
async function sendWhatsAppMessage(to, body) {
  try {
    // Asegurar que el número tiene el formato correcto
    if (!to.startsWith('whatsapp:')) {
      to = `whatsapp:${to}`;
    }
    
    // Enviar el mensaje
    const message = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      body: body,
      to: to
    });
    
    console.log(`Mensaje enviado con SID: ${message.sid}`);
    return message;
  } catch (error) {
    console.error('Error al enviar mensaje de WhatsApp:', error);
    throw error;
  }
}

/**
 * Valida si un número tiene el formato correcto para WhatsApp
 * @param {string} phoneNumber - Número a validar
 * @returns {boolean} - true si el formato es válido
 */
function isValidWhatsAppNumber(phoneNumber) {
  // Eliminar el prefijo "whatsapp:" si existe
  if (phoneNumber.startsWith('whatsapp:')) {
    phoneNumber = phoneNumber.substring(9);
  }
  
  // Validar formato internacional E.164 (código de país + número)
  // Este es un patrón simple; para una validación más completa,
  // considera usar una biblioteca específica
  const e164Pattern = /^\+[1-9]\d{1,14}$/;
  return e164Pattern.test(phoneNumber);
}

module.exports = {
  client,
  sendWhatsAppMessage,
  isValidWhatsAppNumber
}; 