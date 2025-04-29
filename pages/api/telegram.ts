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

// --- Debounce/Accumulation Mechanism --- 
const processingTimers = new Map<number, NodeJS.Timeout>()
const PROCESSING_DELAY_MS = 5000 // Esperar 5 segundos de inactividad para procesar
const CONVERSATION_WINDOW_MINUTES = 5 // Considerar mensajes de los últimos 5 minutos
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

// --- Función principal de procesamiento (llamada por el timer) ---
async function processConversation(chatId: number) {
  console.log(`[${chatId}] Timer expired. Processing conversation...`)
  try {
    const { conversationsCollection } = await connectToDatabase()

    // 1. Recuperar mensajes recientes para este chat
    const cutoffDate = new Date(Date.now() - CONVERSATION_WINDOW_MINUTES * 60 * 1000)
    const messages = await conversationsCollection.find({
      chatId: chatId,
      timestamp: { $gte: cutoffDate }
    }).sort({ timestamp: 1 }).toArray()

    if (messages.length === 0) {
      console.log(`[${chatId}] No recent messages found to process.`)
      return
    }
    
    console.log(`[${chatId}] Found ${messages.length} messages to process.`)

    // 2. Construir el contenido para GPT-4o
    let userMessageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
    let hasProcessedMedia = false // Flag para saber si se procesó audio/imagen

    for (const msgDoc of messages) {
      const message = msgDoc.message // El objeto message original de Telegram
      let textPart = ''
      let imageBase64 = ''

      if (message.text) {
        // Ignorar comandos aquí, deberían manejarse antes si es necesario
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
          // Podríamos añadir un marcador de error al contenido?
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
      // Ignorar video y otros tipos al construir el contenido para GPT
    }

    // Si solo hubo mensajes ignorados o errores, no llamar a GPT
    if (userMessageContent.length === 0) {
      console.log(`[${chatId}] No processable content found for GPT.`)
       // Limpiar mensajes procesados (o que causaron error)
       await conversationsCollection.deleteMany({ chatId: chatId, _id: { $in: messages.map(m => m._id) } })
       console.log(`[${chatId}] Cleaned processed/errored messages from DB.`)
      return
    }

    // 3. Llamar a GPT-4o con el contenido acumulado
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
        // max_tokens: 500 // Aumentar un poco si es necesario para respuestas combinadas
      })
      
      const reply = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu consulta en este momento.'
      console.log(`[${chatId}] GPT Response generated.`)

      // 4. Enviar respuesta (con delay opcional)
      // await new Promise(resolve => setTimeout(resolve, 15000)) // Delay opcional
      
      await bot.sendMessage(chatId, reply)
      console.log(`[${chatId}] Response sent.`)

      // 5. Limpiar mensajes procesados de la DB
      await conversationsCollection.deleteMany({ chatId: chatId, _id: { $in: messages.map(m => m._id) } })
      console.log(`[${chatId}] Cleaned processed messages from DB.`)

    } catch (error: any) {
      console.error(`[${chatId}] Error with OpenAI API call:`, error?.message)
      // Manejo de errores de API...
      await bot.sendMessage(chatId, 'Lo siento, hubo un error al intentar generar una respuesta. Por favor, intenta de nuevo.')
      // Podríamos decidir si limpiar o no los mensajes de la DB en caso de error de GPT
    }

  } catch (processError: any) {
    console.error(`[${chatId}] Error in processConversation function:`, processError.message)
    await bot.sendMessage(chatId, 'Lo siento, ocurrió un error interno grave al procesar tu conversación.').catch(e => console.error("Failed to send process error message to user:", e))
    // Considerar limpiar mensajes aquí también si el error es irrecuperable
  }
}
// ----------------------------------------------------------------------

// --- Handler principal (recibe webhook, guarda en DB, gestiona timer) ---
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

      // Guardar mensaje en MongoDB
      await conversationsCollection.insertOne({
        chatId: chatId,
        message: messageData,
        timestamp: new Date()
      })
      console.log(`[${chatId}] Message saved to DB (ID: ${messageData.message_id})`)

      // Manejar comandos /start inmediatamente (opcional, o dejar que se procesen con el resto)
      if (messageData.text && messageData.text === '/start') {
        await bot.sendMessage(chatId, '¡Hola! Soy un asesor de Solar Pro Argentina. ¿En qué puedo ayudarte?') 
        // Limpiar timer si existía, ya que respondimos
        const existingTimer = processingTimers.get(chatId)
        if (existingTimer) clearTimeout(existingTimer)
        processingTimers.delete(chatId)
        // Podríamos limpiar los mensajes de la DB también, o dejar que se limpien luego
        return res.status(200).json({ message: '/start command handled' })
      }
      
      // Gestionar timer para procesar conversación
      const existingTimer = processingTimers.get(chatId)
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      const newTimer = setTimeout(() => {
        processConversation(chatId)
        processingTimers.delete(chatId) // Limpiar referencia al timer completado
      }, PROCESSING_DELAY_MS)

      processingTimers.set(chatId, newTimer)

      // Responder a Telegram inmediatamente
      res.status(200).json({ message: 'Update received and saved' })

    } else {
      console.log('Received update without message or chat ID:', JSON.stringify(update))
      res.status(400).json({ message: 'Invalid update structure' })
    }

  } catch (error: any) {
    console.error('General error in handler:', error?.message)
    res.status(500).json({ message: 'General error processing update handler' })
  }
} 