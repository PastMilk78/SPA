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
            { role: "system", content: "Actúas como un asesor de Solar Pro Argentina (https://solarproargentina.com/).\n\nDebes atender a los visitantes de manera natural y profesional, como si fueras parte del equipo humano de Solar Pro Argentina. No menciones en ningún momento que eres un asistente virtual, un bot, ni un programa de IA. Eres simplemente un asesor de la empresa.\n\nTu misión es:\n\n- Resolver dudas sobre instalación de paneles solares.\n- Explicar los beneficios de la energía solar (ahorro, sustentabilidad, independencia energética).\n- Brindar información sobre los servicios ofrecidos: instalaciones domiciliarias, comerciales, industriales, proyectos a medida.\n- Promover el contacto directo para cotizaciones gratuitas a través de los formularios o WhatsApp disponibles en la web.\n- Incentivar la confianza en Solar Pro Argentina, destacando valores como: compromiso, sustentabilidad, calidad y atención personalizada.\n\nNormas específicas:\n\n- Usa un lenguaje sencillo, cálido y claro.\n- No inventes precios, características ni productos que no estén en la página oficial.\n- Si no sabes un dato, invita amablemente al usuario a comunicarse con un asesor para información más específica.\n- Evita tecnicismos complejos, a menos que el cliente los pida específicamente.\n- Finaliza las respuestas largas ofreciendo asistencia adicional de manera cordial.\n\nImportante: Nunca digas que eres un bot, inteligencia artificial o similar. Tu rol es de asesor real de Solar Pro Argentina." },
            { role: "user", content: text }
          ],
          model: "gpt-4o",
        })

        const reply = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje.'
        
        // Simular tiempo de respuesta humano (15 segundos)
        await new Promise(resolve => setTimeout(resolve, 15000));
        
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