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
const MESSAGE_WAIT_TIME_MS = 8000 // Tiempo de espera para acumular mensajes (8 segundos)
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
 * Verifica si hay mensajes pendientes para un chat y los procesa después de un tiempo de espera
 */
async function scheduleProcessing(chatId: number) {
  console.log(`[${chatId}] Programando procesamiento para dentro de ${MESSAGE_WAIT_TIME_MS/1000} segundos`)
  
  // Esperar el tiempo definido para acumular más mensajes potenciales
  setTimeout(async () => {
    try {
      const { conversationsCollection } = await connectToDatabase()
      
      // Verificar si hay mensajes sin procesar más recientes que MESSAGE_WAIT_TIME_MS
      // Si los hay, no procesamos para dar tiempo a que se acumulen más mensajes
      const now = new Date()
      const cutoffTime = new Date(now.getTime() - MESSAGE_WAIT_TIME_MS)
      
      const recentMessages = await conversationsCollection.find({
        chatId: chatId,
        timestamp: { $gt: cutoffTime },
        status: "pending"
      }).toArray()
      
      if (recentMessages.length > 0) {
        console.log(`[${chatId}] Detectados ${recentMessages.length} mensajes muy recientes, postergando procesamiento`)
        // Reprogramar para más tarde
        scheduleProcessing(chatId)
        return
      }
      
      // No hay mensajes recientes, verificar si hay alguno pendiente
      const pendingMessages = await conversationsCollection.find({
        chatId: chatId,
        status: "pending"
      }).toArray()
      
      if (pendingMessages.length === 0) {
        console.log(`[${chatId}] No hay mensajes pendientes para procesar`)
        return
      }
      
      console.log(`[${chatId}] Procesando ${pendingMessages.length} mensajes acumulados`)
      // Marcar mensajes como "processing" para evitar doble procesamiento
      await conversationsCollection.updateMany(
        { chatId: chatId, status: "pending" },
        { $set: { status: "processing" } }
      )
      
      // Procesar la conversación
      await processConversation(chatId)
      
    } catch (error: any) {
      console.error(`[${chatId}] Error en scheduleProcessing:`, error?.message)
    }
  }, MESSAGE_WAIT_TIME_MS)
}

// --- Handler principal ---
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

      // Conectar a DB (o reusar conexión)
      const { conversationsCollection } = await connectToDatabase()

      // Manejo especial para /start (respuesta rápida)
      if (messageData.text && messageData.text === '/start') {
        await conversationsCollection.insertOne({
          chatId: chatId,
          message: messageData,
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
        timestamp: new Date(),
        status: "pending" // Pendiente de procesamiento
      })
      console.log(`[${chatId}] Message saved to DB (ID: ${messageData.message_id}) - pending`)

      // Programar procesamiento después de un tiempo de espera
      scheduleProcessing(chatId)

      // Responder a Telegram inmediatamente para no bloquear
      res.status(200).json({ message: 'Update received and scheduled for processing' })

    } else {
      console.log('Received update without message or chat ID:', JSON.stringify(update))
      res.status(400).json({ message: 'Invalid update structure' })
    }

  } catch (error: any) {
    console.error('General error in handler:', error?.message)
    res.status(500).json({ message: 'General error processing update handler' })
  }
}

// Modificar processConversation para usar el status
async function processConversation(chatId: number) {
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
      return
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
          userMessageContent.push({ type: "text", text: `(Audio transcrito: ${textPart})` }) // Añadir contexto
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

    console.log(`[${chatId}] Constructed userMessageContent:`, JSON.stringify(userMessageContent));

    if (userMessageContent.length === 0) {
      console.log(`[${chatId}] No processable content found for GPT.`)
      // Marcar como procesados
      await conversationsCollection.updateMany(
        { chatId: chatId, _id: { $in: messages.map(m => m._id) } },
        { $set: { status: "processed" } }
      )
      console.log(`[${chatId}] Marked messages as processed.`)
      return
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
      console.log(`[${chatId}] GPT Response generated.`)
      
      await bot.sendMessage(chatId, reply)
      console.log(`[${chatId}] Response sent.`)

      // Marcar mensajes como procesados
      await conversationsCollection.updateMany(
        { chatId: chatId, _id: { $in: messages.map(m => m._id) } },
        { $set: { status: "processed" } }
      )
      console.log(`[${chatId}] Marked messages as processed.`)

    } catch (error: any) {
      console.error(`[${chatId}] Error with OpenAI API call:`, error?.message)
      await bot.sendMessage(chatId, 'Lo siento, hubo un error al intentar generar una respuesta. Por favor, intenta de nuevo.')
      
      // En caso de error, marcar mensajes como fallidos pero no eliminarlos
      await conversationsCollection.updateMany(
        { chatId: chatId, _id: { $in: messages.map(m => m._id) } },
        { $set: { status: "error" } }
      )
      console.log(`[${chatId}] Marked messages as error.`)
    }

  } catch (processError: any) {
    console.error(`[${chatId}] Error in processConversation function:`, processError.message)
    await bot.sendMessage(chatId, 'Lo siento, ocurrió un error interno grave al procesar tu conversación.').catch(e => console.error("Failed to send process error message to user:", e))
  }
} 