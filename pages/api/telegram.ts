import type { NextApiRequest, NextApiResponse } from 'next'
import TelegramBot from 'node-telegram-bot-api'
import OpenAI from 'openai'
import fetch from 'node-fetch'
import FormData from 'form-data'
import { MongoClient, Db, Collection } from 'mongodb'

// --- MongoDB Connection --- 
const MONGODB_URI = process.env.MONGODB_URI
const DB_NAME = 'telegramBot' // Puedes cambiar el nombre de la DB
const COLLECTION_NAME = 'temporalConversations'

if (!MONGODB_URI) {
  throw new Error('Please define the MONGODB_URI environment variable')
}

let client: MongoClient
let db: Db
let conversationsCollection: Collection<any>

async function connectToDatabase() {
  if (client && db) {
    return { client, db, conversationsCollection }
  }
  // Asegurar que MONGODB_URI es un string antes de usarlo
  if (typeof MONGODB_URI !== 'string') {
    console.error('MongoDB URI is not defined or not a string.');
    throw new Error('MongoDB URI misconfigured');
  }
  try {
    client = new MongoClient(MONGODB_URI)
    await client.connect()
    db = client.db(DB_NAME)
    conversationsCollection = db.collection(COLLECTION_NAME)
    console.log('Connected to MongoDB!')
    // Opcional: Crear índice TTL para limpieza automática después de X tiempo (ej. 1 hora)
    await conversationsCollection.createIndex({ "timestamp": 1 }, { expireAfterSeconds: 3600 })
    return { client, db, conversationsCollection }
  } catch (error) {
    console.error('Failed to connect to MongoDB', error)
    throw error
  }
}
// Inicializar conexión al arrancar (mejoraría con patrones de conexión más robustos para serverless)
connectToDatabase().catch(console.error)
// --------------------------

// --- Estrategia de acumulación ---
const CONVERSATION_WINDOW_MINUTES = 30 // Aumentamos la ventana a 30 minutos para más contexto
const BATCH_TIME_WINDOW_MS = 2000 // Ventana de tiempo para considerar mensajes "en ráfaga" (2 segundos)
const MAX_CONVERSATION_HISTORY = 15 // Máximo número de mensajes a incluir en el historial
const FORCED_DELAY_MS = 15000 // Espera forzada de 15 segundos antes de responder
// ------------------------------------

// Inicializar OpenAI (ya incluye GPT-4o con visión)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// Inicializar el bot con el token
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not defined')
}

// Crear una instancia del bot con el token
const bot = new TelegramBot(token, { polling: false })

type ResponseData = {
  message: string
}

/**
 * Procesa los mensajes de un chat, verificando si son parte de una "ráfaga" reciente
 */
