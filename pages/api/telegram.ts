import type { NextApiRequest, NextApiResponse } from 'next'
import TelegramBot from 'node-telegram-bot-api'
import OpenAI from 'openai'
import fetch from 'node-fetch'

// Inicializar OpenAI
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
      let text = ''

      // Procesar mensaje de voz
      if (update.message.voice) {
        const fileId = update.message.voice.file_id
        const fileLink = await bot.getFileLink(fileId)
        console.log('Got file link:', fileLink)

        const audioResponse = await fetch(fileLink)
        if (!audioResponse.ok || !audioResponse.body) {
          throw new Error(`Failed to download audio file: ${audioResponse.statusText}`)
        }
        
        console.log('Audio downloaded, sending to Whisper...')
        
        // Enviar a Whisper para transcribir directamente el stream
        try {
          const transcription = await openai.audio.transcriptions.create({
            // @ts-ignore - Forzar el tipo ya que la librería espera Uploadable pero fetch devuelve ReadableStream
            file: audioResponse.body,
            model: "whisper-1",
          })
          text = transcription.text
          console.log('Transcription:', text)
        } catch (transcriptionError) {
          console.error('Error during transcription:', transcriptionError)
          await bot.sendMessage(chatId, 'Lo siento, tuve problemas para entender el audio. ¿Podrías intentarlo de nuevo o escribir tu consulta?')
          return res.status(200).json({ message: 'Transcription error handled' })
        }
      
      } else if (update.message.text) {
        // Procesar mensaje de texto
        text = update.message.text
      } else if (update.message.photo) {
        // Procesar mensaje de imagen (reconocimiento básico)
        console.log('Received photo message');
        await bot.sendMessage(chatId, 'He recibido tu imagen. Por el momento no puedo analizar el contenido, pero si tienes alguna consulta, puedes escribirme o enviar un audio.');
        return res.status(200).json({ message: 'Photo message acknowledged' });
      } else if (update.message.video) {
        // Procesar mensaje de video (reconocimiento básico)
        console.log('Received video message');
        await bot.sendMessage(chatId, 'He recibido tu video. Por el momento no puedo analizar el contenido, pero si tienes alguna consulta, puedes escribirme o enviar un audio.');
        return res.status(200).json({ message: 'Video message acknowledged' });
      } else {
        // Ignorar otros tipos de mensajes
        console.log('Ignoring other message type');
        await bot.sendMessage(chatId, 'Gracias por tu mensaje. Por ahora, solo puedo procesar consultas de texto o audio.');
        return res.status(200).json({ message: 'Ignored other message type' });
      }

      // Si no tenemos texto (después de intentar procesar texto o voz), no continuamos
      if (!text) {
        console.log('No text to process after handling message/voice.')
        return res.status(400).json({ message: 'No processable text found' })
      }

      // Si el texto es un comando, procesarlo diferente
      if (text.startsWith('/')) {
        if (text === '/start') {
          await bot.sendMessage(chatId, '¡Hola! Soy un asesor de Solar Pro Argentina. ¿En qué puedo ayudarte?')
        } else {
          await bot.sendMessage(chatId, 'Comando no reconocido. Puedes escribir directamente tu pregunta o enviar un audio.')
        }
        return res.status(200).json({ message: 'OK' })
      }

      // ---- Lógica de GPT ----
      try {
        // Obtener respuesta de GPT con el texto (transcrito o directo)
        const completion = await openai.chat.completions.create({
          messages: [
            { role: "system", content: "Actúas como un asesor de Solar Pro Argentina (https://solarproargentina.com/).\n\nDebes atender a los visitantes de manera natural y profesional, como si fueras parte del equipo humano de Solar Pro Argentina. No menciones en ningún momento que eres un asistente virtual, un bot, ni un programa de IA. Eres simplemente un asesor de la empresa.\n\nTu misión es:\n\n- Resolver dudas sobre instalación de paneles solares.\n- Explicar los beneficios de la energía solar (ahorro, sustentabilidad, independencia energética).\n- Brindar información sobre los servicios ofrecidos: instalaciones domiciliarias, comerciales, industriales, proyectos a medida.\n- Promover el contacto directo para cotizaciones gratuitas a través de los formularios o WhatsApp disponibles en la web.\n- Incentivar la confianza en Solar Pro Argentina, destacando valores como: compromiso, sustentabilidad, calidad y atención personalizada.\n\nNormas específicas:\n\n- Usa un lenguaje sencillo, cálido y claro.\n- No inventes precios, características ni productos que no estén en la página oficial.\n- Si no sabes un dato, invita amablemente al usuario a comunicarse con un asesor para información más específica.\n- Evita tecnicismos complejos, a menos que el cliente los pida específicamente.\n- Finaliza las respuestas largas ofreciendo asistencia adicional de manera cordial.\n\nImportante: Nunca digas que eres un bot, inteligencia artificial o similar. Tu rol es de asesor real de Solar Pro Argentina." },
            { role: "user", content: text }
          ],
          model: "gpt-4o",
        })

        const reply = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje.'
        
        // Simular tiempo de respuesta humano (15 segundos)
        await new Promise(resolve => setTimeout(resolve, 15000))
        
        await bot.sendMessage(chatId, reply)
      } catch (error) {
        console.error('Error with OpenAI:', error)
        await bot.sendMessage(chatId, 'Lo siento, hubo un error al procesar tu mensaje con GPT. Por favor, intenta de nuevo.')
      }
      // ---- Fin Lógica de GPT ----

      return res.status(200).json({ message: 'OK' })
    }

    // Si no hay update.message
    console.log('No message found in update object')
    return res.status(400).json({ message: 'No message found in update' })
  } catch (error) {
    console.error('Error processing update:', error)
    return res.status(500).json({ message: 'Error processing update' })
  }
} 