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
const CONVERSATION_WINDOW_MINUTES = 5 // Considerar mensajes de los últimos 5 minutos
const BATCH_TIME_WINDOW_MS = 2000 // Ventana de tiempo para considerar mensajes "en ráfaga" (2 segundos)
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
    
    console.log(`[${chatId}] Procesando ${pendingMessages.length} mensajes acumulados`)
    
    // Paso 3: Marcar mensajes como "processing"
    const messageIds = pendingMessages.map(m => m._id)
    await conversationsCollection.updateMany(
      { _id: { $in: messageIds } },
      { $set: { status: "processing" } }
    )
    
    // Paso 4: Procesar la conversación
    const result = await processConversation(chatId)
    
    if (result) {
      console.log(`[${chatId}] Procesamiento exitoso para ${pendingMessages.length} mensajes`)
    } else {
      console.log(`[${chatId}] El procesamiento no generó respuesta`)
      
      // Si no había suficiente contenido para procesar, reprogramar para
      // forzar el procesamiento después de un tiempo
      if (pendingMessages.length < 3) {
        console.log(`[${chatId}] Pocos mensajes acumulados (${pendingMessages.length}), intentando forzar procesamiento después`)
        
        // Necesitamos programar otra función serverless para procesar más tarde
        // Esto es solo para depuración - en producción necesitaríamos un mecanismo real
        try {
          // Llamada a nuestro propio endpoint para forzar el procesamiento
          const baseUrl = process.env.VERCEL_URL 
            ? `https://${process.env.VERCEL_URL}`
            : 'http://localhost:3000';
          
          // Programar una llamada en 5 segundos a nuestro propio endpoint
          setTimeout(async () => {
            try {
              console.log(`[${chatId}] Intentando forzar procesamiento después de espera`)
              await processMessagesForChat(chatId, newMessageId, true)
            } catch (err) {
              console.error(`[${chatId}] Error al forzar procesamiento:`, err)
            }
          }, 5000)
        } catch (fetchError) {
          console.error(`[${chatId}] Error al programar procesamiento forzado:`, fetchError)
        }
      }
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

      // Guardar mensaje en MongoDB con estado "pending"
      await conversationsCollection.insertOne({
        chatId: chatId,
        message: messageData,
        message_id: messageId,
        timestamp: new Date(),
        status: "pending" // Pendiente de procesamiento
      })
      console.log(`[${chatId}] Message saved to DB (ID: ${messageId}) - pending`)

      // Procesar mensajes (o postergar si son parte de una ráfaga)
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

    // Recuperar mensajes en estado "processing" para este chat
    const messages = await conversationsCollection.find({
      chatId: chatId,
      status: "processing" // Solo procesar los que están en este estado
    }).sort({ timestamp: 1 }).toArray()
    
    console.log(`[${chatId}] Retrieved ${messages.length} messages from DB:`, 
      messages.length > 0 ? JSON.stringify(messages.map(m => m.message.message_id)) : "none");

    if (messages.length === 0) {
      console.log(`[${chatId}] No messages found to process.`)
      return false
    }
    
    let userMessageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
    let hasProcessedMedia = false

    for (const msgDoc of messages) {
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
      // Marcar como procesados
      await conversationsCollection.updateMany(
        { chatId: chatId, _id: { $in: messages.map(m => m._id) } },
        { $set: { status: "processed" } }
      )
      console.log(`[${chatId}] Marked messages as processed.`)
      return false
    }

    try {
      console.log(`[${chatId}] Sending accumulated content to GPT-4o:`, userMessageContent.length, "parts")
      const completion = await openai.chat.completions.create({
        model: "gpt-4o", 
        messages: [
          { 
            role: "system", 
            content: "Actúas como un asesor de Solar Pro Argentina (https://solarproargentina.com/). Eres parte del equipo humano. No menciones que eres IA. Tu misión es resolver dudas sobre paneles solares, explicar beneficios, informar sobre servicios (domiciliarios, comerciales, industriales), promover cotizaciones gratuitas (web/WhatsApp) y generar confianza (compromiso, sustentabilidad, calidad, atención personalizada). Usa lenguaje sencillo y cálido. No inventes precios/productos. Si no sabes algo, invita a contactar a un asesor. Evita tecnicismos. Sé cordial. Analiza la secuencia completa de mensajes del usuario, incluyendo textos, audios transcritos e imágenes, para dar una respuesta coherente. Si hay imágenes, analízalas en el contexto de Solar Pro (producto, factura, instalación relevante?). Nunca digas que eres un bot."
          },
          { 
            role: "user", 
            content: userMessageContent // Array acumulado
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
        // Intentar enviar nuevamente con un mensaje de error en caso de fallar
        try {
          await bot.sendMessage(chatId, 'Lo siento, tuve un problema al enviar mi respuesta. Por favor, intenta nuevamente.')
        } catch (e) {
          console.error(`[${chatId}] ERROR FATAL AL ENVIAR MENSAJE DE ERROR:`, e)
        }
      }

      // Marcar mensajes como procesados
      await conversationsCollection.updateMany(
        { chatId: chatId, _id: { $in: messages.map(m => m._id) } },
        { $set: { status: "processed" } }
      )
      console.log(`[${chatId}] Marked ${messages.length} messages as processed.`)
      
      return true // Procesamiento exitoso

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
        { chatId: chatId, _id: { $in: messages.map(m => m._id) } },
        { $set: { status: "error" } }
      )
      console.log(`[${chatId}] Marked messages as error.`)
      
      return false // Procesamiento fallido
    }

  } catch (processError: any) {
    console.error(`[${chatId}] Error in processConversation function:`, processError.message)
    
    try {
      await bot.sendMessage(chatId, 'Lo siento, ocurrió un error interno grave al procesar tu conversación.')
      console.log(`[${chatId}] Critical error message sent to user.`)
    } catch (e) {
      console.error(`[${chatId}] CRITICAL: Failed to send critical error message:`, e)
    }
    
    return false // Procesamiento fallido
  }
} 