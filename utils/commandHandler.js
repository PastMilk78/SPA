/**
 * Manejador de comandos especiales del chatbot
 */

const { COMMANDS, SYSTEM_MESSAGES } = require('../config/bot');
const { conversations } = require('./conversations');

/**
 * Procesa un comando especial
 * @param {string} userId - ID único del usuario
 * @param {string} message - Mensaje completo recibido
 * @returns {Object} - Resultado del procesamiento del comando
 */
function processCommand(userId, message) {
  // Verificar si el mensaje es un comando
  const firstWord = message.trim().split(' ')[0].toLowerCase();
  
  if (!COMMANDS[firstWord]) {
    return { 
      isCommand: false 
    };
  }
  
  const command = COMMANDS[firstWord];
  const params = message.trim().split(' ').slice(1).join(' ');
  
  switch (command.action) {
    case 'restart_conversation':
      return handleRestartConversation(userId);
    
    case 'change_mode':
      return handleChangeMode(userId, params);
    
    case 'show_help':
      return handleShowHelp();
    
    default:
      return {
        isCommand: true,
        response: 'Comando no reconocido. Usa /ayuda para ver los comandos disponibles.'
      };
  }
}

/**
 * Maneja el comando para reiniciar la conversación
 */
function handleRestartConversation(userId) {
  // Eliminamos la conversación existente
  if (conversations.has(userId)) {
    conversations.delete(userId);
  }
  
  return {
    isCommand: true,
    response: '¡Conversación reiniciada! ¿En qué puedo ayudarte hoy?'
  };
}

/**
 * Maneja el comando para cambiar el modo del asistente
 */
function handleChangeMode(userId, mode) {
  mode = mode.trim().toLowerCase();
  
  // Verificar si el modo solicitado existe
  if (!SYSTEM_MESSAGES[mode]) {
    return {
      isCommand: true,
      response: `Modo no reconocido. Los modos disponibles son: ${Object.keys(SYSTEM_MESSAGES).join(', ')}`
    };
  }
  
  // Si no existe una conversación, no hay nada que cambiar
  if (!conversations.has(userId)) {
    return {
      isCommand: true,
      response: 'No se encontró una conversación activa. Inicia una nueva con el modo seleccionado.'
    };
  }
  
  // Cambiar el mensaje del sistema en la conversación existente
  const conversation = conversations.get(userId);
  
  // Si el primer mensaje es un mensaje del sistema, lo reemplazamos
  if (conversation.messages.length > 0 && conversation.messages[0].role === 'system') {
    conversation.messages[0].content = SYSTEM_MESSAGES[mode];
  } else {
    // Si no hay un mensaje del sistema, lo añadimos al principio
    conversation.messages.unshift({ 
      role: 'system', 
      content: SYSTEM_MESSAGES[mode] 
    });
  }
  
  return {
    isCommand: true,
    response: `¡Modo cambiado a "${mode}"! ¿En qué puedo ayudarte?`
  };
}

/**
 * Maneja el comando para mostrar ayuda
 */
function handleShowHelp() {
  // Construir mensaje de ayuda con todos los comandos disponibles
  let helpText = 'Comandos disponibles:\n\n';
  
  for (const [cmd, details] of Object.entries(COMMANDS)) {
    helpText += `${cmd}: ${details.description}\n`;
  }
  
  return {
    isCommand: true,
    response: helpText
  };
}

module.exports = {
  processCommand
}; 