async function processMessagesForChat(chatId: number, newMessageId: number, force: boolean = false) {
  try {
    console.log(`[${chatId}] Iniciando procesamiento para mensaje ${newMessageId} (force=${force})`)
    
    const { conversationsCollection } = await connectToDatabase()

    // Paso 1: Verificar si hay mensajes recientes (dentro de la ventana de tiempo de batch)
    const now = new Date()
    const cutoffTime = new Date(now.getTime() - BATCH_TIME_WINDOW_MS)
    
    // Contar mensajes recientes recibidos (dentro de la ventana de batch, excluyendo el actual)
    const recentCount = await conversationsCollection.countDocuments({
      chatId: chatId,
      message_id: { $ne: newMessageId },
      timestamp: { $gte: cutoffTime },
      status: "pending"
    })

    // Si hay mensajes recientes y no estamos forzando el procesamiento,
    // postergamos el procesamiento para permitir acumular más mensajes
    if (recentCount > 0 && !force) {
      console.log(`[${chatId}] Detectados ${recentCount} mensajes recientes, postergando procesamiento`)
      return
    }
    
    // Paso 2: Obtener todos los mensajes pendientes para este chat
    const pendingMessages = await conversationsCollection.find({
      chatId: chatId,
      status: "pending"
    }).sort({ timestamp: 1 }).toArray()
    
    if (pendingMessages.length === 0) {
      console.log(`[${chatId}] No hay mensajes pendientes para procesar`)
      return
    }
    
    // CAMBIO IMPORTANTE: Verificar tiempo desde el último mensaje
    // Obtener timestamp del mensaje más reciente
    const latestMsg = pendingMessages[pendingMessages.length - 1]
    const latestMsgTime = new Date(latestMsg.timestamp).getTime()
    const currentTime = Date.now()
    const timeSinceLastMsg = currentTime - latestMsgTime
    
    // Si no han pasado al menos 15 segundos desde el último mensaje Y no estamos forzando, salimos
    // En el siguiente mensaje verificaremos de nuevo
    if (timeSinceLastMsg < FORCED_DELAY_MS && !force) {
      console.log(`[${chatId}] Solo han pasado ${Math.round(timeSinceLastMsg/1000)} segundos desde el último mensaje. Necesitamos al menos ${Math.round(FORCED_DELAY_MS/1000)} segundos antes de procesar.`)
      
      // Marcar el mensaje con un estado especial para saber que está "esperando"
      await conversationsCollection.updateMany(
        { chatId: chatId, status: "pending" },
        { 
          $set: { 
            waitUntil: new Date(latestMsgTime + FORCED_DELAY_MS),
            waitingForDelay: true
          } 
        }
      )
      
      console.log(`[${chatId}] Mensajes marcados para procesar después de ${new Date(latestMsgTime + FORCED_DELAY_MS).toISOString()}`)
      return
    }
    
    // Si hay mensajes marcados como "esperando" pero ya pasó el tiempo, los procesamos
    if (!force) {
      const waitingMessages = await conversationsCollection.countDocuments({
        chatId: chatId,
        waitingForDelay: true,
        waitUntil: { $lte: now }
      })
      
      if (waitingMessages > 0) {
        console.log(`[${chatId}] Se encontraron ${waitingMessages} mensajes cuyo tiempo de espera ya pasó. Procesando...`)
        force = true
      }
    }
    
    console.log(`[${chatId}] Procesando ${pendingMessages.length} mensajes acumulados después de espera adecuada`)
    
    // Paso 3: Marcar mensajes como "processing"
    const messageIds = pendingMessages.map(m => m._id)
    await conversationsCollection.updateMany(
      { _id: { $in: messageIds } },
      { 
        $set: { 
          status: "processing",
          waitingForDelay: false, // Quitar marca de espera
          waitUntil: null // Limpiar el campo de tiempo
        } 
      }
    )
    
    // Paso 4: Procesar la conversación
    const result = await processConversation(chatId)
    
    if (result) {
      console.log(`[${chatId}] Procesamiento exitoso para ${pendingMessages.length} mensajes`)
    } else {
      console.log(`[${chatId}] El procesamiento no generó respuesta`)
    }
    
  } catch (error: any) {
    console.error(`[${chatId}] Error en processMessagesForChat:`, error?.message)
  }
}

