import type { NextApiRequest, NextApiResponse } from 'next'
import TelegramBot from 'node-telegram-bot-api'

// Inicializar el bot con el token (lo obtendremos de las variables de entorno)
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not defined')
}

const bot = new TelegramBot(token)

type ResponseData = {
  message: string
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ message: `Method ${req.method} Not Allowed` })
  }

  try {
    const { message } = req.body
    
    if (!message) {
      return res.status(400).json({ message: 'No message in request body' })
    }

    // Extraer información del mensaje
    const chatId = message.chat.id
    const text = message.text || ''

    // Procesar el mensaje y enviar respuesta
    await bot.sendMessage(chatId, `Recibí tu mensaje: ${text}`)

    return res.status(200).json({ message: 'Success' })
  } catch (error) {
    console.error('Error processing update:', error)
    return res.status(500).json({ message: 'Error processing update' })
  }
} 