import type { NextApiRequest, NextApiResponse } from 'next'
import TelegramBot from 'node-telegram-bot-api'
import OpenAI from 'openai'
import fetch from 'node-fetch'
import FormData from 'form-data'

// --- Debounce Mechanism ---
// Almacenamiento en memoria (se reinicia con cada deploy/instancia lambda)
const debounceTimers = new Map<number, NodeJS.Timeout>()
const lastMessageData = new Map<number, any>() // Almacena el objeto message completo
const DEBOUNCE_DELAY_MS = 3000 // Esperar 3 segundos antes de procesar
// ------------------------

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

// --- Función principal de procesamiento (ahora llamada por el debounce) ---
async function processMessage(chatId: number, message: any) {
  console.log(`[${chatId}] Processing debounced message:`, JSON.stringify(message))
  try {
    let userMessageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [] // Array para contenido (texto y/o imagen)
    let messageType = 'unknown' // Para saber qué procesar

    // Determinar tipo de mensaje y preparar contenido inicial
    if (message.voice) {
      messageType = 'voice'
    } else if (message.photo) {
      messageType = 'photo'
      userMessageContent.push({ type: "text", text: "Analiza la siguiente imagen en el contexto de Solar Pro Argentina. Si es un producto, instalación, factura o documento relevante, descríbelo y extrae la información clave. Si no es relevante, simplemente descríbela brevemente." })
    } else if (message.text) {
      messageType = 'text'
    } else if (message.video) {
      messageType = 'video' // Aún no lo procesamos, solo acusamos recibo
    } else {
      messageType = 'other' // Otros tipos
    }
    
    // --- Procesamiento específico por tipo --- 
    let textForGpt = '' // Texto final para enviar a GPT (si aplica)
    let imageBase64 = '' // Base64 de la imagen (si aplica)

    switch (messageType) {
      case 'voice':
        // ... (lógica de transcripción como antes) ...
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
          textForGpt = whisperResult.text
          userMessageContent.push({ type: "text", text: textForGpt }) // Agregar texto transcrito
          console.log(`[${chatId}] Transcription successful:`, textForGpt)
        } catch (error: any) {
          console.error(`[${chatId}] Error during transcription:`, error.message)
          await bot.sendMessage(chatId, 'Lo siento, tuve problemas técnicos para entender el audio. ¿Podrías intentarlo de nuevo?')
          return
        }
        break

      case 'photo':
        try {
          // Usar la foto de mayor resolución
          const photo = message.photo[message.photo.length - 1]
          const fileId = photo.file_id
          const fileLink = await bot.getFileLink(fileId)
          console.log('Got photo link:', fileLink)
          const imageResponse = await fetch(fileLink)
          if (!imageResponse.ok) throw new Error('Failed to download photo')
          const imageBuffer = await imageResponse.buffer() // Obtener buffer directamente
          imageBase64 = imageBuffer.toString('base64')
          // Agregar la imagen al contenido para GPT
          userMessageContent.push({ 
            type: "image_url", 
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
          })
          console.log(`[${chatId}] Photo prepared for GPT Vision`)
        } catch (error: any) {
          console.error(`[${chatId}] Error processing photo:`, error.message)
          await bot.sendMessage(chatId, 'Lo siento, tuve problemas para procesar la imagen.')
          return
        }
        break
        
      case 'text':
        textForGpt = message.text
        // Manejo de comandos (solo si es texto puro)
        if (textForGpt.startsWith('/')) {
          if (textForGpt === '/start') {
            await bot.sendMessage(chatId, '¡Hola! Soy un asesor de Solar Pro Argentina. ¿En qué puedo ayudarte?') 
          } else {
            await bot.sendMessage(chatId, 'Comando no reconocido. Puedes escribir directamente tu pregunta, enviar un audio o una imagen.')
          }
          return
        }
        break

      case 'video':
        console.log(`[${chatId}] Received video message - Acknowledging`)
        await bot.sendMessage(chatId, 'He recibido tu video. Por ahora no puedo analizar videos, pero sí imágenes, audios o texto.')
        return
        
      case 'other':
      default:
        console.log(`[${chatId}] Ignoring other message type`)
        await bot.sendMessage(chatId, 'Gracias por tu mensaje. Solo puedo procesar consultas de texto, audio o imágenes.')
        return
    }

    // Si no hay contenido útil para enviar a GPT (ej. solo era un comando o error previo)
    if (userMessageContent.length === 0) {
      console.log(`[${chatId}] No content to send to GPT after processing.`)
      // Ya se respondió al usuario en los bloques anteriores (error, comando, ack)
      return
    }

    // ---- Lógica de GPT (ahora recibe texto y/o imagen) ----
    try {
      console.log(`[${chatId}] Sending content to GPT-4o:`, JSON.stringify(userMessageContent))
      const completion = await openai.chat.completions.create({
        // Model gpt-4o soporta visión
        model: "gpt-4o", 
        messages: [
          { 
            role: "system", 
            content: "Actúas como un asesor de Solar Pro Argentina (https://solarproargentina.com/). Eres parte del equipo humano. No menciones que eres IA. Tu misión es resolver dudas sobre paneles solares, explicar beneficios, informar sobre servicios (domiciliarios, comerciales, industriales), promover cotizaciones gratuitas (web/WhatsApp) y generar confianza (compromiso, sustentabilidad, calidad, atención personalizada). Usa lenguaje sencillo y cálido. No inventes precios/productos. Si no sabes algo, invita a contactar a un asesor. Evita tecnicismos. Sé cordial. Si recibes una imagen, analízala en el contexto de Solar Pro. Si es relevante (producto, factura, instalación), extráe info clave. Si no, descríbela brevemente. Nunca digas que eres un bot."
          },
          { 
            role: "user", 
            // Enviar el array de contenido (texto + imagen si existe)
            content: userMessageContent 
          } 
        ],
        // Opcional: max_tokens para controlar longitud de respuesta
        // max_tokens: 300 
      })
      
      const reply = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu consulta en este momento.'
      console.log(`[${chatId}] GPT Response:`, reply)

      // Simular tiempo de respuesta humano (15 segundos)
      await new Promise(resolve => setTimeout(resolve, 15000))
      
      await bot.sendMessage(chatId, reply)
      console.log(`[${chatId}] Response sent.`)

    } catch (error: any) {
      console.error(`[${chatId}] Error with OpenAI API call:`, error?.message)
      if (error?.response) {
        console.error('OpenAI API Response Status:', error.response.status)
        console.error('OpenAI API Response Data:', await error.response.text())
      }
      await bot.sendMessage(chatId, 'Lo siento, hubo un error al intentar generar una respuesta. Por favor, intenta de nuevo.')
    }
    // ---- Fin Lógica de GPT ----

  } catch (processError: any) {
    // Captura errores generales dentro de processMessage
    console.error(`[${chatId}] Error in processMessage function:`, processError.message)
    await bot.sendMessage(chatId, 'Lo siento, ocurrió un error interno al procesar tu mensaje.').catch(e => console.error("Failed to send process error message to user:", e))
  }
}
// ----------------------------------------------------------------------