// --- Handler principal (webhook) ---
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ message: `Method ${req.method} Not Allowed` })
  }

  try {
    const update = req.body

    if (update && update.message && update.message.chat && update.message.chat.id) {
      const chatId = update.message.chat.id
      const messageData = update.message
      const messageId = messageData.message_id

      // Conectar a DB (o reusar conexión)
      const { conversationsCollection } = await connectToDatabase()

      // Manejo especial para /start (respuesta rápida)
      if (messageData.text && messageData.text === '/start') {
        await conversationsCollection.insertOne({
          chatId: chatId,
          message: messageData,
          message_id: messageId,
          timestamp: new Date(),
          status: "processed" // Ya procesado directamente
        })
        
        await bot.sendMessage(chatId, '¡Hola! Soy un asesor de Solar Pro Argentina. ¿En qué puedo ayudarte?')
        return res.status(200).json({ message: '/start command handled' })
      }

      // NUEVO: Verificar si hay mensajes esperando tiempo y ya pasó el tiempo requerido
      const now = new Date()
      const waitingMessagesReady = await conversationsCollection.find({
        chatId: chatId,
        waitingForDelay: true,
        waitUntil: { $lte: now }
      }).toArray()
      
      if (waitingMessagesReady.length > 0) {
        console.log(`[${chatId}] Hay ${waitingMessagesReady.length} mensajes que esperaban tiempo y ya están listos para procesar`)
        
        // Guardar mensaje actual para procesarlo junto con los anteriores
        await conversationsCollection.insertOne({
          chatId: chatId,
          message: messageData,
          message_id: messageId,
          timestamp: new Date(),
          status: "pending" // Pendiente de procesamiento
        })
        console.log(`[${chatId}] Message saved to DB (ID: ${messageId}) - pending`)
        
        // Procesar todos inmediatamente, ya esperaron suficiente
        await processMessagesForChat(chatId, messageId, true)
        
        // Responder a Telegram inmediatamente para no bloquear
        res.status(200).json({ message: 'Update received and processed after delay' })
        return
      }

      // Guardar mensaje en MongoDB con estado "pending"
      await conversationsCollection.insertOne({
        chatId: chatId,
        message: messageData,
        message_id: messageId,
        timestamp: new Date(),
        status: "pending" // Pendiente de procesamiento
      })
      console.log(`[${chatId}] Message saved to DB (ID: ${messageId}) - pending`)

      // Procesar mensajes (o postergar si son parte de una ráfaga o necesitan más tiempo)
      await processMessagesForChat(chatId, messageId)

      // Responder a Telegram inmediatamente para no bloquear
      res.status(200).json({ message: 'Update received and queued for processing' })

    } else {
      console.log('Received update without message or chat ID:', JSON.stringify(update))
      res.status(400).json({ message: 'Invalid update structure' })
    }

  } catch (error: any) {
    console.error('General error in handler:', error?.message)
    res.status(500).json({ message: 'General error processing update handler' })
  }
}

