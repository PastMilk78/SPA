require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const OpenAI = require('openai');
const { addMessage, getConversation } = require('./utils/conversations');
const { processCommand } = require('./utils/commandHandler');
const { MODEL_CONFIG } = require('./config/bot');

// Configuración de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Configuración de Express
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Ruta para manejar los mensajes de WhatsApp
app.post('/whatsapp', async (req, res) => {
  try {
    const incomingMsg = req.body.Body || '';
    const from = req.body.From || '';  // Este será nuestro userId
    console.log(`Mensaje recibido de ${from}: ${incomingMsg}`);

    const twiml = new MessagingResponse();
    
    // Verificar si es un comando
    const commandResult = processCommand(from, incomingMsg);
    
    if (commandResult.isCommand) {
      // Es un comando, enviar respuesta directamente
      twiml.message(commandResult.response);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml.toString());
      return;
    }
    
    // No es un comando, procesar como mensaje normal
    // Agregar mensaje del usuario a la conversación
    const userMessage = { role: "user", content: incomingMsg };
    const conversationHistory = addMessage(from, userMessage);

    // Llamada a la API de OpenAI con el historial de la conversación
    const completion = await openai.chat.completions.create({
      model: MODEL_CONFIG.model,
      messages: conversationHistory,
      max_tokens: MODEL_CONFIG.max_tokens,
      temperature: MODEL_CONFIG.temperature
    });

    // Obtener la respuesta de GPT-4o mini
    const aiResponse = completion.choices[0].message.content;
    console.log(`Respuesta de la IA: ${aiResponse}`);

    // Agregar respuesta del asistente a la conversación
    addMessage(from, { role: "assistant", content: aiResponse });

    // Enviar respuesta
    twiml.message(aiResponse);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());

  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Ocurrió un error al procesar tu mensaje');
  }
});

// Ruta simple para verificar que el servidor está funcionando
app.get('/', (req, res) => {
  res.send('El servidor del chatbot de WhatsApp está funcionando');
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
}); 