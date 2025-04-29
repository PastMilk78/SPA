/**
 * Configuración del chatbot
 */

// Mensajes de sistema para diferentes modos
const SYSTEM_MESSAGES = {
  default: "Eres un asistente amigable que responde de manera concisa y útil.",
  customer_service: "Eres un representante de servicio al cliente amable y profesional. Ayuda a los usuarios con sus consultas de manera clara y precisa.",
  educator: "Eres un tutor educativo que explica conceptos de forma simple y didáctica. Proporciona ejemplos útiles y fomenta el aprendizaje.",
  technical: "Eres un asistente técnico especializado. Proporciona respuestas detalladas y precisas a preguntas técnicas."
};

// Comandos especiales
const COMMANDS = {
  // Comando para reiniciar la conversación
  "/reiniciar": {
    description: "Reinicia la conversación actual",
    action: "restart_conversation"
  },
  // Comando para cambiar el modo de asistente
  "/modo": {
    description: "Cambia el modo del asistente. Uso: /modo [default|customer_service|educator|technical]",
    action: "change_mode"
  },
  // Comando para obtener ayuda
  "/ayuda": {
    description: "Muestra los comandos disponibles",
    action: "show_help"
  }
};

// Configuración del modelo
const MODEL_CONFIG = {
  model: "gpt-4o-mini",
  max_tokens: 300,
  temperature: 0.7
};

module.exports = {
  SYSTEM_MESSAGES,
  COMMANDS,
  MODEL_CONFIG
}; 