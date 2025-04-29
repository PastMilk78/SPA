/**
 * Módulo para manejar el historial de conversaciones con los usuarios
 */

// Almacén de conversaciones en memoria
// En producción, es recomendable usar una base de datos persistente
const conversations = new Map();

// Tiempo de expiración para una conversación (30 minutos en ms)
const CONVERSATION_EXPIRY = 30 * 60 * 1000;

/**
 * Añade un mensaje a la conversación del usuario
 * @param {string} userId - Identificador único del usuario
 * @param {object} message - Objeto con el mensaje y su rol
 * @returns {Array} - El historial de conversación actualizado
 */
function addMessage(userId, message) {
  const now = Date.now();
  
  if (!conversations.has(userId)) {
    // Iniciar nueva conversación con mensaje del sistema
    conversations.set(userId, {
      messages: [
        { role: "system", content: "Eres un asistente amigable que responde de manera concisa y útil." }
      ],
      lastUpdated: now
    });
  }

  const conversation = conversations.get(userId);
  
  // Actualizar la conversación
  conversation.messages.push(message);
  conversation.lastUpdated = now;
  
  // Si la conversación es demasiado larga, mantener solo los últimos 10 mensajes
  if (conversation.messages.length > 11) { // 1 system + 10 user/assistant
    conversation.messages = [
      conversation.messages[0], // Mantener el mensaje del sistema
      ...conversation.messages.slice(-10) // + los últimos 10 mensajes
    ];
  }
  
  return conversation.messages;
}

/**
 * Obtiene el historial de conversación para un usuario
 * @param {string} userId - Identificador único del usuario
 * @returns {Array|null} - El historial de conversación o null si no existe
 */
function getConversation(userId) {
  if (!conversations.has(userId)) {
    return null;
  }
  
  const conversation = conversations.get(userId);
  
  // Comprobar si la conversación ha expirado
  if (Date.now() - conversation.lastUpdated > CONVERSATION_EXPIRY) {
    conversations.delete(userId);
    return null;
  }
  
  return conversation.messages;
}

/**
 * Limpia las conversaciones expiradas
 */
function cleanupExpiredConversations() {
  const now = Date.now();
  
  for (const [userId, conversation] of conversations.entries()) {
    if (now - conversation.lastUpdated > CONVERSATION_EXPIRY) {
      conversations.delete(userId);
    }
  }
}

// Ejecutar limpieza cada 15 minutos
setInterval(cleanupExpiredConversations, 15 * 60 * 1000);

module.exports = {
  addMessage,
  getConversation,
  conversations // Exportamos el mapa de conversaciones para uso interno
}; 