// Modificar processConversation para usar el status y retornar resultado
async function processConversation(chatId: number): Promise<boolean> {
  console.log(`[${chatId}] ---- Entering processConversation ----`);
  try {
    const { conversationsCollection } = await connectToDatabase()

    // 1. Recuperar mensajes en estado "processing" para este chat (los que queremos procesar ahora)
    const messagesToProcess = await conversationsCollection.find({
      chatId: chatId,
      status: "processing" // Solo los que están esperando ser procesados ahora
    }).sort({ timestamp: 1 }).toArray()
    
    console.log(`[${chatId}] Retrieved ${messagesToProcess.length} messages to process:`, 
      messagesToProcess.length > 0 ? JSON.stringify(messagesToProcess.map(m => m.message.message_id)) : "none");

    if (messagesToProcess.length === 0) {
      console.log(`[${chatId}] No messages found to process.`)
      return false
    }
    
    // 2. Recuperar también mensajes históricos (procesados recientemente) para contexto
    const cutoffDate = new Date(Date.now() - CONVERSATION_WINDOW_MINUTES * 60 * 1000)
    const historyMessages = await conversationsCollection.find({
      chatId: chatId,
      status: "processed",
      timestamp: { $gte: cutoffDate }
    }).sort({ timestamp: -1 }) // Más recientes primero
    .limit(MAX_CONVERSATION_HISTORY) // Limitar cantidad para no sobrecargar
    .toArray()
    
    console.log(`[${chatId}] Retrieved ${historyMessages.length} historical messages for context`)
    
    // 3. Ordenar todos los mensajes cronológicamente (historia + nuevos)
    const allMessages = [...historyMessages.reverse(), ...messagesToProcess].sort((a, b) => {
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    })
    
    console.log(`[${chatId}] Processing ${messagesToProcess.length} new messages with ${historyMessages.length} historical messages for context (total: ${allMessages.length})`)
    
    // 4. Construir el contenido con todos los mensajes
    let userMessageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
    let hasProcessedMedia = false

    for (const msgDoc of allMessages) {
      const message = msgDoc.message
      let textPart = ''
      let imageBase64 = ''

      if (message.text) {
        if (!message.text.startsWith('/')) {
          textPart = message.text
          userMessageContent.push({ type: "text", text: textPart })
        }
      } else if (message.voice) {
        hasProcessedMedia = true
        try {
          const fileId = message.voice.file_id
          const fileLink = await bot.getFileLink(fileId)
          const audioResponse = await fetch(fileLink)
          if (!audioResponse.ok || !audioResponse.body) throw new Error('Failed to download audio')
          const form = new FormData()
          form.append('file', audioResponse.body, { filename: 'audio.ogg', contentType: 'audio/ogg' })
          form.append('model', 'whisper-1')
          const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
            body: form
          })
          const whisperResult = await whisperResponse.json()
          if (!whisperResponse.ok) throw new Error(`Whisper API Error: ${whisperResult?.error?.message}`)
          textPart = whisperResult.text
          userMessageContent.push({ type: "text", text: `(Audio transcrito: ${textPart})` })
          console.log(`[${chatId}] Transcription successful for message ${message.message_id}`)
        } catch (error: any) {
          console.error(`[${chatId}] Error during transcription for message ${message.message_id}:`, error.message)
          userMessageContent.push({ type: "text", text: `(Error al transcribir audio)` }) 
        }
      } else if (message.photo) {
        hasProcessedMedia = true
        try {
          const photo = message.photo[message.photo.length - 1]
          const fileId = photo.file_id
          const fileLink = await bot.getFileLink(fileId)
          const imageResponse = await fetch(fileLink)
          if (!imageResponse.ok) throw new Error('Failed to download photo')
          const imageBuffer = await imageResponse.buffer()
          imageBase64 = imageBuffer.toString('base64')
          // Añadir prompt + imagen
          userMessageContent.push({ type: "text", text: "Analiza la siguiente imagen enviada por el usuario en el contexto de Solar Pro Argentina." })
          userMessageContent.push({ 
            type: "image_url", 
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
          })
          console.log(`[${chatId}] Photo prepared for GPT Vision for message ${message.message_id}`)
        } catch (error: any) {
          console.error(`[${chatId}] Error processing photo for message ${message.message_id}:`, error.message)
          userMessageContent.push({ type: "text", text: `(Error al procesar imagen)` })
        }
      }
    }

    console.log(`[${chatId}] Constructed userMessageContent with ${userMessageContent.length} parts`);

    if (userMessageContent.length === 0) {
      console.log(`[${chatId}] No processable content found for GPT.`)
      // Marcar solo los mensajes que estaban en "processing" como "processed"
      await conversationsCollection.updateMany(
        { chatId: chatId, _id: { $in: messagesToProcess.map(m => m._id) } },
        { $set: { status: "processed" } }
      )
      console.log(`[${chatId}] Marked messages as processed.`)
      return false
    }

    try {
      console.log(`[${chatId}] Sending accumulated content to GPT-4o:`, userMessageContent.length, "parts")
      
      // Preparamos un mensaje más claro para el sistema sobre la conversación
      const systemMessage = `Actúas como un asesor de Solar Pro Argentina (https://solarproargentina.com/). 
Eres parte del equipo humano. No menciones que eres IA. 

CONTEXTO: A continuación verás una conversación que puede incluir mensajes recientes y anteriores. 
IMPORTANTE: Debes entender el HILO COMPLETO de la conversación, no solo responder al último mensaje.
Analiza todos los mensajes del usuario para dar una respuesta coherente.

Tu misión es resolver dudas sobre paneles solares, explicar beneficios, informar sobre servicios (domiciliarios, comerciales, industriales), 
promover cotizaciones gratuitas (web/WhatsApp) y generar confianza (compromiso, sustentabilidad, calidad, atención personalizada). 

Usa lenguaje sencillo y cálido. No inventes precios/productos. Si no sabes algo, invita a contactar a un asesor. 
Evita tecnicismos excesivos. Sé cordial y enfócate en lo que el cliente está preguntando.

Si hay imágenes, analízalas en el contexto de Solar Pro (producto, factura, instalación relevante?). Nunca digas que eres un bot.`;
      
      const completion = await openai.chat.completions.create({
        model: "gpt-4o", 
        messages: [
          { 
            role: "system", 
            content: systemMessage
          },
          { 
            role: "user", 
            content: userMessageContent // Array acumulado con historial + nuevos mensajes
          } 
        ],
      })
      
      const reply = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu consulta en este momento.'
      console.log(`[${chatId}] GPT Response generated: ${reply.substring(0, 50)}...`);
      
      try {
        await bot.sendMessage(chatId, reply)
        console.log(`[${chatId}] Response sent to Telegram.`)
      } catch (sendError: any) {
        console.error(`[${chatId}] ERROR ENVIANDO MENSAJE A TELEGRAM:`, sendError?.message)
        try {
          await bot.sendMessage(chatId, 'Lo siento, tuve un problema al enviar mi respuesta. Por favor, intenta nuevamente.')
        } catch (e) {
          console.error(`[${chatId}] ERROR FATAL AL ENVIAR MENSAJE DE ERROR:`, e)
        }
      }

      // Marcar SOLO los mensajes que estaban en "processing" como "processed"
      // Los mensajes históricos ya estaban como "processed"
      await conversationsCollection.updateMany(
        { chatId: chatId, _id: { $in: messagesToProcess.map(m => m._id) } },
        { $set: { status: "processed" } }
      )
      console.log(`[${chatId}] Marked ${messagesToProcess.length} new messages as processed.`)
      
      return true

    } catch (error: any) {
      console.error(`[${chatId}] Error with OpenAI API call:`, error?.message)
      
      try {
        await bot.sendMessage(chatId, 'Lo siento, hubo un error al intentar generar una respuesta. Por favor, intenta de nuevo.')
        console.log(`[${chatId}] Error message sent to user.`)
      } catch (sendError: any) {
        console.error(`[${chatId}] CRITICAL: Failed to send error message:`, sendError?.message)
      }
      
      // En caso de error, marcar mensajes como fallidos pero no eliminarlos
      await conversationsCollection.updateMany(
        { chatId: chatId, _id: { $in: messagesToProcess.map(m => m._id) } },
        { $set: { status: "error" } }
      )
      console.log(`[${chatId}] Marked messages as error.`)
      
      return false
    }

  } catch (processError: any) {
    console.error(`[${chatId}] Error in processConversation function:`, processError.message)
    
    try {
      await bot.sendMessage(chatId, 'Lo siento, ocurrió un error interno grave al procesar tu conversación.')
      console.log(`[${chatId}] Critical error message sent to user.`)
    } catch (e) {
      console.error(`[${chatId}] CRITICAL: Failed to send critical error message:`, e)
    }
    
    return false
  }
}