// --- Handler principal (recibe webhook y aplica debounce) ---
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  // Verificar el método HTTP
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ message: `Method ${req.method} Not Allowed` })
  }

  try {
    const update = req.body
    console.log('Received update:', JSON.stringify(update, null, 2))

    if (update && update.message && update.message.chat && update.message.chat.id) {
      const chatId = update.message.chat.id
      const messageData = update.message // Guardamos el objeto message

      console.log(`[${chatId}] Received message, applying debounce...`)

      // Limpiar timer anterior para este chat (si existe)
      const existingTimer = debounceTimers.get(chatId)
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      // Guardar el último mensaje recibido para este chat
      lastMessageData.set(chatId, messageData)

      // Crear un nuevo timer
      const newTimer = setTimeout(() => {
        // Cuando el timer se completa, procesar el último mensaje guardado
        const messageToProcess = lastMessageData.get(chatId)
        if (messageToProcess) {
          // Ejecutar processMessage sin esperar (async)
          // No usamos await aquí para que el timeout callback termine rápido
          processMessage(chatId, messageToProcess)
          // Limpiar datos después de iniciar el procesamiento
          lastMessageData.delete(chatId)
          debounceTimers.delete(chatId)
        }
      }, DEBOUNCE_DELAY_MS)

      // Guardar el ID del nuevo timer
      debounceTimers.set(chatId, newTimer)

      // Responder inmediatamente a Telegram que recibimos el update
      // Es importante hacer esto ANTES de que processMessage termine (lo cual puede tardar >15s)
      res.status(200).json({ message: 'Update received, processing debounced' })

    } else {
      // Si el update no tiene la estructura esperada
      console.log('Received update without message or chat ID:', JSON.stringify(update))
      res.status(400).json({ message: 'Invalid update structure' })
    }

  } catch (error: any) {
    // Error general en el handler (antes del debounce)
    console.error('General error in handler:', error?.message)
    res.status(500).json({ message: 'General error processing update handler' })
  }
} 