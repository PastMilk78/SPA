import type { NextApiRequest, NextApiResponse } from 'next'
import TelegramBot from 'node-telegram-bot-api'
import OpenAI from 'openai'
import fetch from 'node-fetch'
import FormData from 'form-data'

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

    if (update && update.message) {
      const chatId = update.message.chat.id
      let userMessageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [] // Array para contenido (texto y/o imagen)
      let messageType = 'unknown' // Para saber qué procesar

      // Determinar tipo de mensaje y preparar contenido inicial
      if (update.message.voice) {
        messageType = 'voice'
      } else if (update.message.photo) {
        messageType = 'photo'
        userMessageContent.push({ type: "text", text: "Analiza la siguiente imagen en el contexto de Solar Pro Argentina. Si es un producto, instalación, factura o documento relevante, descríbelo y extrae la información clave. Si no es relevante, simplemente descríbela brevemente." })
      } else if (update.message.text) {
        messageType = 'text'
        userMessageContent.push({ type: "text", text: update.message.text })
      } else if (update.message.video) {
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
            const fileId = update.message.voice.file_id
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
            console.log('Transcription successful:', textForGpt)
          } catch (error: any) {
            console.error('Error during transcription:', error.message)
            await bot.sendMessage(chatId, 'Lo siento, tuve problemas técnicos para entender el audio. ¿Podrías intentarlo de nuevo?')
            return res.status(200).json({ message: 'Transcription error handled' })
          }
          break

        case 'photo':
          try {
            // Usar la foto de mayor resolución
            const photo = update.message.photo[update.message.photo.length - 1]
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
            console.log('Photo prepared for GPT Vision')
          } catch (error: any) {
            console.error('Error processing photo:', error.message)
            await bot.sendMessage(chatId, 'Lo siento, tuve problemas para procesar la imagen.')
            return res.status(200).json({ message: 'Photo processing error handled' })
          }
          break
          
        case 'text':
          textForGpt = update.message.text
          // Manejo de comandos (solo si es texto puro)
          if (textForGpt.startsWith('/')) {
            if (textForGpt === '/start') {
              await bot.sendMessage(chatId, '¡Hola! Soy un asesor de Solar Pro Argentina. ¿En qué puedo ayudarte?') 
            } else {
              await bot.sendMessage(chatId, 'Comando no reconocido. Puedes escribir directamente tu pregunta, enviar un audio o una imagen.')
            }
            return res.status(200).json({ message: 'Command handled' })
          }
          break

        case 'video':
          console.log('Received video message - Acknowledging')
          await bot.sendMessage(chatId, 'He recibido tu video. Por ahora no puedo analizar videos, pero sí imágenes, audios o texto.')
          return res.status(200).json({ message: 'Video message acknowledged' })
          
        case 'other':
        default:
          console.log('Ignoring other message type')
          await bot.sendMessage(chatId, 'Gracias por tu mensaje. Solo puedo procesar consultas de texto, audio o imágenes.')
          return res.status(200).json({ message: 'Ignored other message type' })
      }

      // Si no hay contenido útil para enviar a GPT (ej. solo era un comando o error previo)
      if (userMessageContent.length === 0) {
        console.log('No content to send to GPT.')
        // Ya se respondió al usuario en los bloques anteriores (error, comando, ack)
        return res.status(200).json({ message: 'Processing ended before GPT call' })
      }

      // ---- Lógica de GPT (ahora recibe texto y/o imagen) ----
      try {
        console.log('Sending content to GPT-4o:', JSON.stringify(userMessageContent))
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
        console.log('GPT Response:', reply)

        // Simular tiempo de respuesta humano (15 segundos)
        await new Promise(resolve => setTimeout(resolve, 15000))
        
        await bot.sendMessage(chatId, reply)

      } catch (error: any) {
        console.error('Error with OpenAI API call:', error?.message)
        if (error?.response) {
          console.error('OpenAI API Response Status:', error.response.status)
          console.error('OpenAI API Response Data:', await error.response.text())
        }
        await bot.sendMessage(chatId, 'Lo siento, hubo un error al intentar generar una respuesta. Por favor, intenta de nuevo.')
      }
      // ---- Fin Lógica de GPT ----

      return res.status(200).json({ message: 'OK' })
    }

    // Si no hay update.message
    console.log('No message found in update object')
    return res.status(400).json({ message: 'No message found in update' })
  } catch (error: any) {
    console.error('General error processing update:', error?.message)
    // Enviar mensaje genérico al usuario si falla algo inesperado
    if (req.body?.message?.chat?.id) {
      await bot.sendMessage(req.body.message.chat.id, 'Lo siento, ocurrió un error inesperado al procesar tu mensaje.').catch(e => console.error("Failed to send error message to user:", e))
    }
    return res.status(500).json({ message: 'General error processing update' })
  }
} 