/**
 * Función exportada para ser llamada desde el cron job
 */
export async function processConversationFromCron(
  chatId: number, 
  messagesToProcess: any[], 
  historyMessages: any[]
): Promise<boolean> {
  console.log(`[${chatId}][CRON] Procesando conversación desde cron job`);
  try {
    // Combinamos y ordenamos los mensajes
    const allMessages = [...historyMessages, ...messagesToProcess].sort((a, b) => {
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
    
    console.log(`[${chatId}][CRON] Total ${allMessages.length} mensajes (${messagesToProcess.length} nuevos, ${historyMessages.length} históricos)`);
    
    // Construir el contenido para OpenAI con todos los mensajes
    let userMessageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    
    for (const msgDoc of allMessages) {
      const message = msgDoc.message;
      let textPart = '';
      let imageBase64 = '';

      if (message.text) {
        if (!message.text.startsWith('/')) {
          textPart = message.text;
          userMessageContent.push({ type: "text", text: textPart });
        }
      } else if (message.voice) {
        // Procesamiento de audio
        try {
          const fileId = message.voice.file_id;
          const fileLink = await bot.getFileLink(fileId);
          const audioResponse = await fetch(fileLink);
          if (!audioResponse.ok || !audioResponse.body) throw new Error('Failed to download audio');
          const form = new FormData();
          form.append('file', audioResponse.body, { filename: 'audio.ogg', contentType: 'audio/ogg' });
          form.append('model', 'whisper-1');
          const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
            body: form
          });
          const whisperResult = await whisperResponse.json();
          if (!whisperResponse.ok) throw new Error(`Whisper API Error: ${whisperResult?.error?.message}`);
          textPart = whisperResult.text;
          userMessageContent.push({ type: "text", text: `(Audio transcrito: ${textPart})` });
        } catch (error: any) {
          console.error(`[${chatId}][CRON] Error transcribiendo audio:`, error.message);
          userMessageContent.push({ type: "text", text: `(Error al transcribir audio)` });
        }
      } else if (message.photo) {
        // Procesamiento de imagen
        try {
          const photo = message.photo[message.photo.length - 1];
          const fileId = photo.file_id;
          const fileLink = await bot.getFileLink(fileId);
          const imageResponse = await fetch(fileLink);
          if (!imageResponse.ok) throw new Error('Failed to download photo');
          const imageBuffer = await imageResponse.buffer();
          imageBase64 = imageBuffer.toString('base64');
          userMessageContent.push({ type: "text", text: "Analiza la siguiente imagen enviada por el usuario en el contexto de Solar Pro Argentina." });
          userMessageContent.push({ 
            type: "image_url", 
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
          });
        } catch (error: any) {
          console.error(`[${chatId}][CRON] Error procesando imagen:`, error.message);
          userMessageContent.push({ type: "text", text: `(Error al procesar imagen)` });
        }
      }
    }

    if (userMessageContent.length === 0) {
      console.log(`[${chatId}][CRON] No hay contenido procesable`);
      return false;
    }

    // Preparar mensaje para GPT
    const systemMessage = `Actúas como un asesor de Solar Pro Argentina (https://solarproargentina.com/). 
Eres parte del equipo humano. No menciones que eres IA. 

CONTEXTO: A continuación verás una conversación que puede incluir mensajes recientes y anteriores. 
IMPORTANTE: Debes entender el HILO COMPLETO de la conversación, no solo responder al último mensaje.
Analiza todos los mensajes del usuario para dar una respuesta coherente.

Tu misión es resolver dudas sobre paneles solares, explicar beneficios, informar sobre servicios (domiciliarios, comerciales, industriales), 
promover cotizaciones gratuitas (web/WhatsApp) y generar confianza (compromiso, sustentabilidad, calidad, atención personalizada). 

Usa lenguaje sencillo y cálido. No inventes precios/productos. Si no sabes algo, invita a contactar a un asesor. 
Evita tecnicismos excesivos. Sé cordial y enfócate en lo que el cliente está preguntando.

Si hay imágenes, analízalas en el contexto de Solar Pro (producto, factura, instalación relevante?). Nunca digas que eres un bot.`;

    // Llamar a GPT-4o
    console.log(`[${chatId}][CRON] Enviando ${userMessageContent.length} partes a GPT-4o`);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", 
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessageContent }
      ],
    });
    
    const reply = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu consulta en este momento.';
    console.log(`[${chatId}][CRON] Respuesta generada: ${reply.substring(0, 50)}...`);
    
    // Enviar respuesta
    try {
      await bot.sendMessage(chatId, reply);
      console.log(`[${chatId}][CRON] Respuesta enviada correctamente`);
      
      // Actualizar estado de los mensajes procesados en la base de datos
      const { conversationsCollection } = await connectToDatabase();
      await conversationsCollection.updateMany(
        { _id: { $in: messagesToProcess.map(m => m._id) } },
        { $set: { status: "processed" } }
      );
      
      console.log(`[${chatId}][CRON] ${messagesToProcess.length} mensajes marcados como procesados`);
      return true;
    } catch (sendError: any) {
      console.error(`[${chatId}][CRON] ERROR ENVIANDO RESPUESTA:`, sendError.message);
      return false;
    }
  } catch (error: any) {
    console.error(`[${chatId}][CRON] Error general en processConversationFromCron:`, error.message);
    return false;
  }
} 