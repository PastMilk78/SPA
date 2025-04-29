import type { NextApiRequest, NextApiResponse } from 'next'
import TelegramBot from 'node-telegram-bot-api'
import OpenAI from 'openai'

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
    console.log('Received update:', update)

    if (update && update.message) {
      const chatId = update.message.chat.id
      const text = update.message.text || ''

      // Si el mensaje es un comando, procesarlo diferente
      if (text.startsWith('/')) {
        if (text === '/start') {
          await bot.sendMessage(chatId, '¡Hola! Soy un bot asistente potenciado por GPT. ¿En qué puedo ayudarte?')
        } else {
          await bot.sendMessage(chatId, 'Comando no reconocido. Puedes escribir directamente tu pregunta.')
        }
        return res.status(200).json({ message: 'OK' })
      }

      try {
        // Obtener respuesta de GPT
        const completion = await openai.chat.completions.create({
          messages: [
            { role: "system", content: "Eres un asistente amable y profesional que ayuda a los usuarios con sus consultas. Tus respuestas son concisas y útiles." },
            { role: "user", content: text }
          ],
          model: "gpt-3.5-turbo",
        })

        const reply = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje.'
        await bot.sendMessage(chatId, reply)
      } catch (error) {
        console.error('Error with OpenAI:', error)
        await bot.sendMessage(chatId, 'Lo siento, hubo un error al procesar tu mensaje con GPT. Por favor, intenta de nuevo.')
      }

      return res.status(200).json({ message: 'OK' })
    }

    return res.status(400).json({ message: 'No valid message found in update' })
  } catch (error) {
    console.error('Error processing update:', error)
    return res.status(500).json({ message: 'Error processing update' })
  }
} 