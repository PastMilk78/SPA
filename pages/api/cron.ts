import type { NextApiRequest, NextApiResponse } from 'next'
import { MongoClient, Db, Collection } from 'mongodb'
import TelegramBot from 'node-telegram-bot-api'

// --- MongoDB Connection --- 
const MONGODB_URI = process.env.MONGODB_URI
const DB_NAME = 'telegramBot'
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
    return { client, db, conversationsCollection }
  } catch (error) {
    console.error('Failed to connect to MongoDB', error)
    throw error
  }
}

// Inicializar el bot con el token
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not defined')
}

// Crear una instancia del bot con el token
const bot = new TelegramBot(token, { polling: false })

/**
 * Endpoint para procesar mensajes pendientes mediante cron job
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Validar que sea una solicitud autorizada
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Iniciando verificación de mensajes pendientes...');
    const { conversationsCollection } = await connectToDatabase();
    
    // Encontrar chats con mensajes esperando y cuyo tiempo ya ha pasado
    const now = new Date();
    const readyChats = await conversationsCollection.distinct('chatId', {
      waitingForDelay: true,
      waitUntil: { $lte: now }
    });
    
    console.log(`Encontrados ${readyChats.length} chats con mensajes listos para procesar`);
    
    // Procesar cada chat
    for (const chatId of readyChats) {
      try {
        console.log(`Procesando mensajes para chatId: ${chatId}`);
        
        // Marcar todos los mensajes pendientes para este chat como "processing"
        const result = await conversationsCollection.updateMany(
          { 
            chatId: chatId, 
            waitingForDelay: true,
            waitUntil: { $lte: now }
          },
          { $set: { status: "processing", waitingForDelay: false, waitUntil: null } }
        );
        
        console.log(`Marcados ${result.modifiedCount} mensajes como "processing"`);
        
        // Obtener todos los mensajes a procesar
        const messagesToProcess = await conversationsCollection.find({
          chatId: chatId,
          status: "processing"
        }).sort({ timestamp: 1 }).toArray();
        
        if (messagesToProcess.length === 0) {
          console.log(`No se encontraron mensajes para procesar para el chat ${chatId}`);
          continue;
        }

        console.log(`Procesando ${messagesToProcess.length} mensajes para el chat ${chatId}`);
        
        // Obtener mensajes históricos para contexto
        const cutoffDate = new Date(now.getTime() - 30 * 60 * 1000); // 30 minutos
        const historyMessages = await conversationsCollection.find({
          chatId: chatId,
          status: "processed",
          timestamp: { $gte: cutoffDate }
        }).sort({ timestamp: -1 })
        .limit(15)
        .toArray();
        
        // Ordenar todos los mensajes cronológicamente
        const allMessages = [...historyMessages.reverse(), ...messagesToProcess].sort((a, b) => {
          return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        });
        
        console.log(`Preparando contenido con ${messagesToProcess.length} mensajes nuevos y ${historyMessages.length} históricos`);
        
        // Importar y usar las funciones desde telegram.ts
        const telegramModule = await import('./telegram');
        await telegramModule.processConversationFromCron(chatId, messagesToProcess, historyMessages);
      } catch (chatError) {
        console.error(`Error procesando chat ${chatId}:`, chatError);
      }
    }
    
    res.status(200).json({ success: true, processedChats: readyChats.length });
  } catch (error) {
    console.error('Error en el cron job:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
} 